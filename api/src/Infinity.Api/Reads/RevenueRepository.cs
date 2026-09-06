using System.Data;
using System.Globalization;
using Infinity.Api.Data;
using Infinity.Api.Domain;
using Microsoft.Data.SqlClient;

namespace Infinity.Api.Reads;

/// <summary>
/// One centre's revenue over a period, split by where the order came from.
/// </summary>
/// <param name="Period">day, week, month or year — the one actually applied.</param>
/// <param name="From">First day INCLUDED, ISO.</param>
/// <param name="To">Last day INCLUDED, ISO.</param>
/// <param name="Total">Every source together. Always Infinity + Telo + Lis.</param>
/// <param name="Infinity">Bills raised in Infinity.</param>
/// <param name="Telo">Bills raised in Telo.</param>
/// <param name="Lis">
/// Samples the lab registered in the LIS directly and debited from the
/// centre's account — no bill row exists for these.
/// </param>
/// <param name="Bills">Bill rows in the period (Infinity + Telo).</param>
/// <param name="Patients">Distinct patients charged, across every source.</param>
/// <param name="Trend">One point per bucket across the trend window (see remarks).</param>
public sealed record RevenuePeriod(
    string Period,
    string From,
    string To,
    decimal Total,
    decimal Infinity,
    decimal Telo,
    decimal Lis,
    int Bills,
    int Patients,
    /// <summary>
    /// The window the trend covers. For a DAY it is the six days before plus
    /// the day itself, so a single-day view still has a line to read; for
    /// every other period it is the period.
    /// </summary>
    string TrendFrom,
    string TrendTo,
    /// <summary>
    /// "day" when each point is a date, "month" when each point is a month
    /// (the year view; 31 points a month would be noise across 365 days).
    /// </summary>
    string TrendUnit,
    IReadOnlyList<TrendPoint> Trend);

/// <summary>
/// The centre's revenue over day / week / month / year, source-agnostic and
/// then attributed to a source.
/// </summary>
/// <remarks>
/// <para>
/// ── WHY THIS IS NOT JUST THE DAY QUERY OVER A LONGER RANGE ────────────────
/// The day tile in <see cref="StatsRepository"/> already adds the two places a
/// centre's charges live: bills (<c>tbl_billing_patient_detail</c>, which
/// holds ONLY what Telo and Infinity raised) and the LIS wallet debits
/// (<c>tbl_med_mcc_test_transactions</c>, written by the LIS's CheckTransCash
/// when a courier sample is registered). This repository keeps exactly that
/// definition — the two figures must agree on any day — and adds the two
/// things a centre asked for: a period longer than a day, and WHICH SYSTEM
/// each rupee came through.
/// </para>
/// <para>
/// ── ATTRIBUTION ────────────────────────────────────────────────────────────
/// A bill's <c>addedby</c> is <c>'inf:&lt;userId&gt;'</c> or
/// <c>'telo:&lt;userId&gt;'</c>, the origin markers the two front ends write.
/// Wallet debits for a patient who ALSO has a bill are the accession's echo of
/// that bill and are excluded (the same rule as the day tile — counting both
/// doubles the order). What remains in the wallet table is work the lab
/// registered in the LIS itself, and that is the LIS bucket. A bill with
/// neither marker has not been seen on a live month; it falls into the LIS
/// bucket rather than vanishing, so the split always sums to the total.
/// </para>
/// <para>
/// ── PERIODS ────────────────────────────────────────────────────────────────
/// All on the IST calendar. A week is Monday to Sunday containing the
/// selected day; a month and a year are the calendar ones. Nothing is capped
/// at today: a week that runs past today simply has empty days, which is what
/// a centre reading "this week" expects to see.
/// </para>
/// </remarks>
public sealed class RevenueRepository(NobleConnectionFactory db, SqlRetry retry)
{
    public static readonly string[] Periods = ["day", "week", "month", "year"];

