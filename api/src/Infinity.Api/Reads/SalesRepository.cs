using System.Data;
using System.Globalization;
using Infinity.Api.Data;
using Infinity.Api.Domain;
using Microsoft.Data.SqlClient;

namespace Infinity.Api.Reads;

/// <summary>One centre in a salesperson's territory, with this month's and last month's business.</summary>
public sealed record SalesCentre(int Mcc, string Code, string? Name, string? City, decimal Month, decimal PrevMonth, int Patients);

/// <summary>One month of the financial year: what was set and what came in.</summary>
public sealed record SalesMonthPoint(int Year, int Month, decimal Target, decimal Achieved);

public sealed record SalesDayPoint(string Date, decimal Amount);

/// <summary>
/// A salesperson's month and year, as the sales dashboard draws them.
/// </summary>
/// <param name="Month">The month shown, yyyy-MM.</param>
/// <param name="Through">The last day counted — today for the current month, the month's last day otherwise.</param>
/// <param name="Target">This month's target, 0 when none is set.</param>
/// <param name="Achieved">This month's sales to <paramref name="Through"/>.</param>
/// <param name="PrevMonthToDate">Last month to the same day of the month, for a like-for-like comparison.</param>
/// <param name="PrevMonthTotal">Last month in full.</param>
/// <param name="Projected">This month's sales at the current daily run rate, carried to the month's end.</param>
/// <param name="FyLabel">The financial year (April to March) the month belongs to, e.g. "FY 2026-27".</param>
public sealed record SalesDashboard(
    int UserId, string Username, string? Name,
    string Month, string From, string Through, int DaysCounted, int DaysInMonth,
    decimal Target, decimal Achieved, decimal PrevMonthToDate, decimal PrevMonthTotal, decimal Projected,
    int Patients, int Centres, int ActiveCentres,
    IReadOnlyList<SalesDayPoint> Daily,
    string FyLabel, decimal FyTarget, decimal FyAchieved, IReadOnlyList<SalesMonthPoint> FyMonths,
    IReadOnlyList<SalesCentre> TopCentres, IReadOnlyList<SalesCentre> SilentCentres, IReadOnlyList<SalesCentre> NewCentres);

/// <summary>A row of the team list: one salesperson's month at a glance.</summary>
public sealed record SalesTeamRow(int UserId, string Username, string? Name, string? Type, int Centres, decimal Target, decimal Achieved, int Patients);

/// <summary>
/// The sales dashboard's reads: a salesperson's territory against its target.
///
/// ── WHAT "SALES" MEANS HERE ────────────────────────────────────────────────
/// The LIS's own sales screens (usp_sales_summary_sales_of_mccs106 and its
/// family) count a test line the moment it is booked to the centre's account:
/// tbl_med_mcc_patient_tests.test_rate where amount_checked = 1, dated by the
/// line's updateddate — the stamp CheckTransCash sets when the order is
/// registered and charged. This repository counts exactly that, so the figure
/// a salesperson sees here reconciles with the one the LIS's sales report has
/// always shown them. (The lab dashboard's month panel dates the same lines
/// by the patient's registration instead; the two differ by the odd late
/// correction, and the sales team's number is the LIS's.)
///
/// The territory is tbl_med_user_sales_mcc_mapping — the same table the
/// report scope reads — and the target is tbl_med_sales_user_target, the
/// LIS's own, month by month. Both are the LIS's records, read in place, so
/// the mapping an admin maintains in the LIS and the target set here or there
/// are one fact.
///
/// The financial year runs April to March, as the lab's does.
/// </summary>
public sealed class SalesRepository(NobleConnectionFactory db, SqlRetry retry)
{
    /// <summary>LIS user types that are the field force. Mirrors InfinityRoles' map to sales_exec.</summary>
    private const string SalesTypes = "6, 13, 15, 27";

