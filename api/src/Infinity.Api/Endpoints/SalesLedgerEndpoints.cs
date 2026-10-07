using Infinity.Api.Auth;
using Infinity.Api.Reads;

namespace Infinity.Api.Endpoints;

/// <summary>
/// The company-wide sales ledger and its dashboard (script 181). The lab's
/// money picture, so the lab's roles only: super admin, admin, the Sales
/// Admin and the lab manager. A client sees its own sales on the Sales page;
/// this one lists everyone's, and answers 404 to a client login.
/// </summary>
public static class SalesLedgerEndpoints
{
    public static void MapSalesLedgerEndpoints(this WebApplication app)
    {
        var g = app.MapGroup("/api/sales/ledger").RequireAuthorization().RequireCapability(Capabilities.AnalyticsView);
        g.MapGet("/", Ledger).WithName("GetSalesLedger");
        g.MapGet("/summary", Summary).WithName("GetSalesSummary");
        g.MapGet("/options", Options).WithName("GetSalesLedgerOptions");
    }

    private static bool MaySee(System.Security.Claims.ClaimsPrincipal p) =>
        p.Role() is InfinityRoles.SuperAdmin or InfinityRoles.Admin or InfinityRoles.Sales or InfinityRoles.LabManager;

    private static readonly HashSet<string> Kinds = new(StringComparer.OrdinalIgnoreCase) { "Master", "Profile", "Test", "Extra" };
    private static readonly HashSet<string> Sources = new(StringComparer.OrdinalIgnoreCase) { "lis", "infinity", "telo" };

    private static (SalesLedgerFilter? Filter, IResult? Error) ReadFilter(
        string? from, string? to, string? client, int? bu, string? kind, string? search, string? source)
    {
        var today = StatsRepository.TodayIst();   // yyyy-MM-dd on the lab's clock
        var f = DateTime.TryParse(string.IsNullOrWhiteSpace(from) ? today : from, out var df) ? df.Date : default;
        var t = string.IsNullOrWhiteSpace(to) ? f : DateTime.TryParse(to, out var dt) ? dt.Date : default;
        if (f == default || t == default) return (null, Results.BadRequest(new { error = "from and to are dates (yyyy-mm-dd)." }));
        if (t < f) (f, t) = (t, f);
        if ((t - f).TotalDays > 366) return (null, Results.BadRequest(new { error = "The range can span at most a year." }));
        string? k = null;
        if (!string.IsNullOrWhiteSpace(kind))
        {
            if (!Kinds.Contains(kind.Trim())) return (null, Results.BadRequest(new { error = "kind must be Master, Profile, Test or Extra." }));
            k = char.ToUpperInvariant(kind.Trim()[0]) + kind.Trim()[1..].ToLowerInvariant();
        }
        string? s = null;
        if (!string.IsNullOrWhiteSpace(source))
        {
            if (!Sources.Contains(source.Trim())) return (null, Results.BadRequest(new { error = "source must be lis, infinity or telo." }));
            s = source.Trim().ToLowerInvariant();
        }
        static string? Clip(string? v) => string.IsNullOrWhiteSpace(v) ? null : v.Trim()[..Math.Min(v.Trim().Length, 100)];
        return (new SalesLedgerFilter(f, t, Clip(client), bu, k, Clip(search), s), null);
    }

    private static async Task<IResult> Ledger(
        System.Security.Claims.ClaimsPrincipal principal, SalesLedgerRepository repo, CancellationToken ct,
        string? from = null, string? to = null, string? client = null, int? bu = null, string? kind = null,
        string? search = null, string? source = null, int page = 1, int pageSize = 100)
    {
        if (!MaySee(principal)) return Results.NotFound();
        var (f, err) = ReadFilter(from, to, client, bu, kind, search, source);
        if (err is not null || f is null) return err!;
        var (rows, totals) = await repo.LedgerAsync(f, Math.Max(1, page), Math.Clamp(pageSize, 1, 1000), ct).ConfigureAwait(false);
        return Results.Ok(new { rows, totals, page = Math.Max(1, page), pageSize = Math.Clamp(pageSize, 1, 1000),
                                from = f.From.ToString("yyyy-MM-dd"), to = f.To.ToString("yyyy-MM-dd") });
    }

    private static async Task<IResult> Summary(
        System.Security.Claims.ClaimsPrincipal principal, SalesLedgerRepository repo, CancellationToken ct,
        string? from = null, string? to = null, string? client = null, int? bu = null, string? kind = null,
        string? search = null, string? source = null)
    {
        if (!MaySee(principal)) return Results.NotFound();
        var (f, err) = ReadFilter(from, to, client, bu, kind, search, source);
        if (err is not null || f is null) return err!;
        var s = await repo.SummaryAsync(f, ct).ConfigureAwait(false);
        return Results.Ok(new { s.Totals, s.ByDay, s.ByBusinessUnit, s.ByClient, s.ByKind, s.ByItem, s.BySource, s.ByItemClientRate,
                                from = f.From.ToString("yyyy-MM-dd"), to = f.To.ToString("yyyy-MM-dd") });
    }

    /// <summary>The business units, for the filter.</summary>
    private static async Task<IResult> Options(
        System.Security.Claims.ClaimsPrincipal principal, Data.NobleConnectionFactory db, Data.SqlRetry retry, CancellationToken ct)
    {
        if (!MaySee(principal)) return Results.NotFound();
        var units = await retry.ExecuteAsync("sales.ledger.options", token =>
            db.QueryAsync("sales.ledger.options", async (conn, inner) =>
            {
                await using var cmd = Data.NobleConnectionFactory.CreateCommand(conn,
                    "SELECT id, BusinessUnitCode, BusinessUnitName FROM dbo.tbl_med_business_unit_master ORDER BY BusinessUnitCode");
                var list = new List<object>();
                await using var r = await cmd.ExecuteReaderAsync(inner).ConfigureAwait(false);
                while (await r.ReadAsync(inner).ConfigureAwait(false))
                    list.Add(new { id = r.Int("id"), code = r.Str("BusinessUnitCode"), name = r.Str("BusinessUnitName") });
                return (IReadOnlyList<object>)list;
            }, token), ct).ConfigureAwait(false);
        return Results.Ok(new { businessUnits = units });
    }
}
