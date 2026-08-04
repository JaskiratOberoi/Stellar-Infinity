using Infinity.Api.Auth;
using Infinity.Api.Data;
using Infinity.Api.Reads;

namespace Infinity.Api.Endpoints;

public static class ApiEndpoints
{
    public static void MapInfinityEndpoints(this WebApplication app)
    {
        app.MapGet("/health", Health)
           .WithName("Health")
           .AllowAnonymous();

        var samples = app.MapGroup("/api/samples")
                         .RequireAuthorization();

        samples.MapGet("/{sid}/header", GetSampleHeader)
               .RequireCapability(Capabilities.PatientView)
               .WithName("GetSampleHeader");

        app.MapGet("/api/dashboard/stats", GetStats)
           .RequireAuthorization()
           .RequireCapability(Capabilities.AnalyticsView)
           .WithName("GetDashboardStats");

        app.MapGet("/api/me/scope", GetMyScope)
           .RequireAuthorization()
           .WithName("GetMyScope");

        var orders = app.MapGroup("/api/orders")
                        .RequireAuthorization()
                        .RequireCapability(Capabilities.OrderView);

        orders.MapGet("/", ListOrders).WithName("ListOrders");
        orders.MapGet("/{billId:int}", GetOrder).WithName("GetOrder");

        var reports = app.MapGroup("/api/reports")
                         .RequireAuthorization()
                         .RequireCapability(Capabilities.ReportView);

        reports.MapGet("/", ListReports).WithName("ListReports");
        reports.MapGet("/{sid}", GetReport).WithName("GetReport");
        reports.MapGet("/{sid}/smart", GetSmartReport).WithName("GetSmartReport");
    }

    /// <summary>
    /// Liveness + Noble reachability. Returns 503 with no exception detail —
    /// the reason goes to the log, not to an unauthenticated caller, so a probe
    /// can never be used to fingerprint the database.
    /// </summary>
    private static async Task<IResult> Health(
        NobleConnectionFactory db,
        ILoggerFactory loggerFactory,
        CancellationToken ct)
    {
        try
        {
            var ok = await db.QueryAsync("health.ping", async (conn, inner) =>
            {
                await using var cmd = NobleConnectionFactory.CreateCommand(conn, "SELECT 1");
                cmd.CommandTimeout = 5;
                var result = await cmd.ExecuteScalarAsync(inner).ConfigureAwait(false);
                return Convert.ToInt32(result) == 1;
            }, ct);

            return ok
                ? Results.Ok(new { ok = true, db = "up", maxPoolSize = db.MaxPoolSize })
                : Results.Json(new { ok = false, db = "down" }, statusCode: StatusCodes.Status503ServiceUnavailable);
        }
        catch (Exception ex)
        {
            loggerFactory.CreateLogger("Health").LogError(ex, "health.db.down");
            return Results.Json(new { ok = false, db = "down" }, statusCode: StatusCodes.Status503ServiceUnavailable);
        }
    }

    /// <summary>
    /// Header for one SID.
    ///
    /// Gated on authentication + patient:view. STILL MISSING: the MCC scope
    /// check — which client codes this user may see. Until that lands, any
    /// authenticated user can read any SID's header, so this must not be
    /// exposed to client accounts. Scope belongs here as another endpoint
    /// filter, alongside the capability one.
    /// </summary>
    /// <summary>
    /// Dashboard KPIs for one IST day, scoped to the caller's centres. Scope is
    /// resolved from the token's user id — never from a query parameter — so a
    /// client cannot widen its own view by editing the URL.
    /// </summary>
    private static async Task<IResult> GetStats(
        System.Security.Claims.ClaimsPrincipal principal,
        ScopeRepository scopes,
        StatsRepository stats,
        CancellationToken ct,
        string? date = null)
    {
        if (principal.UserId() is not int userId) return Results.Unauthorized();

        var scope = await scopes.GetScopeAsync(userId, ct).ConfigureAwait(false);
        var result = await stats.GetAsync(scope, date, ct).ConfigureAwait(false);

        return Results.Ok(new { stats = result, centres = scope.Count });
    }

