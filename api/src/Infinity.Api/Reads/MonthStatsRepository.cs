using System.Data;
using System.Globalization;
using Infinity.Api.Data;

namespace Infinity.Api.Reads;

public sealed record LeaderRow(string Code, string? Name, decimal Amount, int Count);

public sealed record MonthStats(
    /// <summary>First day of the month, ISO. The period these figures cover.</summary>
    string Month,
    /// <summary>Last day INCLUDED — today for the current month, month end otherwise.</summary>
    string Through,
    int Bills,
    int Patients,
    int Registrations,
    /// <summary>
    /// Billed through Telo and Infinity only — see the note on
    /// <see cref="LabSalesMonth"/>. This is NOT the lab's turnover.
    /// </summary>
    decimal Revenue,
    /// <summary>What the whole lab sold on the selected day, LIS included.</summary>
    decimal LabSalesDay,
    /// <summary>What the whole lab sold month to date, LIS included.</summary>
    /// <remarks>
    /// The number that matters, and the reason it is here.
    ///
    /// <c>tbl_billing_patient_detail</c> — the source of <see cref="Revenue"/> —
    /// holds ONLY orders raised in Telo or Infinity. Checked against a live
    /// month: 454 bills from telo, 2 from inf, none from anything else, against
    /// 21,977 registrations. Everything the lab bills through LISTEC itself is
    /// invisible to it.
    ///
    /// So a dashboard showing <see cref="Revenue"/> under the word "revenue"
    /// reports about 7% of the lab's turnover — ₹0.4M against ₹6.0M on the
    /// month measured. An administrator comparing this screen with the LIS home
    /// screen would conclude the business had collapsed. This figure is the
    /// same one the LIS shows, so the two screens reconcile.
    ///
    /// Keyed on the patient's REGISTRATION date, where the LIS keys on the test
    /// row's last-edit stamp. That difference is worth about 4% — on the month
    /// measured, ₹234,625 of the LIS's ₹5,972,411 was older work merely edited
    /// inside the window. Counting revenue on the day somebody corrected a
    /// typo is not a behaviour worth reproducing, so this reads slightly below
    /// the LIS tile by design, and the dashboard says so.
    /// </remarks>
    decimal LabSalesMonth,
    decimal Collected,
    decimal Refunded,
    decimal Outstanding,
    decimal Discount,
    /// <summary>Centres that actually billed something this month.</summary>
    int ActiveClients,
    /// <summary>Distinct referring doctors named on this month's bills.</summary>
    int ReferringDoctors,
    IReadOnlyList<LeaderRow> TopClients,
    IReadOnlyList<LeaderRow> TopTests,
    IReadOnlyList<LeaderRow> TopPayers);

/// <summary>
/// Month-to-date totals and the three leaderboards, modelled on the LIS home
/// screen an admin has been reading for years.
/// </summary>
/// <remarks>
/// ── WHAT WAS TAKEN, AND WHAT WAS DELIBERATELY NOT ──────────────────────────
/// The LIS pairs every counter as today / this month, and puts top clients,
/// top tests and client receipts underneath. That shape is worth keeping: it
/// answers "how is today going" and "how is the month going" in one glance.
///
/// The arithmetic behind it is not worth keeping, and copying it would import
/// four defects into a screen people make decisions from:
///
///   * Samples and Sales key on modifieddate / updateddate. An old record
///     edited today counts as today's work. Here everything keys on the bill
///     date, the receipt date, or the registration date — whichever is the
///     event actually being counted.
///   * ClientReceipts groups by { client, amount }, so two receipts for
///     different amounts from the same client become two rows and the "top"
///     ordering is meaningless. Grouped by client alone here.
///   * TopTests runs a correlated FirstOrDefault per test row — an N+1 that
///     also picks an arbitrary sample per patient. This joins the bill's own
///     test lines instead, which is both correct and one pass.
///   * Every counter is clamped with `if (retcount > 0)`, so a net-negative
///     day (more refunded than taken) displays as zero. Not clamped here; a
///     negative number is information.
///
/// The LIS's Customers tile is not reproduced at all: its implementation is
/// entirely commented out and returns a hard-coded "0", which is why the live
/// dashboard shows "0 / 0". It has been decorative for years.
///
/// SEPARATE from DayStats on purpose. This aggregates a month of bills and
/// their test lines on a database the live LIS is also serving, so it gets its
/// own endpoint and the day KPIs never wait behind it.
/// </remarks>
public sealed class MonthStatsRepository(NobleConnectionFactory db, SqlRetry retry)
{
    /// <summary>How many rows each leaderboard returns.</summary>
    private const int TopN = 10;

