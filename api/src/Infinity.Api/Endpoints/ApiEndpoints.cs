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

        // Separate from the day stats on purpose: it aggregates a month of
        // bills and their test lines on a database the live LIS is also
        // serving, so the day KPIs must never wait behind it.
        app.MapGet("/api/dashboard/month", GetMonthStats)
           .RequireAuthorization()
           .RequireCapability(Capabilities.AnalyticsView)
           .WithName("GetDashboardMonthStats");

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

        orders.MapGet("/catalog", SearchCatalog)
              .RequireCapability(Capabilities.OrderView)
              .WithName("SearchCatalog");

        reports.MapGet("/", ListReports).WithName("ListReports");
        reports.MapGet("/filters", ListFilterOptions).WithName("ListWorksheetFilters");
        // Typeahead for the two lists that used to travel inside /filters.
        // Same scope rule as everything else: they read the caller's own
        // cached filter payload, so a client can only ever search its own.
        reports.MapGet("/clients/search", SearchFilterClients).WithName("SearchFilterClients");
        reports.MapGet("/tests/search", SearchFilterTests).WithName("SearchFilterTests");
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

    /// <summary>
    /// Month-to-date totals and the three leaderboards, in the caller's scope.
    /// </summary>
    /// <param name="date">
    /// The selected day, <c>yyyy-MM-dd</c>. The month reported is the one
    /// containing it, so the two halves of the dashboard can never describe
    /// different periods. Defaults to today; a future date falls back to the
    /// current month rather than returning a period the caller cannot explain.
    /// </param>
    private static async Task<IResult> GetMonthStats(
        System.Security.Claims.ClaimsPrincipal principal,
        ScopeRepository scopes,
        MonthStatsRepository months,
        CancellationToken ct,
        string? date = null)
    {
        if (principal.UserId() is not int userId) return Results.Unauthorized();

        var scope = await scopes.GetScopeAsync(userId, ct).ConfigureAwait(false);
        var result = await months.GetAsync(scope, date, ct).ConfigureAwait(false);

        return Results.Ok(new { month = result });
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
        // ---- the rest of the legacy worksheet's filter set ----
        int? fromHour = null,
        int? toHour = null,
        int? pid = null,
        string? clientCode = null,
        int? departmentId = null,
        int? businessUnitId = null,
        string? testCode = null,
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

        // Note there is no TAT filter. The LIS shows a TAT checkbox and passes
        // it into usp_worksheet_sample02072020, which never references it — the
        // control has no effect there, and reproducing it would only convince
        // an operator they had filtered when they had not.
        var filters = new WorksheetFilters(
            FromHour: fromHour,
            ToHour: toHour,
            Pid: pid,
            ClientCode: clientCode,
            DepartmentId: departmentId,
            BusinessUnitId: businessUnitId,
            TestCode: testCode);

        var result = await repo.ListPageAsync(
            scope.ClientCodes, fromDate, toDate, patient, sid, statuses, filters,
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
    /// The test catalogue priced for one client.
    ///
    /// The MCC is checked against the caller's operational scope before pricing
    /// anything. Rates are commercially sensitive — what one client negotiated
    /// is not something another client's account should be able to read by
    /// putting their MCC id in a query string.
    /// </summary>
    private static async Task<IResult> SearchCatalog(
        System.Security.Claims.ClaimsPrincipal principal,
        ScopeRepository scopes,
        CatalogRepository repo,
        CancellationToken ct,
        int? mcc = null,
        string? search = null,
        string? kind = null,
        int page = 1,
        int pageSize = 100)
    {
        if (principal.UserId() is not int userId) return Results.Unauthorized();

        if (mcc is int requested)
        {
            // Membership, not `Count > 0 &&`. GetScopeAsync returns an explicit
            // list of ids, so an empty one means no clients rather than all of
            // them — see the note in OrderEntryEndpoints.
            var scope = await scopes.GetScopeAsync(userId, ct).ConfigureAwait(false);
            if (!scope.Contains(requested)) return Results.NotFound();
        }

        var result = await repo.SearchAsync(mcc, search, kind, page, pageSize, ct).ConfigureAwait(false);

        return Results.Ok(new
        {
            rows = result.Rows,
            count = result.Rows.Count,
            total = result.Total,
            page = result.Page,
            pageSize = result.PageSize,
            pageCount = result.PageCount,
        });
    }

    /// <summary>
    /// Option lists for the worklist's dropdowns.
    ///
    /// Scoped with the same report scope the worklist itself uses, so the
    /// client-code list can never name a centre whose samples the caller could
    /// not open anyway.
    /// </summary>
    /// <summary>
    /// How long a filter payload is reused. These are the lab's reference
    /// lists - centres, departments, business units, the test catalogue - and
    /// they change when someone opens an admin screen, not while a
    /// technologist works.
    /// </summary>
    private static readonly TimeSpan FilterOptionsTtl = TimeSpan.FromMinutes(10);

    /// <summary>Matches what the framework would produce: camelCase.</summary>
    private static readonly System.Text.Json.JsonSerializerOptions WebJson =
        new(System.Text.Json.JsonSerializerDefaults.Web);

    /// <summary>A typeahead answers with a screenful, not a catalogue.</summary>
    private const int SearchLimit = 25;

    /*
     * ONE cached payload, three endpoints projecting from it.
     *
     * The underlying procedure returns everything in one round trip and took
     * 4.8s for 349 KB. Rather than split it into three queries, it is fetched
     * at most once per TTL and the searches filter the cached lists in memory:
     * one slow query per ten minutes instead of one per page load, and a
     * typeahead that answers without touching the database at all.
     *
     * Keyed on SCOPE, not user - the payload is a function of which client
     * codes the caller may see, so unrestricted staff share one entry while
     * each client keeps its own. That is also what makes the searches safe
     * without a scope check of their own: a client's cache entry contains
     * only its own codes, so there is nothing else in it to find.
     */
    private static async Task<WorksheetFilterOptions?> CachedFilterOptionsAsync(
        System.Security.Claims.ClaimsPrincipal principal,
        ScopeRepository scopes,
        ReportsRepository repo,
        Caching.InfinityCache cache,
        CancellationToken ct)
    {
        if (principal.UserId() is not int userId) return null;

        var scope = await scopes.GetReportClientCodesAsync(userId, principal.Role(), ct).ConfigureAwait(false);
        // Denied is a constant, and giving it a cache key would let a scope
        // change be masked by a stale hit.
        if (scope.IsDenied) return new WorksheetFilterOptions([], [], [], []);

        var scopeKey = scope.IsUnrestricted
            ? "all"
            : string.Join(",", scope.ClientCodes.OrderBy(c => c, StringComparer.Ordinal));
        var key = "inf:filters:" + Convert.ToHexString(
            System.Security.Cryptography.SHA256.HashData(
                System.Text.Encoding.UTF8.GetBytes(scopeKey)))[..16];

        var hit = await cache.GetAsync(key, ct).ConfigureAwait(false);
        if (hit is not null)
        {
            var cached = System.Text.Json.JsonSerializer
                .Deserialize<WorksheetFilterOptions>(hit, WebJson);
            if (cached is not null) return cached;
        }

        var options = await repo.GetFilterOptionsAsync(scope.ClientCodes, ct).ConfigureAwait(false);
        await cache.SetAsync(key, System.Text.Json.JsonSerializer.Serialize(options, WebJson),
                             FilterOptionsTtl, ct).ConfigureAwait(false);
        return options;
    }

    /*
     * The SMALL half: departments and business units only.
     *
     * The client codes (3,624) and the test catalogue (1,459) used to travel
     * here too, making this 349 KB on every page load of the worksheet,
     * reporting and the order form. They are typeahead-searched now, so what
     * is left is two bounded reference lists that a dropdown can hold.
     */
    private static async Task<IResult> ListFilterOptions(
        System.Security.Claims.ClaimsPrincipal principal,
        ScopeRepository scopes,
        ReportsRepository repo,
        Caching.InfinityCache cache,
        CancellationToken ct)
    {
        var o = await CachedFilterOptionsAsync(principal, scopes, repo, cache, ct).ConfigureAwait(false);
        if (o is null) return Results.Unauthorized();

        return Results.Ok(new
        {
            departments = o.Departments,
            businessUnits = o.BusinessUnits,
            // Counts, so a screen can say "3,624 centres" without listing them,
            // and so a caller can tell an empty scope from an unfetched one.
            clientCodeCount = o.ClientCodes.Count,
            testCount = o.Tests.Count,
        });
    }

    /// <summary>Centres matching a typed fragment, within the caller's scope.</summary>
    private static async Task<IResult> SearchFilterClients(
        System.Security.Claims.ClaimsPrincipal principal,
        ScopeRepository scopes,
        ReportsRepository repo,
        Caching.InfinityCache cache,
        CancellationToken ct,
        string? q = null,
        string? selected = null)
    {
        var o = await CachedFilterOptionsAsync(principal, scopes, repo, cache, ct).ConfigureAwait(false);
        if (o is null) return Results.Unauthorized();

        var needle = (q ?? string.Empty).Trim();
        var rows = o.ClientCodes
            .Where(c => needle.Length == 0
                     || c.Code.Contains(needle, StringComparison.OrdinalIgnoreCase)
                     || (c.Name ?? string.Empty).Contains(needle, StringComparison.OrdinalIgnoreCase))
            .Take(SearchLimit)
            .ToList();

        /* The currently-selected code, even when it does not match the query.
           Without this the control blanks its own value the moment someone
           types: the selection is only a string, and its label lives in the
           option list. */
        if (!string.IsNullOrWhiteSpace(selected)
            && !rows.Any(r => string.Equals(r.Code, selected, StringComparison.OrdinalIgnoreCase)))
        {
            var pinned = o.ClientCodes.FirstOrDefault(
                c => string.Equals(c.Code, selected, StringComparison.OrdinalIgnoreCase));
            if (pinned is not null) rows.Insert(0, pinned);
        }

        return Results.Ok(new { rows, total = o.ClientCodes.Count });
    }

    /// <summary>Tests matching a typed fragment. Not scoped: the catalogue is the lab's.</summary>
    private static async Task<IResult> SearchFilterTests(
        System.Security.Claims.ClaimsPrincipal principal,
        ScopeRepository scopes,
        ReportsRepository repo,
        Caching.InfinityCache cache,
        CancellationToken ct,
        string? q = null,
        string? selected = null)
    {
        var o = await CachedFilterOptionsAsync(principal, scopes, repo, cache, ct).ConfigureAwait(false);
        if (o is null) return Results.Unauthorized();

        var needle = (q ?? string.Empty).Trim();
        var rows = o.Tests
            .Where(t => needle.Length == 0
                     || t.Code.Contains(needle, StringComparison.OrdinalIgnoreCase)
                     || (t.Name ?? string.Empty).Contains(needle, StringComparison.OrdinalIgnoreCase))
            .Take(SearchLimit)
            .ToList();

        if (!string.IsNullOrWhiteSpace(selected)
            && !rows.Any(r => string.Equals(r.Code, selected, StringComparison.OrdinalIgnoreCase)))
        {
            var pinned = o.Tests.FirstOrDefault(
                t => string.Equals(t.Code, selected, StringComparison.OrdinalIgnoreCase));
            if (pinned is not null) rows.Insert(0, pinned);
        }

        return Results.Ok(new { rows, total = o.Tests.Count });
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

    /// <summary>
    /// One sample's full report: the header, the results, and everything around
    /// them that gets printed.
    /// </summary>
    /// <remarks>
    /// The extras — collection centre, processing unit, signatories, profile
    /// interpretations — ride along on this response rather than sitting behind
    /// a second route, because the only caller that needs them is the print
    /// route, and that page is being photographed by a headless browser. A
    /// second round trip there is another window in which the render can settle
    /// early and produce a report with no signature on it.
    ///
    /// They are fetched only AFTER the row is found and scope has been
    /// satisfied, so an out-of-scope SID costs one query and reveals nothing.
    /// </remarks>
    private static async Task<IResult> GetReport(
        string sid,
        System.Security.Claims.ClaimsPrincipal principal,
        ScopeRepository scopes,
        ReportsRepository repo,
        Infinity.Api.Reports.ReportExtrasRepository extras,
        Infinity.Api.Reports.CatalogueDetailRepository catalogue,
        Infinity.Api.Reports.ReportLink links,
        ILoggerFactory loggers,
        CancellationToken ct)
    {
        if (principal.UserId() is not int userId) return Results.Unauthorized();
        if (string.IsNullOrWhiteSpace(sid) || sid.Length > 50) return Results.BadRequest(new { error = "A SID is required." });

        var scope = await scopes.GetReportClientCodesAsync(userId, principal.Role(), ct).ConfigureAwait(false);
        // Denied and not-found are the same 404: a user with no report scope
        // must not be able to tell whether a SID exists.
        if (scope.IsDenied) return Results.NotFound();

        var row = await repo.GetBySidAsync(scope.ClientCodes, sid, ct).ConfigureAwait(false);
        if (row is null) return Results.NotFound();

        // No signatory, no report. This used to fall back to printing the sheet
        // bare on the reasoning that a document someone is waiting on beats a
        // failed request; that reasoning was wrong, and see ReportSignoff for
        // what it cost. A refusal is loud and fixable. An unsigned report is
        // neither, because it looks finished.
        var signoff = await Infinity.Api.Reports.ReportSignoff
            .RequireAsync(extras, row.Sid, loggers, ct).ConfigureAwait(false);
        if (signoff.Refusal is not null) return signoff.Refusal;
        var more = signoff.Extras!;

        // The age-narrowed range and the interpretation graphs. Best-effort, in
        // the same spirit as the extras above.
        var results = await Infinity.Api.Reports.ReportEnrichment
            .ApplyAsync(catalogue, row, ct).ConfigureAwait(false);

        return Results.Ok(new
        {
            row.Sid, row.ClientCode, row.BusinessUnit, row.Pid, row.PatientName, row.Sex,
            row.Age, row.AgeUnit, row.SampleDrawn, row.RegisteredAt, row.LastModifiedAt,
            row.StatusCode, row.Status, row.TestNames, row.OrderNumber, row.BillNumber,
            row.ClinicalHistory, Results = results, row.RefDoctor, row.RefCustomer, row.PassportNo,
            row.Dob,
            more.CollectedAt,
            more.ProcessedAt,
            more.Signers,
            more.ProfileInterpretations,
            // Null unless a secret and a public base URL are both configured,
            // which is what keeps the patient link off a deployment that has
            // not been set up to serve one.
            Qr = links.QrDataUrl(row.Sid),
        });
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
        System.Security.Claims.ClaimsPrincipal principal,
        ScopeRepository scopes,
        SampleHeaderRepository repo,
        CancellationToken ct)
    {
        if (principal.UserId() is not int userId) return Results.Unauthorized();

        if (string.IsNullOrWhiteSpace(sid) || sid.Length > 50)
        {
            return Results.BadRequest(new { error = "A SID of 1-50 characters is required." });
        }

        var scope = await scopes.GetReportClientCodesAsync(userId, principal.Role(), ct).ConfigureAwait(false);
        if (scope.IsDenied) return Results.NotFound();

        var header = await repo.GetAsync(sid, ct).ConfigureAwait(false);
        if (header is null) return Results.NotFound();

        /*
         * The scope check the comment below used to promise and never had.
         *
         * This route was gated on patient:view alone, which the CLIENT role
         * holds - so any collection centre could read any patient's name, sex,
         * age, owning centre and status by asking for the SID. Found by
         * sweeping every route with a client token (G40), not by reading the
         * code, which is why the sweep exists.
         *
         * Compared against the code the DATABASE returned, never one supplied
         * by the caller.
         */
        if (!scope.IsUnrestricted
            && !scope.ClientCodes.Contains(header.ClientCode?.Trim() ?? string.Empty,
                                          StringComparer.OrdinalIgnoreCase))
        {
            return Results.NotFound();
        }

        // 404 rather than an empty 200: a missing SID and an out-of-scope SID
        // are indistinguishable to the caller.
        return Results.Ok(header);
    }
}
