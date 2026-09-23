using System.Data;
using System.Globalization;
using Infinity.Api.Data;

namespace Infinity.Api.Reads;

/// <summary>One qualifying profile or package, with month-to-date and all-time sales.</summary>
public sealed record SmartTierRow(
    string Code, string Name,
    /// <summary>'package' (an HR health package), 'mini' (a small profile), or 'other'.</summary>
    string Tier,
    int MonthCount, decimal MonthAmount, int AllCount, decimal AllAmount);

/// <summary>Booklets sold on one day.</summary>
public sealed record SmartDayPoint(string Date, int Count, decimal Amount);

/// <summary>
/// The Smart Report's own numbers — how many booklets were sold, with which
/// profile, to which centres, at what price, and how much of that reached
/// the centres' accounts. Super-admin only; see the endpoint.
/// </summary>
public sealed record SmartReportStats(
    string Month, string Through,
    /// <summary>The first day a booklet was ever sold; null when none has been.</summary>
    string? FirstSale,
    int MonthCount, decimal MonthAmount,
    int AllCount, decimal AllAmount,
    /// <summary>What has actually been posted to centres' accounts (the charge latch), month and all time.</summary>
    decimal MonthCharged, decimal AllCharged,
    /// <summary>Booklets sold whose charge has not reached an account yet — booked but not accessioned, or sold before 151.</summary>
    int Uncharged,
    /// <summary>Sold booklets that were downloaded at least once, month and all time.</summary>
    int MonthDownloaded, int AllDownloaded,
    IReadOnlyList<SmartTierRow> ByProfile,
    IReadOnlyList<LeaderRow> ByClient,
    IReadOnlyList<LeaderRow> ByPrice,
    IReadOnlyList<SmartDayPoint> Daily);

/// <summary>
/// Reads the booklet's sales from the custom-line rows that entitle a patient
/// to it (<c>telo_custom_test_order</c>, code SMART-RPT, with a bill), keyed
/// on the bill date, and attributes each sale to the profile that qualified
/// it: the HR package on the order (inf_smart_report_package) if there is
/// one, else the mini profile or test (inf_smart_report_mini), else "other"
/// for the booklets sold before the offer was restricted.
/// </summary>
/// <remarks>
/// Not scoped: it exists for the super admin, whose scope is the whole lab,
/// and the endpoint refuses everyone else. Fixture bookings on the throwaway
/// centre carry no bill (bill_id 0) and so never count.
/// </remarks>
public sealed class SmartReportStatsRepository(NobleConnectionFactory db, SqlRetry retry)
{
    private const int TopN = 10;
    private const int TrendDays = 30;