    /// <param name="dateIso">
    /// The selected DAY. The month reported is the one containing it, so the
    /// two halves of the dashboard can never describe different periods.
    /// </param>
    public async Task<MonthStats> GetAsync(
        IReadOnlyList<int> scope, string? dateIso = null, CancellationToken ct = default)
    {
        var (first, through, day) = NormaliseMonth(dateIso);

        // Fail closed, exactly as the day stats do: no centres means no data,
        // never all data.
        if (scope.Count == 0) return Empty(first, through);

        return await retry.ExecuteAsync("stats.month", token =>
            db.QueryAsync("stats.month", async (conn, inner) =>
            {
                await using var cmd = NobleConnectionFactory.CreateCommand(conn, "");
                cmd.CommandTimeout = 60;
                cmd.Parameters.Add("@from", SqlDbType.Date).Value = first;
                cmd.Parameters.Add("@to", SqlDbType.Date).Value = through;
                cmd.Parameters.Add("@day", SqlDbType.Date).Value = day;
                cmd.Parameters.Add("@top", SqlDbType.Int).Value = TopN;

                var bills = ScopeFilter.For(cmd, "b.mcc_code", scope, "b");
                var pats = ScopeFilter.For(cmd, "p.mcc_code", scope, "p");
                var sales = ScopeFilter.For(cmd, "sp.mcc_code", scope, "sl");
                var rcpt = ScopeFilter.For(cmd, "rb.mcc_code", scope, "r");
                var lines = ScopeFilter.For(cmd, "lb.mcc_code", scope, "l");
                var payer = ScopeFilter.For(cmd, "pb.mcc_code", scope, "y");

                cmd.CommandText = $"""
                    -- ---- headline, month to date -------------------------------
                    SELECT
                      (SELECT COUNT(*)                         FROM dbo.tbl_billing_patient_detail b
                         WHERE CAST(b.bill_date AS DATE) BETWEEN @from AND @to AND {bills.Predicate})  AS bills,
                      (SELECT COUNT(DISTINCT b.patientname)    FROM dbo.tbl_billing_patient_detail b
                         WHERE CAST(b.bill_date AS DATE) BETWEEN @from AND @to AND {bills.Predicate})  AS patients,
                      (SELECT ISNULL(SUM(b.amount),0)          FROM dbo.tbl_billing_patient_detail b
                         WHERE CAST(b.bill_date AS DATE) BETWEEN @from AND @to AND {bills.Predicate})  AS revenue,
                      (SELECT ISNULL(SUM(b.Balance),0)         FROM dbo.tbl_billing_patient_detail b
                         WHERE CAST(b.bill_date AS DATE) BETWEEN @from AND @to AND {bills.Predicate})  AS outstanding,
                      (SELECT ISNULL(SUM(b.discount_amount),0) FROM dbo.tbl_billing_patient_detail b
                         WHERE CAST(b.bill_date AS DATE) BETWEEN @from AND @to AND {bills.Predicate})  AS discount,
                      -- Centres that actually traded, not centres on the roster.
                      -- The LIS counts the whole master list, which never moves
                      -- and so tells an admin nothing about the month.
                      (SELECT COUNT(DISTINCT b.mcc_code)       FROM dbo.tbl_billing_patient_detail b
                         WHERE CAST(b.bill_date AS DATE) BETWEEN @from AND @to AND {bills.Predicate})  AS active_clients,
                      (SELECT COUNT(DISTINCT b.ref_doctor)     FROM dbo.tbl_billing_patient_detail b
                         WHERE CAST(b.bill_date AS DATE) BETWEEN @from AND @to AND b.ref_doctor > 0
                           AND {bills.Predicate})                                                     AS ref_doctors,
                      (SELECT COUNT(*)                         FROM dbo.tbl_med_mcc_patient_master p
                         WHERE CAST(p.sample_date AS DATE) BETWEEN @from AND @to AND {pats.Predicate}) AS registrations;

                    -- ---- money actually received, keyed on the RECEIPT date ----
                    -- So a payment taken this month against an older bill counts
                    -- this month, which is what "collected" has to mean.
                    SELECT
                      ISNULL(SUM(CASE WHEN r.receive_status = '1' THEN r.amount END),0) AS collected,
                      ISNULL(SUM(CASE WHEN r.receive_status = '2' THEN r.amount END),0) AS refunded
                    FROM dbo.tbl_billing_patient_amount_receipt r
                    JOIN dbo.tbl_billing_patient_detail rb ON rb.id = r.bill_id
                    WHERE CAST(r.recd_date AS DATE) BETWEEN @from AND @to
                      AND {rcpt.Predicate}
                      AND NOT EXISTS (SELECT 1 FROM dbo.telo_receipt_void v WHERE v.receipt_id = r.id);

                    -- ---- what the WHOLE LAB sold, LIS included ------------------
                    -- The turnover figure. tbl_billing_patient_detail above holds
                    -- only Telo/Infinity orders and is a few percent of this; see
                    -- the note on LabSalesMonth.
                    --
                    -- Keyed on the patient's registration date, not the test row's
                    -- last-edit stamp the LIS uses, so a corrected typo does not
                    -- book revenue on the day of the correction.
                    SELECT
                      ISNULL(SUM(CASE WHEN CAST(sp.sample_date AS DATE) = @day
                                      THEN t.test_rate END),0) AS sales_day,
                      ISNULL(SUM(t.test_rate),0)               AS sales_month
                    FROM dbo.tbl_med_mcc_patient_tests t
                    JOIN dbo.tbl_med_mcc_patient_master sp ON sp.id = t.patient_id
                    WHERE CAST(sp.sample_date AS DATE) BETWEEN @from AND @to
                      AND t.amount_checked = 1
                      AND {sales.Predicate};

                    -- ---- top clients by what they were BILLED -------------------
                    SELECT TOP (@top)
                           u.MCCUnitCode AS code,
                           u.MCCUnitName AS name,
                           ISNULL(SUM(b.amount),0) AS amount,
                           COUNT(*) AS cnt
                    FROM dbo.tbl_billing_patient_detail b
                    JOIN dbo.tbl_med_mcc_unit_master u ON u.id = b.mcc_code
                    WHERE CAST(b.bill_date AS DATE) BETWEEN @from AND @to AND {bills.Predicate}
                    GROUP BY u.MCCUnitCode, u.MCCUnitName
                    ORDER BY SUM(b.amount) DESC, u.MCCUnitCode;

                    -- ---- top tests by volume ------------------------------------
                    -- Cancelled lines excluded: they were ordered, not performed,
                    -- and a cancelled test topping the volume board would be a lie
                    -- about what the lab actually ran.
                    SELECT TOP (@top)
                           MAX(d.testcode) AS code,
                           d.testname AS name,
                           ISNULL(SUM(d.testamount),0) AS amount,
                           COUNT(*) AS cnt
                    FROM dbo.tbl_billing_patient_test_detail d
                    JOIN dbo.tbl_billing_patient_detail lb ON lb.id = d.billid
                    LEFT JOIN dbo.telo_test_cancellation tc ON tc.line_id = d.id
                    WHERE CAST(lb.bill_date AS DATE) BETWEEN @from AND @to
                      AND tc.line_id IS NULL
                      AND {lines.Predicate}
                    GROUP BY d.testname
                    ORDER BY COUNT(*) DESC, d.testname;

                    -- ---- top clients by what they actually PAID -----------------
                    -- A different question from the board above, and the pair is
                    -- the useful bit: billed a lot and paid nothing is exactly
                    -- what an admin is scanning for.
                    SELECT TOP (@top)
                           u.MCCUnitCode AS code,
                           u.MCCUnitName AS name,
                           ISNULL(SUM(CASE WHEN r.receive_status = '2' THEN -r.amount ELSE r.amount END),0) AS amount,
                           COUNT(*) AS cnt
                    FROM dbo.tbl_billing_patient_amount_receipt r
                    JOIN dbo.tbl_billing_patient_detail pb ON pb.id = r.bill_id
                    JOIN dbo.tbl_med_mcc_unit_master u ON u.id = pb.mcc_code
                    WHERE CAST(r.recd_date AS DATE) BETWEEN @from AND @to
                      AND {payer.Predicate}
                      AND NOT EXISTS (SELECT 1 FROM dbo.telo_receipt_void v WHERE v.receipt_id = r.id)
                    GROUP BY u.MCCUnitCode, u.MCCUnitName
                    ORDER BY SUM(CASE WHEN r.receive_status = '2' THEN -r.amount ELSE r.amount END) DESC,
                             u.MCCUnitCode;
                    """;

                await using var r = await cmd.ExecuteReaderAsync(inner).ConfigureAwait(false);

                int billCount = 0, patients = 0, registrations = 0, activeClients = 0, refDoctors = 0;
                decimal revenue = 0, outstanding = 0, discount = 0;
                if (await r.ReadAsync(inner).ConfigureAwait(false))
                {
                    billCount = r.Int("bills");
                    patients = r.Int("patients");
                    revenue = r.Dec("revenue");
                    outstanding = r.Dec("outstanding");
                    discount = r.Dec("discount");
                    activeClients = r.Int("active_clients");
                    refDoctors = r.Int("ref_doctors");
                    registrations = r.Int("registrations");
                }

                decimal collected = 0, refunded = 0;
                await r.NextResultAsync(inner).ConfigureAwait(false);
                if (await r.ReadAsync(inner).ConfigureAwait(false))
                {
                    collected = r.Dec("collected");
                    refunded = r.Dec("refunded");
                }

                decimal salesDay = 0, salesMonth = 0;
                await r.NextResultAsync(inner).ConfigureAwait(false);
                if (await r.ReadAsync(inner).ConfigureAwait(false))
                {
                    salesDay = r.Dec("sales_day");
                    salesMonth = r.Dec("sales_month");
                }

                var topClients = await ReadLeadersAsync(r, inner).ConfigureAwait(false);
                var topTests = await ReadLeadersAsync(r, inner).ConfigureAwait(false);
                var topPayers = await ReadLeadersAsync(r, inner).ConfigureAwait(false);

                return new MonthStats(
                    Month: first.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
                    Through: through.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
                    Bills: billCount,
                    Patients: patients,
                    Registrations: registrations,
                    Revenue: revenue,
                    LabSalesDay: salesDay,
                    LabSalesMonth: salesMonth,
                    Collected: collected,
                    Refunded: refunded,
                    Outstanding: outstanding,
                    Discount: discount,
                    ActiveClients: activeClients,
                    ReferringDoctors: refDoctors,
                    TopClients: topClients,
                    TopTests: topTests,
                    TopPayers: topPayers);
            }, token), ct).ConfigureAwait(false);
    }