    public async Task<SalesDashboard?> GetDashboardAsync(int userId, string? monthIso, CancellationToken ct = default)
    {
        // The month, its bounds, and how far into it we count.
        var today = NobleTime.NowForNoble().Date;
        var month = ParseMonth(monthIso) ?? new DateTime(today.Year, today.Month, 1);
        var from = month;
        var monthEnd = month.AddMonths(1).AddDays(-1);
        var through = monthEnd < today ? monthEnd : today;
        if (through < from) through = from;
        var toX = through.AddDays(1);                         // exclusive
        var daysCounted = (through - from).Days + 1;
        var daysInMonth = DateTime.DaysInMonth(month.Year, month.Month);

        var prevFrom = month.AddMonths(-1);
        var prevToDateX = prevFrom.AddDays(daysCounted);
        var prevMonthX = month;                               // exclusive end of last month

        var fyStartYear = month.Month >= 4 ? month.Year : month.Year - 1;
        var fyStart = new DateTime(fyStartYear, 4, 1);
        var fyLabel = $"FY {fyStartYear}-{(fyStartYear + 1) % 100:00}";

        return await retry.ExecuteAsync("sales.dashboard", token =>
            db.QueryAsync("sales.dashboard", async (conn, inner) =>
            {
                await using var cmd = NobleConnectionFactory.CreateCommand(conn, """
                    SET NOCOUNT ON;

                    -- The territory, once.
                    SELECT DISTINCT m.mcc_code INTO #scope
                    FROM dbo.tbl_med_user_sales_mcc_mapping m
                    WHERE m.user_id = @uid AND m.mcc_code IS NOT NULL;

                    -- 1. who
                    SELECT u.Username, LTRIM(RTRIM(ISNULL(u.firstname, '') + ' ' + ISNULL(u.lastname, ''))) AS name
                    FROM dbo.tbl_med_user_master u WHERE u.id = @uid;

                    -- 2. the month and its comparisons, in one pass over the
                    --    lines from last month's start to today.
                    SELECT
                      ISNULL(SUM(CASE WHEN t.updateddate >= @from AND t.updateddate < @toX THEN t.test_rate END), 0)           AS achieved,
                      COUNT(DISTINCT CASE WHEN t.updateddate >= @from AND t.updateddate < @toX THEN t.patient_id END)            AS patients,
                      ISNULL(SUM(CASE WHEN t.updateddate >= @prevFrom AND t.updateddate < @prevToDateX THEN t.test_rate END), 0) AS prev_to_date,
                      ISNULL(SUM(CASE WHEN t.updateddate >= @prevFrom AND t.updateddate < @prevMonthX THEN t.test_rate END), 0)  AS prev_total
                    FROM dbo.tbl_med_mcc_patient_tests t
                    JOIN dbo.tbl_med_mcc_patient_master p ON p.id = t.patient_id
                    JOIN #scope s ON s.mcc_code = p.mcc_code
                    WHERE t.amount_checked = 1 AND t.updateddate >= @prevFrom AND t.updateddate < @toX;

                    -- 3. day by day, this month
                    SELECT CAST(t.updateddate AS DATE) AS d, SUM(t.test_rate) AS amt
                    FROM dbo.tbl_med_mcc_patient_tests t
                    JOIN dbo.tbl_med_mcc_patient_master p ON p.id = t.patient_id
                    JOIN #scope s ON s.mcc_code = p.mcc_code
                    WHERE t.amount_checked = 1 AND t.updateddate >= @from AND t.updateddate < @toX
                    GROUP BY CAST(t.updateddate AS DATE) ORDER BY 1;

                    -- 4. the financial year, month by month
                    SELECT YEAR(t.updateddate) AS y, MONTH(t.updateddate) AS m, SUM(t.test_rate) AS amt
                    FROM dbo.tbl_med_mcc_patient_tests t
                    JOIN dbo.tbl_med_mcc_patient_master p ON p.id = t.patient_id
                    JOIN #scope s ON s.mcc_code = p.mcc_code
                    WHERE t.amount_checked = 1 AND t.updateddate >= @fyStart AND t.updateddate < @toX
                    GROUP BY YEAR(t.updateddate), MONTH(t.updateddate) ORDER BY 1, 2;

                    -- 5. the targets set for the financial year
                    SELECT g.year, g.month, ISNULL(g.target, 0) AS target
                    FROM dbo.tbl_med_sales_user_target g
                    WHERE g.user_id = @uid
                      AND ((g.year = @fyYear AND g.month >= 4) OR (g.year = @fyYear + 1 AND g.month <= 3));

                    -- 6. every centre in the territory, with this month and last
                    SELECT s.mcc_code, LTRIM(RTRIM(u.MCCUnitCode)) AS code, u.MCCUnitName AS name, u.city,
                           ISNULL(x.this_month, 0) AS this_month, ISNULL(x.prev_month, 0) AS prev_month, ISNULL(x.patients, 0) AS patients,
                           CAST(CASE WHEN u.CreatedDate >= @from THEN 1 ELSE 0 END AS BIT) AS is_new
                    FROM #scope s
                    JOIN dbo.tbl_med_mcc_unit_master u ON u.id = s.mcc_code
                    LEFT JOIN (
                        SELECT p.mcc_code,
                               SUM(CASE WHEN t.updateddate >= @from THEN t.test_rate END) AS this_month,
                               SUM(CASE WHEN t.updateddate < @prevMonthX THEN t.test_rate END) AS prev_month,
                               COUNT(DISTINCT CASE WHEN t.updateddate >= @from THEN t.patient_id END) AS patients
                        FROM dbo.tbl_med_mcc_patient_tests t
                        JOIN dbo.tbl_med_mcc_patient_master p ON p.id = t.patient_id
                        JOIN #scope s2 ON s2.mcc_code = p.mcc_code
                        WHERE t.amount_checked = 1 AND t.updateddate >= @prevFrom AND t.updateddate < @toX
                        GROUP BY p.mcc_code
                    ) x ON x.mcc_code = s.mcc_code;

                    DROP TABLE #scope;
                    """);
                cmd.CommandTimeout = 60;
                cmd.Parameters.Add("@uid", SqlDbType.Int).Value = userId;
                cmd.Parameters.Add("@from", SqlDbType.DateTime).Value = from;
                cmd.Parameters.Add("@toX", SqlDbType.DateTime).Value = toX;
                cmd.Parameters.Add("@prevFrom", SqlDbType.DateTime).Value = prevFrom;
                cmd.Parameters.Add("@prevToDateX", SqlDbType.DateTime).Value = prevToDateX;
                cmd.Parameters.Add("@prevMonthX", SqlDbType.DateTime).Value = prevMonthX;
                cmd.Parameters.Add("@fyStart", SqlDbType.DateTime).Value = fyStart;
                cmd.Parameters.Add("@fyYear", SqlDbType.Int).Value = fyStartYear;

                await using var reader = await cmd.ExecuteReaderAsync(inner).ConfigureAwait(false);

                // 1
                if (!await reader.ReadAsync(inner).ConfigureAwait(false)) return null;
                var username = reader.Str("Username") ?? userId.ToString(CultureInfo.InvariantCulture);
                var name = reader.Str("name");
                if (string.IsNullOrWhiteSpace(name)) name = null;

                // 2
                decimal achieved = 0, prevToDate = 0, prevTotal = 0; var patients = 0;
                await reader.NextResultAsync(inner).ConfigureAwait(false);
                if (await reader.ReadAsync(inner).ConfigureAwait(false))
                {
                    achieved = reader.Dec("achieved");
                    patients = reader.Int("patients");
                    prevToDate = reader.Dec("prev_to_date");
                    prevTotal = reader.Dec("prev_total");
                }

                // 3
                var byDay = new Dictionary<string, decimal>(StringComparer.Ordinal);
                await reader.NextResultAsync(inner).ConfigureAwait(false);
                while (await reader.ReadAsync(inner).ConfigureAwait(false))
                    byDay[reader.GetDateTime(0).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture)] = Convert.ToDecimal(reader.GetValue(1));

                // 4
                var byMonth = new Dictionary<(int, int), decimal>();
                await reader.NextResultAsync(inner).ConfigureAwait(false);
                while (await reader.ReadAsync(inner).ConfigureAwait(false))
                    byMonth[(reader.Int("y"), reader.Int("m"))] = reader.Dec("amt");

                // 5
                var targets = new Dictionary<(int, int), decimal>();
                await reader.NextResultAsync(inner).ConfigureAwait(false);
                while (await reader.ReadAsync(inner).ConfigureAwait(false))
                    targets[(reader.Int("year"), reader.Int("month"))] = reader.Dec("target");

                // 6
                var centres = new List<(SalesCentre C, bool IsNew)>();
                await reader.NextResultAsync(inner).ConfigureAwait(false);
                while (await reader.ReadAsync(inner).ConfigureAwait(false))
                {
                    centres.Add((new SalesCentre(
                        reader.Int("mcc_code"), reader.Str("code") ?? "", reader.Str("name"), reader.Str("city"),
                        reader.Dec("this_month"), reader.Dec("prev_month"), reader.Int("patients")), Convert.ToBoolean(reader["is_new"])));
                }

                // Densify the days so the chart has one point per day counted.
                var daily = new List<SalesDayPoint>(daysCounted);
                for (var d = from; d <= through; d = d.AddDays(1))
                {
                    var key = d.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
                    daily.Add(new SalesDayPoint(key, byDay.GetValueOrDefault(key)));
                }

                // The financial year, every month from April to the one shown,
                // whether or not anything was sold or set in it.
                var fyMonths = new List<SalesMonthPoint>();
                for (var d = fyStart; d <= month; d = d.AddMonths(1))
                    fyMonths.Add(new SalesMonthPoint(d.Year, d.Month, targets.GetValueOrDefault((d.Year, d.Month)), byMonth.GetValueOrDefault((d.Year, d.Month))));

                var target = targets.GetValueOrDefault((month.Year, month.Month));
                var projected = daysCounted > 0 ? Math.Round(achieved / daysCounted * daysInMonth) : 0;

                return new SalesDashboard(
                    userId, username, name,
                    month.ToString("yyyy-MM", CultureInfo.InvariantCulture),
                    from.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
                    through.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
                    daysCounted, daysInMonth,
                    target, achieved, prevToDate, prevTotal, projected,
                    patients, centres.Count, centres.Count(c => c.C.Month > 0),
                    daily,
                    fyLabel, fyMonths.Sum(m => m.Target), fyMonths.Sum(m => m.Achieved), fyMonths,
                    TopCentres: centres.Where(c => c.C.Month > 0).OrderByDescending(c => c.C.Month).Take(10).Select(c => c.C).ToList(),
                    // Bought last month, nothing this month: the calls to make.
                    SilentCentres: centres.Where(c => c.C.Month == 0 && c.C.PrevMonth > 0).OrderByDescending(c => c.C.PrevMonth).Take(10).Select(c => c.C).ToList(),
                    NewCentres: centres.Where(c => c.IsNew).OrderByDescending(c => c.C.Month).Take(10).Select(c => c.C).ToList());
            }, token), ct).ConfigureAwait(false);
    }

    /// <summary>Every active salesperson's month, for the team list.</summary>
    public async Task<IReadOnlyList<SalesTeamRow>> GetTeamAsync(string? monthIso, CancellationToken ct = default)
    {
        var today = NobleTime.NowForNoble().Date;
        var month = ParseMonth(monthIso) ?? new DateTime(today.Year, today.Month, 1);
        var toX = month.AddMonths(1) <= today.AddDays(1) ? month.AddMonths(1) : today.AddDays(1);

        return await retry.ExecuteAsync("sales.team", token =>
            db.QueryAsync("sales.team", async (conn, inner) =>
            {
                await using var cmd = NobleConnectionFactory.CreateCommand(conn, $"""
                    SET NOCOUNT ON;
                    -- The month's lines once, by centre; then each salesperson
                    -- sums the centres in its territory. A centre mapped to two
                    -- people counts for both, as the LIS's own report counts it.
                    WITH mt AS (
                        SELECT p.mcc_code, SUM(t.test_rate) AS amt, COUNT(DISTINCT t.patient_id) AS patients
                        FROM dbo.tbl_med_mcc_patient_tests t
                        JOIN dbo.tbl_med_mcc_patient_master p ON p.id = t.patient_id
                        WHERE t.amount_checked = 1 AND t.updateddate >= @from AND t.updateddate < @toX
                        GROUP BY p.mcc_code
                    )
                    SELECT u.id, u.Username,
                           LTRIM(RTRIM(ISNULL(u.firstname, '') + ' ' + ISNULL(u.lastname, ''))) AS name,
                           ut.Name AS type,
                           COUNT(DISTINCT m.mcc_code) AS centres,
                           ISNULL(SUM(mt.amt), 0) AS achieved,
                           ISNULL(SUM(mt.patients), 0) AS patients,
                           ISNULL((SELECT MAX(g.target) FROM dbo.tbl_med_sales_user_target g
                                   WHERE g.user_id = u.id AND g.year = @y AND g.month = @m), 0) AS target
                    FROM dbo.tbl_med_user_master u
                    LEFT JOIN dbo.tbl_med_usertypes ut ON ut.id = u.usertypeid
                    JOIN dbo.tbl_med_user_sales_mcc_mapping m ON m.user_id = u.id AND m.mcc_code IS NOT NULL
                    LEFT JOIN mt ON mt.mcc_code = m.mcc_code
                    WHERE u.usertypeid IN ({SalesTypes}) AND u.IsActive = 1
                    GROUP BY u.id, u.Username, u.firstname, u.lastname, ut.Name
                    ORDER BY achieved DESC, u.Username;
                    """);
                cmd.CommandTimeout = 60;
                cmd.Parameters.Add("@from", SqlDbType.DateTime).Value = month;
                cmd.Parameters.Add("@toX", SqlDbType.DateTime).Value = toX;
                cmd.Parameters.Add("@y", SqlDbType.Int).Value = month.Year;
                cmd.Parameters.Add("@m", SqlDbType.Int).Value = month.Month;

                var rows = new List<SalesTeamRow>();
                await using var reader = await cmd.ExecuteReaderAsync(inner).ConfigureAwait(false);
                while (await reader.ReadAsync(inner).ConfigureAwait(false))
                {
                    var name = reader.Str("name");
                    rows.Add(new SalesTeamRow(
                        reader.Int("id"), reader.Str("Username") ?? "", string.IsNullOrWhiteSpace(name) ? null : name,
                        reader.Str("type"), reader.Int("centres"), reader.Dec("target"), reader.Dec("achieved"), reader.Int("patients")));
                }
                return (IReadOnlyList<SalesTeamRow>)rows;
            }, token), ct).ConfigureAwait(false);
    }

    /// <summary>
    /// Set a salesperson's target for one month, in the LIS's own table, so the
    /// LIS and Infinity read one figure. False when the user is not a
    /// salesperson (no such user, or not a sales type).
    /// </summary>
    public async Task<bool> SetTargetAsync(int userId, int year, int month, decimal target, int by, CancellationToken ct = default)
    {
        // The LIS's columns are integers: whole rupees, and the setter's user id.
        return await retry.ExecuteAsync("sales.target.set", token =>
            db.QueryAsync("sales.target.set", async (conn, inner) =>
            {
                await using var cmd = NobleConnectionFactory.CreateCommand(conn, $"""
                    SET NOCOUNT ON;
                    IF NOT EXISTS (SELECT 1 FROM dbo.tbl_med_user_master u WHERE u.id = @uid AND u.usertypeid IN ({SalesTypes}))
                    BEGIN SELECT CAST(0 AS BIT) AS ok; RETURN; END

                    IF EXISTS (SELECT 1 FROM dbo.tbl_med_sales_user_target WHERE user_id = @uid AND year = @y AND month = @m)
                        UPDATE dbo.tbl_med_sales_user_target
                           SET target = @target, updatedby = @by, updatedbydate = GETDATE()
                         WHERE user_id = @uid AND year = @y AND month = @m;
                    ELSE
                        INSERT INTO dbo.tbl_med_sales_user_target (user_id, year, month, target, addedby, addedbbydate)
                        VALUES (@uid, @y, @m, @target, @by, GETDATE());

                    SELECT CAST(1 AS BIT) AS ok;
                    """);
                cmd.Parameters.Add("@uid", SqlDbType.Int).Value = userId;
                cmd.Parameters.Add("@y", SqlDbType.Int).Value = year;
                cmd.Parameters.Add("@m", SqlDbType.Int).Value = month;
                cmd.Parameters.Add("@target", SqlDbType.Int).Value = (int)Math.Round(target);
                cmd.Parameters.Add("@by", SqlDbType.Int).Value = by;

                var ok = await cmd.ExecuteScalarAsync(inner).ConfigureAwait(false);
                return ok is bool b && b;
            }, token), ct).ConfigureAwait(false);
    }

    /// <summary>"2026-09" → the first of that month; anything else → null.</summary>
    private static DateTime? ParseMonth(string? iso) =>
        DateTime.TryParseExact(iso, "yyyy-MM", CultureInfo.InvariantCulture, DateTimeStyles.None, out var d) ? d : null;
}