    /// <summary>How many centres the caller can see — lets the UI say so plainly.</summary>
    private static async Task<IResult> GetMyScope(
        System.Security.Claims.ClaimsPrincipal principal,
        ScopeRepository scopes,
        CancellationToken ct)
    {
        if (principal.UserId() is not int userId) return Results.Unauthorized();

        var scope = await scopes.GetScopeAsync(userId, ct).ConfigureAwait(false);

        // Resolved the same way the reporting endpoints do, role included.
        // Reading the raw mapping count here instead would tell an administrator
        // they have zero reporting centres while the worksheet showed them
        // everything — the two answers must come from one resolution.
        var reportScope = await scopes.GetReportClientCodesAsync(userId, principal.Role(), ct).ConfigureAwait(false);

        return Results.Ok(new
        {
            centres = scope.Count,
            reportCentres = reportScope.IsUnrestricted ? (int?)null : reportScope.ClientCodes.Count,
            reportUnrestricted = reportScope.IsUnrestricted,
            reportDenied = reportScope.IsDenied,
            unrestricted = scope.Count > Data.ScopeFilter.UnrestrictedThreshold,
        });
    }

    private static async Task<IResult> ListOrders(
        System.Security.Claims.ClaimsPrincipal principal,
        ScopeRepository scopes,
        OrdersRepository repo,
        CancellationToken ct,
        string? search = null,
        string? from = null,
        string? to = null,
        int page = 1,
        int pageSize = 50)
    {
        if (principal.UserId() is not int userId) return Results.Unauthorized();

        var scope = await scopes.GetScopeAsync(userId, ct).ConfigureAwait(false);
        var result = await repo.ListAsync(scope, search, from, to, page, pageSize, ct).ConfigureAwait(false);

        // Strip money from the list too, not just the detail — a role without
        // billing:view must not read totals off the index page either.
        if (!principal.HasCapability(Capabilities.BillingView))
        {
            result = result with
            {
                Orders = result.Orders.Select(o => o with { Amount = 0, Balance = 0 }).ToArray(),
            };
        }

        return Results.Ok(new { orders = result.Orders, totalCount = result.TotalCount, canSeeMoney = principal.HasCapability(Capabilities.BillingView) });
    }

    private static async Task<IResult> GetOrder(
        int billId,
        System.Security.Claims.ClaimsPrincipal principal,
        ScopeRepository scopes,
        OrdersRepository repo,
        CancellationToken ct)
    {
        if (principal.UserId() is not int userId) return Results.Unauthorized();

        var scope = await scopes.GetScopeAsync(userId, ct).ConfigureAwait(false);
        var order = await repo.GetAsync(billId, scope, ct).ConfigureAwait(false);

        // Out-of-scope and nonexistent both return 404 — distinguishing them
        // would let a client enumerate other clients' bill ids.
        if (order is null) return Results.NotFound();

        var canSeeMoney = principal.HasCapability(Capabilities.BillingView);
        return Results.Ok(new
        {
            order = canSeeMoney ? order : order.WithoutFinancials(),
            canSeeMoney,
        });
    }

    /// <summary>
    /// Worksheet rows for the caller's REPORT scope, which is deliberately a
    /// different resolution from the operational scope used by orders.
    /// </summary>
    private static async Task<IResult> ListReports(
        System.Security.Claims.ClaimsPrincipal principal,
        ScopeRepository scopes,
        ReportsRepository repo,
        CancellationToken ct,
        string? from = null,
        string? to = null,
        string? patient = null,
        string? sid = null,
        int? statusId = null,
        // CSV, e.g. "2,4,5,6". Supersedes statusId, which only ever expressed
        // one status and forced the client to filter the rest itself.
        string? statusIds = null,
        int page = 1,
        int pageSize = 100,
        // Echoed from a previous response to keep paging on one fixed set while
        // the LIS keeps registering samples underneath it.
        string? asOf = null)
    {
        if (principal.UserId() is not int userId) return Results.Unauthorized();

        var scope = await scopes.GetReportClientCodesAsync(userId, principal.Role(), ct).ConfigureAwait(false);
        if (scope.IsDenied)
        {
            return Results.Ok(new
            {
                rows = Array.Empty<object>(),
                count = 0, total = 0, page = 1, pageSize, pageCount = 0,
                scope = "none",
            });
        }

        // Default to the last 7 days: the procedure requires a window, and an
        // unbounded one against a decade of samples is a table scan.
        var toDate = from is null && to is null ? StatsRepository.TodayIst() : to ?? StatsRepository.TodayIst();
        var fromDate = from ?? DateTime.Parse(toDate).AddDays(-7).ToString("yyyy-MM-dd");

        var statuses = ParseStatusIds(statusIds, statusId);

        // An unparseable snapshot falls back to "now" rather than failing: the
        // worst case is a fresh page-one, never a blank screen.
        DateTime? snapshot = DateTimeOffset.TryParse(asOf, out var parsed)
            ? parsed.ToOffset(Domain.NobleTime.IstOffset).DateTime
            : null;

        var result = await repo.ListPageAsync(
            scope.ClientCodes, fromDate, toDate, patient, sid, statuses,
            page, pageSize, snapshot, ct).ConfigureAwait(false);

        return Results.Ok(new
        {
            rows = result.Rows,
            // count is this page; total is the whole filtered set. Both are
            // sent because conflating them is what made the list look truncated.
            count = result.Rows.Count,
            total = result.Total,
            page = result.Page,
            pageSize = result.PageSize,
            pageCount = result.PageCount,
            asOf = result.AsOf,
            scope = scope.IsUnrestricted ? "all" : $"{scope.ClientCodes.Count} centres",
            from = fromDate,
            to = toDate,
        });
    }