    public async Task<RevenuePeriod> GetAsync(
        IReadOnlyList<int> scope, string? period, string? dateIso, CancellationToken ct = default)
    {
        var p = Periods.Contains(period ?? "", StringComparer.OrdinalIgnoreCase) ? period!.ToLowerInvariant() : "day";
        var anchor = ParseDate(dateIso);
        var (from, to) = Range(p, anchor);
        var (tFrom, tTo) = p == "day" ? (anchor.AddDays(-6), anchor) : (from, to);
        var unit = p == "year" ? "month" : "day";

        // Fail closed: no centres means no data, never all data.
        if (scope.Count == 0) return Empty(p, from, to, tFrom, tTo, unit);

        return await retry.ExecuteAsync("stats.revenue", token =>
            db.QueryAsync("stats.revenue", async (conn, inner) =>
            {
                await using var cmd = NobleConnectionFactory.CreateCommand(conn, "");
                cmd.CommandTimeout = 60;
                cmd.Parameters.Add("@from", SqlDbType.Date).Value = from;
                cmd.Parameters.Add("@to", SqlDbType.Date).Value = to;
                cmd.Parameters.Add("@tfrom", SqlDbType.Date).Value = tFrom;
                cmd.Parameters.Add("@tto", SqlDbType.Date).Value = tTo;

                var bills = ScopeFilter.For(cmd, "b.mcc_code", scope, "b");
                var txn = ScopeFilter.For(cmd, "t.mccid", scope, "t");
                var bills2 = ScopeFilter.For(cmd, "b2.mcc_code", scope, "b2");
                var txn2 = ScopeFilter.For(cmd, "t2.mccid", scope, "t2");

                // The bucket a trend point lands in. A day is itself; a year
                // collapses each day to the first of its month.
                var bucket = unit == "month"
                    ? "DATEFROMPARTS(YEAR({0}), MONTH({0}), 1)"
                    : "{0}";
                var billBucket = string.Format(CultureInfo.InvariantCulture, bucket, "CAST(b2.bill_date AS DATE)");
                var txnBucket = string.Format(CultureInfo.InvariantCulture, bucket, "CAST(t2.transdate AS DATE)");

                cmd.CommandText = $"""
                    -- ---- the period, by source ---------------------------------
                    SELECT x.src,
                           ISNULL(SUM(x.amount), 0)     AS amount,
                           SUM(x.isbill)                AS bills,
                           COUNT(DISTINCT x.pid)        AS patients
                    FROM (
                        SELECT CASE WHEN b.addedby LIKE 'inf:%'  THEN 'infinity'
                                    WHEN b.addedby LIKE 'telo:%' THEN 'telo'
                                    ELSE 'lis' END                            AS src,
                               b.amount                                       AS amount,
                               1                                              AS isbill,
                               b.medid                                        AS pid
                        FROM dbo.tbl_billing_patient_detail b
                        WHERE CAST(b.bill_date AS DATE) BETWEEN @from AND @to
                          AND {bills.Predicate}
                        UNION ALL
                        SELECT 'lis', t.testcharges, 0, CONVERT(VARCHAR(20), t.patientid)
                        FROM dbo.tbl_med_mcc_test_transactions t
                        WHERE CAST(t.transdate AS DATE) BETWEEN @from AND @to
                          AND {txn.Predicate}
                          AND NOT EXISTS (SELECT 1 FROM dbo.tbl_billing_patient_detail xb
                                          WHERE xb.mcc_code = t.mccid
                                            AND xb.medid = CONVERT(VARCHAR(20), t.patientid))
                    ) x
                    GROUP BY x.src;

                    -- ---- the trend, one row per non-empty bucket ----------------
                    SELECT y.d, SUM(y.amount) AS amount
                    FROM (
                        SELECT {billBucket} AS d, b2.amount AS amount
                        FROM dbo.tbl_billing_patient_detail b2
                        WHERE CAST(b2.bill_date AS DATE) BETWEEN @tfrom AND @tto
                          AND {bills2.Predicate}
                        UNION ALL
                        SELECT {txnBucket}, t2.testcharges
                        FROM dbo.tbl_med_mcc_test_transactions t2
                        WHERE CAST(t2.transdate AS DATE) BETWEEN @tfrom AND @tto
                          AND {txn2.Predicate}
                          AND NOT EXISTS (SELECT 1 FROM dbo.tbl_billing_patient_detail xb
                                          WHERE xb.mcc_code = t2.mccid
                                            AND xb.medid = CONVERT(VARCHAR(20), t2.patientid))
                    ) y
                    GROUP BY y.d
                    ORDER BY y.d;
                    """;

                await using var reader = await cmd.ExecuteReaderAsync(inner).ConfigureAwait(false);

                decimal inf = 0, telo = 0, lis = 0;
                int billCount = 0, patients = 0;
                while (await reader.ReadAsync(inner).ConfigureAwait(false))
                {
                    var amount = reader.Dec("amount");
                    switch (reader.Str("src"))
                    {
                        case "infinity": inf += amount; break;
                        case "telo": telo += amount; break;
                        default: lis += amount; break;
                    }
                    billCount += reader.Int("bills");
                    patients += reader.Int("patients");
                }

                var byBucket = new Dictionary<string, decimal>(StringComparer.Ordinal);
                await reader.NextResultAsync(inner).ConfigureAwait(false);
                while (await reader.ReadAsync(inner).ConfigureAwait(false))
                {
                    var d = reader.GetDateTime(0);
                    byBucket[Key(d, unit)] = Convert.ToDecimal(reader.GetValue(1));
                }

                // Densify: one point per bucket in the window, zero where the
                // centre had no work, so the chart has no holes.
                var trend = new List<TrendPoint>();
                if (unit == "month")
                {
                    for (var d = new DateTime(tFrom.Year, tFrom.Month, 1); d <= tTo; d = d.AddMonths(1))
                        trend.Add(new TrendPoint(Key(d, unit), byBucket.GetValueOrDefault(Key(d, unit))));
                }
                else
                {
                    for (var d = tFrom; d <= tTo; d = d.AddDays(1))
                        trend.Add(new TrendPoint(Key(d, unit), byBucket.GetValueOrDefault(Key(d, unit))));
                }

                return new RevenuePeriod(
                    p, Iso(from), Iso(to),
                    Total: inf + telo + lis,
                    Infinity: inf, Telo: telo, Lis: lis,
                    Bills: billCount, Patients: patients,
                    TrendFrom: Iso(tFrom), TrendTo: Iso(tTo), TrendUnit: unit,
                    Trend: trend);
            }, token), ct).ConfigureAwait(false);
    }