    public async Task<SmartReportStats> GetAsync(string? dateIso = null, CancellationToken ct = default)
    {
        var (first, through, day) = NormaliseMonth(dateIso);
        return await retry.ExecuteAsync("stats.smart", token =>
            db.QueryAsync("stats.smart", async (conn, inner) =>
            {
                await using var cmd = NobleConnectionFactory.CreateCommand(conn, Sql);
                cmd.CommandTimeout = 60;
                cmd.Parameters.Add("@from", SqlDbType.Date).Value = first;
                cmd.Parameters.Add("@to", SqlDbType.Date).Value = through;
                cmd.Parameters.Add("@day", SqlDbType.Date).Value = day;
                cmd.Parameters.Add("@trendFrom", SqlDbType.Date).Value = day.AddDays(-(TrendDays - 1));
                cmd.Parameters.Add("@top", SqlDbType.Int).Value = TopN;

                await using var r = await cmd.ExecuteReaderAsync(inner).ConfigureAwait(false);

                // 1 — headline
                if (!await r.ReadAsync(inner).ConfigureAwait(false)) return Empty(first, through);
                var monthCount = r.Int("monthCount");
                var monthAmount = r.Dec("monthAmount");
                var monthCharged = r.Dec("monthCharged");
                var allCount = r.Int("allCount");
                var allAmount = r.Dec("allAmount");
                var allCharged = r.Dec("allCharged");
                var uncharged = r.Int("uncharged");
                var monthDownloaded = r.Int("monthDownloaded");
                var allDownloaded = r.Int("allDownloaded");
                var firstSale = r.Date("firstSale") is DateTime fs ? fs.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture) : null;

                // 2 — by profile
                var byProfile = new List<SmartTierRow>();
                if (await r.NextResultAsync(inner).ConfigureAwait(false))
                    while (await r.ReadAsync(inner).ConfigureAwait(false))
                        byProfile.Add(new SmartTierRow(
                            r.Str("code") ?? string.Empty, r.Str("name") ?? string.Empty, r.Str("tier") ?? "other",
                            r.Int("monthCount"), r.Dec("monthAmount"), r.Int("allCount"), r.Dec("allAmount")));

                // 3 — by client, month to date
                var byClient = new List<LeaderRow>();
                if (await r.NextResultAsync(inner).ConfigureAwait(false))
                    while (await r.ReadAsync(inner).ConfigureAwait(false))
                        byClient.Add(new LeaderRow(r.Str("code") ?? string.Empty, r.Str("name"), r.Dec("amount"), r.Int("count")));

                // 4 — by price point, all time
                var byPrice = new List<LeaderRow>();
                if (await r.NextResultAsync(inner).ConfigureAwait(false))
                    while (await r.ReadAsync(inner).ConfigureAwait(false))
                        byPrice.Add(new LeaderRow(r.Str("code") ?? string.Empty, null, r.Dec("amount"), r.Int("count")));

                // 5 — daily trend; every day present, zero when nothing sold
                var daily = new List<SmartDayPoint>();
                if (await r.NextResultAsync(inner).ConfigureAwait(false))
                    while (await r.ReadAsync(inner).ConfigureAwait(false))
                        daily.Add(new SmartDayPoint(
                            r.Date("day")?.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture) ?? string.Empty,
                            r.Int("count"), r.Dec("amount")));

                return new SmartReportStats(
                    Iso(first), Iso(through), firstSale,
                    monthCount, monthAmount, allCount, allAmount,
                    monthCharged, allCharged, uncharged,
                    monthDownloaded, allDownloaded,
                    byProfile, byClient, byPrice, daily);
            }, token), ct).ConfigureAwait(false);
    }

    private const string Sql = """
        -- Every booklet sold, attributed to the profile that qualified it.
        SELECT c.id, c.patient_id, c.bill_id, c.unit_amount * c.qty AS amount, c.unit_amount AS price,
               CAST(b.bill_date AS DATE) AS day,
               client = LTRIM(RTRIM(ISNULL(u.MCCUnitCode, N''))),
               clientName = LTRIM(RTRIM(ISNULL(u.MCCUnitName, N''))),
               tierCode = ISNULL(pk.code, ISNULL(mn.code, N'OTHER')),
               tierName = ISNULL(pk.name, ISNULL(mn.name, N'No qualifying profile')),
               tier = CASE WHEN pk.code IS NOT NULL THEN 'package' WHEN mn.code IS NOT NULL THEN 'mini' ELSE 'other' END,
               charged = ISNULL(l.amount, 0)
        INTO #sold
        FROM dbo.telo_custom_test_order c
        JOIN dbo.tbl_billing_patient_detail b ON b.id = c.bill_id
        JOIN dbo.tbl_med_mcc_patient_master pm ON pm.id = c.patient_id
        LEFT JOIN dbo.tbl_med_mcc_unit_master u ON u.id = pm.mcc_code
        LEFT JOIN dbo.telo_custom_line_charge l ON l.bill_id = c.bill_id AND l.custom_test_id = c.custom_test_id
        OUTER APPLY (SELECT TOP 1 LTRIM(RTRIM(m.Master_Profile_Code)) AS code, LTRIM(RTRIM(m.Master_Profile_Name)) AS name
                     FROM dbo.tbl_med_mcc_patient_tests t
                     JOIN dbo.inf_smart_report_package p ON p.master_profile_id = t.test_id
                     JOIN dbo.tbl_med_test_master_profile_master m ON m.id = p.master_profile_id
                     WHERE t.patient_id = c.patient_id AND t.test_type = 'Master' ORDER BY t.id) pk
        OUTER APPLY (SELECT TOP 1 mi.code, mi.name
                     FROM dbo.tbl_med_mcc_patient_tests t
                     JOIN dbo.inf_smart_report_mini mi
                       ON (mi.kind = N'profile' AND t.test_type IN ('Profile', 'p') AND mi.catalogue_id = t.test_id)
                       OR (mi.kind = N'test'    AND t.test_type IN ('Test', 't')    AND mi.catalogue_id = t.test_id)
                     WHERE t.patient_id = c.patient_id ORDER BY t.id) mn
        -- Both codes: the mini tier bills as its own line (SMART-MINI) since
        -- 2026-09-23; earlier mini sales carry SMART-RPT at the mini price.
        WHERE c.code IN ('SMART-RPT', 'SMART-MINI') AND c.bill_id > 0;

        -- A sold booklet counts as downloaded when any of the patient's
        -- samples has a smart-PDF audit row; the multi-sample route logs one
        -- row per sample per download, so events are not booklets.
        SELECT s.patient_id INTO #downloaded
        FROM #sold s
        WHERE EXISTS (SELECT 1 FROM dbo.inf_audit_log a
                      JOIN dbo.tbl_med_mcc_patient_samples ps ON ps.vailid = a.sid
                      WHERE a.kind = 'report.smart_pdf' AND ps.patient_id = s.patient_id);

        -- 1 ── headline
        SELECT
          monthCount      = (SELECT COUNT(*)              FROM #sold WHERE day BETWEEN @from AND @to),
          monthAmount     = (SELECT ISNULL(SUM(amount),0) FROM #sold WHERE day BETWEEN @from AND @to),
          monthCharged    = (SELECT ISNULL(SUM(charged),0) FROM #sold WHERE day BETWEEN @from AND @to),
          allCount        = (SELECT COUNT(*)              FROM #sold),
          allAmount       = (SELECT ISNULL(SUM(amount),0) FROM #sold),
          allCharged      = (SELECT ISNULL(SUM(charged),0) FROM #sold),
          uncharged       = (SELECT COUNT(*)              FROM #sold WHERE charged = 0),
          monthDownloaded = (SELECT COUNT(*) FROM #sold s WHERE s.day BETWEEN @from AND @to AND EXISTS (SELECT 1 FROM #downloaded d WHERE d.patient_id = s.patient_id)),
          allDownloaded   = (SELECT COUNT(*) FROM #sold s WHERE EXISTS (SELECT 1 FROM #downloaded d WHERE d.patient_id = s.patient_id)),
          firstSale       = (SELECT MIN(day) FROM #sold);

        -- 2 ── by qualifying profile: all time, with the month alongside
        SELECT code = tierCode, name = tierName, tier,
               monthCount  = SUM(CASE WHEN day BETWEEN @from AND @to THEN 1 ELSE 0 END),
               monthAmount = SUM(CASE WHEN day BETWEEN @from AND @to THEN amount ELSE 0 END),
               allCount = COUNT(*), allAmount = SUM(amount)
        FROM #sold GROUP BY tierCode, tierName, tier
        ORDER BY allCount DESC, allAmount DESC;

        -- 3 ── by centre, month to date
        SELECT TOP (@top) code = client, name = clientName, amount = SUM(amount), count = COUNT(*)
        FROM #sold WHERE day BETWEEN @from AND @to
        GROUP BY client, clientName ORDER BY COUNT(*) DESC, SUM(amount) DESC;

        -- 4 ── by price point, all time (₹99 / ₹49 / ₹21 / ₹11 …)
        SELECT code = CONVERT(NVARCHAR(20), price), amount = SUM(amount), count = COUNT(*)
        FROM #sold GROUP BY price ORDER BY price DESC;

        -- 5 ── daily, the last @trendFrom..@day, every day present
        ;WITH days AS (
            SELECT @trendFrom AS d
            UNION ALL SELECT DATEADD(DAY, 1, d) FROM days WHERE d < @day
        )
        SELECT day = days.d,
               count = (SELECT COUNT(*) FROM #sold s WHERE s.day = days.d),
               amount = (SELECT ISNULL(SUM(amount),0) FROM #sold s WHERE s.day = days.d)
        FROM days ORDER BY days.d
        OPTION (MAXRECURSION 400);

        DROP TABLE #downloaded; DROP TABLE #sold;
        """;

    private static string Iso(DateTime d) => d.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);

    private static SmartReportStats Empty(DateTime first, DateTime through) =>
        new(Iso(first), Iso(through), null, 0, 0, 0, 0, 0, 0, 0, 0, 0, [], [], [], []);

    /// <summary>The month containing the selected day, through that day (or month end).</summary>
    private static (DateTime First, DateTime Through, DateTime Day) NormaliseMonth(string? dateIso)
    {
        // Same convention as MonthStatsRepository: the month containing the
        // selected day; "through" is today for the current month and the
        // month's last day otherwise, so the two blocks describe one period.
        var today = DateTime.ParseExact(StatsRepository.TodayIst(), "yyyy-MM-dd", CultureInfo.InvariantCulture);
        var day = today;
        if (!string.IsNullOrWhiteSpace(dateIso)
            && DateTime.TryParseExact(dateIso.Trim(), "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var parsed)
            && parsed <= today)
            day = parsed;
        var first = new DateTime(day.Year, day.Month, 1);
        var currentMonth = first.Year == today.Year && first.Month == today.Month;
        var through = currentMonth ? today : first.AddMonths(1).AddDays(-1);
        return (first, through, day);
    }
}