    /// <summary>
    /// Status filter from either the CSV form or the legacy single value.
    /// Unparseable entries are dropped rather than failing the request — a
    /// malformed filter should narrow nothing, never blank the worklist.
    /// </summary>
    private static IReadOnlyList<int>? ParseStatusIds(string? csv, int? single)
    {
        if (!string.IsNullOrWhiteSpace(csv))
        {
            var parsed = csv.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                            .Select(s => int.TryParse(s, out var n) ? n : (int?)null)
                            .Where(n => n is not null)
                            .Select(n => n!.Value)
                            .Distinct()
                            .ToArray();
            if (parsed.Length > 0) return parsed;
        }

        return single is int one ? [one] : null;
    }

    private static async Task<IResult> GetReport(
        string sid,
        System.Security.Claims.ClaimsPrincipal principal,
        ScopeRepository scopes,
        ReportsRepository repo,
        CancellationToken ct)
    {
        if (principal.UserId() is not int userId) return Results.Unauthorized();
        if (string.IsNullOrWhiteSpace(sid) || sid.Length > 50) return Results.BadRequest(new { error = "A SID is required." });

        var scope = await scopes.GetReportClientCodesAsync(userId, principal.Role(), ct).ConfigureAwait(false);
        // Denied and not-found are the same 404: a user with no report scope
        // must not be able to tell whether a SID exists.
        if (scope.IsDenied) return Results.NotFound();

        var row = await repo.GetBySidAsync(scope.ClientCodes, sid, ct).ConfigureAwait(false);
        return row is null ? Results.NotFound() : Results.Ok(row);
    }

    /// <summary>
    /// The patient-facing Smart Report for one SID: results grouped by body
    /// system with plain-English explanations and gauges.
    /// </summary>
    private static async Task<IResult> GetSmartReport(
        string sid,
        System.Security.Claims.ClaimsPrincipal principal,
        ScopeRepository scopes,
        ReportsRepository repo,
        Reports.SmartReportService smart,
        CancellationToken ct)
    {
        if (principal.UserId() is not int userId) return Results.Unauthorized();
        if (string.IsNullOrWhiteSpace(sid) || sid.Length > 50) return Results.BadRequest(new { error = "A SID is required." });

        var scope = await scopes.GetReportClientCodesAsync(userId, principal.Role(), ct).ConfigureAwait(false);
        if (scope.IsDenied) return Results.NotFound();

        var row = await repo.GetBySidAsync(scope.ClientCodes, sid, ct).ConfigureAwait(false);
        if (row is null) return Results.NotFound();

        return Results.Ok(smart.Build(row));
    }

    private static async Task<IResult> GetSampleHeader(
        string sid,
        SampleHeaderRepository repo,
        CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(sid) || sid.Length > 50)
        {
            return Results.BadRequest(new { error = "A SID of 1-50 characters is required." });
        }

        var header = await repo.GetAsync(sid, ct).ConfigureAwait(false);

        // 404 rather than an empty 200: a missing SID and an out-of-scope SID
        // should be indistinguishable to the caller once scoping lands.
        return header is null ? Results.NotFound() : Results.Ok(header);
    }
}