    /// <summary>The calendar period containing <paramref name="anchor"/>.</summary>
    private static (DateTime From, DateTime To) Range(string period, DateTime anchor) => period switch
    {
        // Monday-start week, the way the lab reads a week.
        "week" => (anchor.AddDays(-(((int)anchor.DayOfWeek + 6) % 7)),
                   anchor.AddDays(6 - (((int)anchor.DayOfWeek + 6) % 7))),
        "month" => (new DateTime(anchor.Year, anchor.Month, 1),
                    new DateTime(anchor.Year, anchor.Month, DateTime.DaysInMonth(anchor.Year, anchor.Month))),
        "year" => (new DateTime(anchor.Year, 1, 1), new DateTime(anchor.Year, 12, 31)),
        _ => (anchor, anchor),
    };

    private static string Key(DateTime d, string unit) =>
        d.ToString(unit == "month" ? "yyyy-MM" : "yyyy-MM-dd", CultureInfo.InvariantCulture);

    private static string Iso(DateTime d) => d.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);

    /// <summary>A valid ISO day, else today on the IST calendar.</summary>
    private static DateTime ParseDate(string? input) =>
        input is not null
        && DateTime.TryParseExact(input, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var d)
            ? d.Date
            : DateTime.ParseExact(StatsRepository.TodayIst(), "yyyy-MM-dd", CultureInfo.InvariantCulture);

    private static RevenuePeriod Empty(string p, DateTime from, DateTime to, DateTime tFrom, DateTime tTo, string unit) =>
        new(p, Iso(from), Iso(to), 0, 0, 0, 0, 0, 0, Iso(tFrom), Iso(tTo), unit, []);
}
