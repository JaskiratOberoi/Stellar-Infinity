using System.Data;
using System.Globalization;
using Infinity.Api.Data;
using Infinity.Api.Domain;
using Microsoft.Data.SqlClient;

namespace Infinity.Api.Reads;

public sealed record StatusCount(string Status, int Count);
public sealed record TrendPoint(string Date, decimal Revenue);

public sealed record DayStats(
    string Date,
    int Bills,
    int Patients,
    int Registrations,
    decimal Revenue,
    decimal Collected,
    decimal CashCollected,
    decimal OtherCollected,
    decimal Refunded,
    decimal Outstanding,
    decimal Discount,
    IReadOnlyList<StatusCount> ByStatus,
    IReadOnlyList<TrendPoint> Trend);

/// <summary>
/// Dashboard KPIs for one IST calendar day, plus a 7-day revenue trend.
/// Ported from Telo's db/read/stats.ts.
///
/// The cash-flow figures (collected / cash / other / refunded) are keyed on the
/// receipt's <c>recd_date</c>, NOT on the bill's date. A payment taken today
/// against last week's bill belongs in today's collections — keying it off
/// bill_date would silently misstate every day's cash position. This is the
/// invariant Telo calls out in receipts.ts and it must not be "simplified".
/// </summary>
public sealed class StatsRepository(NobleConnectionFactory db, SqlRetry retry)
{
    public async Task<DayStats> GetAsync(IReadOnlyList<int> scope, string? dateIso, CancellationToken ct = default)
    {
        var date = NormaliseDate(dateIso);

        // Fail closed: no centres means no data, never all data.
        if (scope.Count == 0) return Empty(date);

        return await retry.ExecuteAsync("stats.day", token =>
            db.QueryAsync("stats.day", async (conn, inner) =>
            {
                await using var cmd = NobleConnectionFactory.CreateCommand(conn, "");
                cmd.Parameters.Add("@d", SqlDbType.Date).Value = DateTime.ParseExact(date, "yyyy-MM-dd", CultureInfo.InvariantCulture);

                var bills = ScopeFilter.For(cmd, "b.mcc_code", scope, "b");
                var pats = ScopeFilter.For(cmd, "p.mcc_code", scope, "p");
                var samples = ScopeFilter.For(cmd, "p2.mcc_code", scope, "s");
                var rcpt = ScopeFilter.For(cmd, "rb.mcc_code", scope, "r");

                cmd.CommandText = $"""
                    SELECT
                      (SELECT COUNT(*)                        FROM dbo.tbl_billing_patient_detail b
                         WHERE CAST(b.bill_date AS DATE) = @d AND {bills.Predicate})            AS bills,
                      (SELECT COUNT(DISTINCT b.patientname)   FROM dbo.tbl_billing_patient_detail b
                         WHERE CAST(b.bill_date AS DATE) = @d AND {bills.Predicate})            AS patients,
                      (SELECT ISNULL(SUM(b.amount),0)         FROM dbo.tbl_billing_patient_detail b
                         WHERE CAST(b.bill_date AS DATE) = @d AND {bills.Predicate})            AS revenue,
                      (SELECT ISNULL(SUM(b.Balance),0)        FROM dbo.tbl_billing_patient_detail b
                         WHERE CAST(b.bill_date AS DATE) = @d AND {bills.Predicate})            AS outstanding,
                      (SELECT ISNULL(SUM(b.discount_amount),0) FROM dbo.tbl_billing_patient_detail b
                         WHERE CAST(b.bill_date AS DATE) = @d AND {bills.Predicate})            AS discount,
                      (SELECT COUNT(*)                        FROM dbo.tbl_med_mcc_patient_master p
                         WHERE CAST(p.sample_date AS DATE) = @d AND {pats.Predicate})           AS registrations;

                    -- Sample pipeline by status.
                    SELECT ISNULL(st.status, 'Unknown') AS status, COUNT(*) AS cnt
                    FROM dbo.tbl_med_mcc_patient_samples s
                    JOIN dbo.tbl_med_mcc_patient_master p2 ON p2.id = s.patient_id
                    LEFT JOIN dbo.tbl_med_mcc_patient_samples_status_master st ON st.id = s.sample_status
                    WHERE CAST(s.addeddate AS DATE) = @d AND {samples.Predicate}
                    GROUP BY st.status
                    ORDER BY COUNT(*) DESC;

                    -- 7-day revenue trend ending on @d (sparse; densified below).
                    SELECT CAST(b.bill_date AS DATE) AS d, ISNULL(SUM(b.amount),0) AS rev
                    FROM dbo.tbl_billing_patient_detail b
                    WHERE CAST(b.bill_date AS DATE) BETWEEN DATEADD(DAY,-6,@d) AND @d
                      AND {bills.Predicate}
                    GROUP BY CAST(b.bill_date AS DATE)
                    ORDER BY 1;

                    -- Cash flow, keyed on recd_date. receive_status '1' = payment,
                    -- '2' = refund. Voided receipts are excluded via Telo's void
                    -- ledger: Infinity has no void mechanism of its own yet, so
                    -- that table is the only record of a reversal.
                    SELECT
                      ISNULL(SUM(CASE WHEN r.receive_status = '1'
                                       AND r.pay_mode IS NOT NULL
                                       AND LOWER(r.pay_mode) LIKE '%cash%' THEN r.amount END),0) AS cash_in,
                      ISNULL(SUM(CASE WHEN r.receive_status = '1'
                                       AND (r.pay_mode IS NULL
                                            OR LOWER(r.pay_mode) NOT LIKE '%cash%') THEN r.amount END),0) AS other_in,
                      ISNULL(SUM(CASE WHEN r.receive_status = '2' THEN r.amount END),0) AS refunded
                    FROM dbo.tbl_billing_patient_amount_receipt r
                    JOIN dbo.tbl_billing_patient_detail rb ON rb.id = r.bill_id
                    WHERE CAST(r.recd_date AS DATE) = @d
                      AND {rcpt.Predicate}
                      AND NOT EXISTS (SELECT 1 FROM dbo.telo_receipt_void v WHERE v.receipt_id = r.id);
                    """;

                await using var reader = await cmd.ExecuteReaderAsync(inner).ConfigureAwait(false);

                // ---- result set 1: headline counts
                int billCount = 0, patientCount = 0, registrations = 0;
                decimal revenue = 0, outstanding = 0, discount = 0;
                if (await reader.ReadAsync(inner).ConfigureAwait(false))
                {
                    billCount = reader.Int("bills");
                    patientCount = reader.Int("patients");
                    revenue = reader.Dec("revenue");
                    outstanding = reader.Dec("outstanding");
                    discount = reader.Dec("discount");
                    registrations = reader.Int("registrations");
                }

                // ---- result set 2: status breakdown
                var byStatus = new List<StatusCount>();
                await reader.NextResultAsync(inner).ConfigureAwait(false);
                while (await reader.ReadAsync(inner).ConfigureAwait(false))
                {
                    byStatus.Add(new StatusCount(reader.Str("status") ?? "Unknown", reader.Int("cnt")));
                }

                // ---- result set 3: sparse trend
                var revByDate = new Dictionary<string, decimal>(StringComparer.Ordinal);
                await reader.NextResultAsync(inner).ConfigureAwait(false);
                while (await reader.ReadAsync(inner).ConfigureAwait(false))
                {
                    var d = reader.GetDateTime(0).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
                    revByDate[d] = Convert.ToDecimal(reader.GetValue(1));
                }

                // ---- result set 4: cash flow
                decimal cashIn = 0, otherIn = 0, refunded = 0;
                await reader.NextResultAsync(inner).ConfigureAwait(false);
                if (await reader.ReadAsync(inner).ConfigureAwait(false))
                {
                    cashIn = reader.Dec("cash_in");
                    otherIn = reader.Dec("other_in");
                    refunded = reader.Dec("refunded");
                }

                // Densify the trend so the chart has one point per day, not a
                // hole wherever a day had no bills.
                var anchor = DateTime.ParseExact(date, "yyyy-MM-dd", CultureInfo.InvariantCulture);
                var trend = new List<TrendPoint>(7);
                for (var i = 6; i >= 0; i--)
                {
                    var key = anchor.AddDays(-i).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
                    trend.Add(new TrendPoint(key, revByDate.GetValueOrDefault(key)));
                }

                return new DayStats(
                    date, billCount, patientCount, registrations, revenue,
                    Collected: cashIn + otherIn,
                    CashCollected: cashIn,
                    OtherCollected: otherIn,
                    Refunded: refunded,
                    Outstanding: outstanding,
                    Discount: discount,
                    ByStatus: byStatus,
                    Trend: trend);
            }, token), ct).ConfigureAwait(false);
    }

    /// <summary>Today on the IST calendar — the lab's day, not the server's.</summary>
    public static string TodayIst() =>
        DateTimeOffset.UtcNow.ToOffset(NobleTime.IstOffset).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);

    private static string NormaliseDate(string? input) =>
        input is not null
        && DateTime.TryParseExact(input, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out _)
            ? input
            : TodayIst();

    private static DayStats Empty(string date) =>
        new(date, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, [], []);
}

// Column readers live in Data/SqlReaderExtensions.cs.