    private static async Task<IReadOnlyList<LeaderRow>> ReadLeadersAsync(
        Microsoft.Data.SqlClient.SqlDataReader r, CancellationToken ct)
    {
        await r.NextResultAsync(ct).ConfigureAwait(false);
        var rows = new List<LeaderRow>();
        while (await r.ReadAsync(ct).ConfigureAwait(false))
            rows.Add(new LeaderRow(r.Str("code") ?? "—", r.Str("name"), r.Dec("amount"), r.Int("cnt")));
        return rows;
    }

    /// <summary>
    /// The month to report on, and the last day inside it that has happened.
    /// </summary>
    /// <remarks>
    /// For the CURRENT month the range stops at today rather than at the month
    /// end. Not for correctness — there are no bills dated in the future — but
    /// so the range scanned is the shortest one that can hold the answer.
    /// </remarks>
    /// <remarks>
    /// Accepts either <c>yyyy-MM-dd</c> or <c>yyyy-MM</c>. A bare month means
    /// the day figure has nothing to point at, so it lands on the last day in
    /// range rather than silently reporting the first.
    /// </remarks>
    private static (DateTime First, DateTime Through, DateTime Day) NormaliseMonth(string? dateIso)
    {
        var today = DateTime.ParseExact(StatsRepository.TodayIst(), "yyyy-MM-dd", CultureInfo.InvariantCulture);

        DateTime? day = null;
        DateTime first;

        if (!string.IsNullOrWhiteSpace(dateIso)
            && DateTime.TryParseExact(dateIso, "yyyy-MM-dd", CultureInfo.InvariantCulture,
                DateTimeStyles.None, out var parsedDay))
        {
            day = parsedDay;
            first = new DateTime(parsedDay.Year, parsedDay.Month, 1);
        }
        else if (!string.IsNullOrWhiteSpace(dateIso)
            && DateTime.TryParseExact(dateIso + "-01", "yyyy-MM-dd", CultureInfo.InvariantCulture,
                DateTimeStyles.None, out var parsedMonth))
        {
            first = parsedMonth;
        }
        else
        {
            first = new DateTime(today.Year, today.Month, 1);
        }

        // Never report a month that has not started.
        if (first > today)
        {
            first = new DateTime(today.Year, today.Month, 1);
            day = null;
        }

        var monthEnd = first.AddMonths(1).AddDays(-1);
        var through = monthEnd > today ? today : monthEnd;

        // A day outside the month it belongs to cannot happen via the first
        // branch, but a future day inside the current month can.
        return (first, through, day is { } d && d >= first && d <= through ? d : through);
    }

    private static MonthStats Empty(DateTime first, DateTime through) => new(
        first.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
        through.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
        0, 0, 0, 0m, 0m, 0m, 0m, 0m, 0m, 0m, 0, 0, [], [], []);
}
