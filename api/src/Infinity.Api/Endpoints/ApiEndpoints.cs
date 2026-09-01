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

        // The SAME handler twice, behind two gates. Every figure in DayStats is
        // resolved inside the caller's scope, so a client centre reading it
        // sees its own day and nothing else — which is exactly the dashboard
        // Telo shows a client login. The lab-only month totals and
        // leaderboards stay behind analytics:view below.
        app.MapGet("/api/dashboard/my-day", GetStats)
           .RequireAuthorization()
           .RequireCapability(Capabilities.BillingView);

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
        // POST because a page of fifty SIDs does not fit a query string.
        reports.MapPost("/locks", GetReportLocks).WithName("GetReportLocks");
        // The per-sample clinical-history PDF — the LIS's Sample Status upload,
        // living on the Reporting tab here. Stored SID-keyed exactly as the
        // legacy worksheet reads it, so the lab tech sees an Infinity upload
        // through the LIS with no LIS change.
        reports.MapPost("/clinical-history/flags", GetClinicalHistoryFlags).WithName("GetClinicalHistoryFlags");
        reports.MapGet("/{sid}/clinical-history", GetClinicalHistory).WithName("GetClinicalHistory");
        reports.MapPut("/{sid}/clinical-history", PutClinicalHistory).WithName("PutClinicalHistory");
        reports.MapDelete("/{sid}/clinical-history", DeleteClinicalHistory).WithName("DeleteClinicalHistory");
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
        Reports.SmartReportAccessRepository smartAccess,
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
                count = 0, total = 0, patients = 0, page = 1, pageSize, pageCount = 0,
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

        // Which of these patients actually bought the Smart Report. One indexed
        // query for the whole page, so the list can draw that button only where
        // it means something rather than offering everyone a thing most of them
        // have not paid for. Best-effort: if the lookup fails the button simply
        // does not appear, which is the safe direction — the routes behind it
        // enforce the same rule anyway.
        var smartPids = new HashSet<int>();
        try
        {
            smartPids = await smartAccess
                .PidsWithSmartReportAsync(result.Rows.Select(r => r.Pid).ToArray(), ct)
                .ConfigureAwait(false);
        }
        catch (Exception) when (!ct.IsCancellationRequested) { /* no button */ }

        return Results.Ok(new
        {
            rows = result.Rows.Select(r => new
            {
                r.Sid, r.ClientCode, r.BusinessUnit, r.Pid, r.PatientName, r.Sex,
                r.Age, r.AgeUnit, r.SampleDrawn, r.RegisteredAt, r.LastModifiedAt,
                r.StatusCode, r.Status, r.TestNames, r.OrderNumber, r.BillNumber,
                r.ClinicalHistory,
                // The tube and its bench rank — the grouping order both lists
                // draw. An explicit projection swallows new fields silently,
                // which is exactly what happened to these two at first.
                r.SampleType, r.SpecimenRank,
                // WHY a pending sample is pending — the rejection reason or
                // hold note the lab wrote in Sample_Comments.
                r.SampleComments,
                SmartReport = smartPids.Contains(r.Pid),
            }),
            // count is this page; total is the whole filtered set. Both are
            // sent because conflating them is what made the list look truncated.
            count = result.Rows.Count,
            total = result.Total,
            // Distinct patients across the whole filtered set — the second
            // number an operator reconciling a day actually wants.
            patients = result.PatientCount,
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
            // A client account's reports are pinned to its own client code, so
            // a business-unit filter can only ever narrow an already-narrowed
            // set — and the unit list is the lab's internal geography (Agra,
            // Amroha, Dehradun…), which is not a client's to browse. Emptied
            // HERE rather than only hidden in the UI, because the filter panel
            // is not the only way to read this response.
            businessUnits = principal.Role() == InfinityRoles.Client
                ? Array.Empty<LookupItem>()
                : o.BusinessUnits,
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
        Infinity.Api.Reports.ReportLockRepository locks,
        Audit.AuditLog audit,
        HttpContext http,
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

        /*
         * The balance lock gates the VIEW, not just the download. It always
         * did in Telo — "a report cannot be viewed or printed while there is
         * an outstanding balance" — but Infinity only checked it on the PDF
         * routes, so a held report was still fully readable on screen and the
         * hold amounted to an inconvenience about file format. Same 423 and
         * payload as the PDF gate, same escape hatches (PerminentUnlock, the
         * credit allowance) inside the repository; `message` rides along
         * because this answer reaches a PAGE, whose generic error path shows
         * the code alone otherwise.
         */
        var lockState = await locks.GetAsync(sid, ct).ConfigureAwait(false);
        if (lockState.Locked)
        {
            return Results.Json(new
            {
                error = "BALANCE_LOCKED",
                message = $"This report is on hold: ₹{Math.Round(lockState.DueAmount):N0} outstanding on the "
                        + (lockState.Reason == "client" ? "client account" : "patient's bill")
                        + ". Clear the balance to release it.",
                reason = lockState.Reason,
                dueAmount = lockState.DueAmount,
            }, statusCode: StatusCodes.Status423Locked);
        }

        // Who opened which patient's report — the same event Telo logs, and
        // the reason the audit feed can answer "who has seen this result".
        audit.Log("report.viewed", actor: userId, sid: sid, ip: Audit.AuditIp.From(http));

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

    public sealed record ReportLocksRequest(IReadOnlyList<string>? Sids);

    /// <summary>
    /// Lock states for a page of SIDs, so the list can draw a locked View
    /// button instead of letting the operator open a modal that answers 423.
    /// </summary>
    /// <remarks>
    /// Advisory only — the 423 on the view, smart and PDF routes remains the
    /// enforcement, and this endpoint could vanish without a report leaking.
    /// Out-of-scope and unknown SIDs are silently omitted rather than erroring,
    /// for the same reason the view route folds them into 404: lock state must
    /// not be a way to probe that a SID exists. Only LOCKED sids come back;
    /// absence means unlocked, which keeps the payload the size of the problem
    /// rather than the page. Each SID rides the repository's 60-second cache,
    /// so the page load and the clicks that follow share one computation.
    /// </remarks>
    private static async Task<IResult> GetReportLocks(
        ReportLocksRequest body,
        System.Security.Claims.ClaimsPrincipal principal,
        ScopeRepository scopes,
        SampleHeaderRepository headers,
        Infinity.Api.Reports.ReportLockRepository locks,
        CancellationToken ct)
    {
        if (principal.UserId() is not int userId) return Results.Unauthorized();

        // Cap slightly above the page size: this exists to serve one page of
        // fifty, and an unbounded list would let one request fan out into
        // thousands of header lookups against the live LIS database.
        var sids = (body.Sids ?? [])
            .Where(s => !string.IsNullOrWhiteSpace(s) && s.Trim().Length <= 50)
            .Select(s => s.Trim())
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .Take(60)
            .ToList();

        var found = new Dictionary<string, object>(capacity: 4);
        if (sids.Count == 0) return Results.Ok(new { locks = found });

        var scope = await scopes.GetReportClientCodesAsync(userId, principal.Role(), ct).ConfigureAwait(false);
        if (scope.IsDenied) return Results.Ok(new { locks = found });
        var allowed = scope.IsUnrestricted
            ? null
            : new HashSet<string>(scope.ClientCodes, StringComparer.OrdinalIgnoreCase);

        foreach (var sid in sids)
        {
            var header = await headers.GetAsync(sid, ct).ConfigureAwait(false);
            if (header is null) continue;
            if (allowed is not null && (header.ClientCode is null || !allowed.Contains(header.ClientCode))) continue;

            var state = await locks.GetAsync(sid, ct).ConfigureAwait(false);
            if (state.Locked) found[sid] = new { reason = state.Reason, dueAmount = state.DueAmount };
        }

        return Results.Ok(new { locks = found });
    }

    /* ---------------------------------------------------------------------
     * The per-sample clinical-history PDF — the LIS's Sample Status upload
     * (Pcc/SampleStatus.aspx), ported onto the Reporting tab. A centre
     * attaches context to a sample it already sent; the lab tech opens it
     * from the worksheet. Stored SID-keyed in the exact shape the legacy
     * worksheet's clihis.ashx reads, so the two systems see one file.
     * ------------------------------------------------------------------- */

    public sealed record ClinicalHistoryFlagsRequest(IReadOnlyList<string>? Sids);
    public sealed record ClinicalHistorySetRequest(string? FileBase64);

    /// <summary>Is this SID inside the caller's report scope? Null when not.</summary>
    private static async Task<SampleHeader?> InReportScopeAsync(
        int userId,
        System.Security.Claims.ClaimsPrincipal principal,
        ScopeRepository scopes,
        SampleHeaderRepository headers,
        string sid,
        CancellationToken ct)
    {
        var scope = await scopes.GetReportClientCodesAsync(userId, principal.Role(), ct).ConfigureAwait(false);
        if (scope.IsDenied) return null;
        var header = await headers.GetAsync(sid, ct).ConfigureAwait(false);
        if (header is null) return null;
        if (!scope.IsUnrestricted
            && !scope.ClientCodes.Contains(header.ClientCode ?? "", StringComparer.OrdinalIgnoreCase))
        {
            return null;
        }
        return header;
    }

    /// <summary>Which of a page's SIDs carry an attached history PDF.</summary>
    private static async Task<IResult> GetClinicalHistoryFlags(
        ClinicalHistoryFlagsRequest body,
        System.Security.Claims.ClaimsPrincipal principal,
        ScopeRepository scopes,
        Reports.ClinicalHistoryRepository clihis,
        CancellationToken ct)
    {
        if (principal.UserId() is not int userId) return Results.Unauthorized();

        var sids = (body.Sids ?? [])
            .Where(s => !string.IsNullOrWhiteSpace(s) && s.Trim().Length <= 50)
            .Select(s => s.Trim())
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .Take(60)
            .ToList();
        if (sids.Count == 0) return Results.Ok(new { sids = Array.Empty<string>() });

        // Existence only — no per-SID header lookups. A flag leaks nothing a
        // scoped list has not already shown, and the file itself stays behind
        // the scope-checked GET below.
        var scope = await scopes.GetReportClientCodesAsync(userId, principal.Role(), ct).ConfigureAwait(false);
        if (scope.IsDenied) return Results.Ok(new { sids = Array.Empty<string>() });

        var found = await clihis.ExistsManyAsync(sids, ct).ConfigureAwait(false);
        return Results.Ok(new { sids = found.ToArray() });
    }

    private static async Task<IResult> GetClinicalHistory(
        string sid,
        System.Security.Claims.ClaimsPrincipal principal,
        ScopeRepository scopes,
        SampleHeaderRepository headers,
        Reports.ClinicalHistoryRepository clihis,
        CancellationToken ct)
    {
        if (principal.UserId() is not int userId) return Results.Unauthorized();
        if (string.IsNullOrWhiteSpace(sid) || sid.Length > 50) return Results.NotFound();

        if (await InReportScopeAsync(userId, principal, scopes, headers, sid.Trim(), ct)
                .ConfigureAwait(false) is null)
        {
            return Results.NotFound();
        }

        var bytes = await clihis.GetAsync(sid.Trim(), ct).ConfigureAwait(false);
        if (bytes is null) return Results.NotFound();
        // Magic bytes on the way out: this column has held non-PDF content in
        // its long life, and mislabelling it as PDF just breaks the viewer.
        var isPdf = bytes.Length > 4 && bytes[0] == 0x25 && bytes[1] == 0x50 && bytes[2] == 0x44 && bytes[3] == 0x46;
        return Results.File(bytes,
            isPdf ? "application/pdf" : "application/octet-stream",
            $"clinical-history-{sid.Trim()}{(isPdf ? ".pdf" : ".bin")}");
    }

    private static async Task<IResult> PutClinicalHistory(
        string sid,
        ClinicalHistorySetRequest body,
        System.Security.Claims.ClaimsPrincipal principal,
        ScopeRepository scopes,
        SampleHeaderRepository headers,
        Reports.ClinicalHistoryRepository clihis,
        Audit.AuditLog audit,
        HttpContext http,
        CancellationToken ct)
    {
        if (principal.UserId() is not int userId) return Results.Unauthorized();
        if (string.IsNullOrWhiteSpace(sid) || sid.Length > 50) return Results.NotFound();

        // Size gate BEFORE decoding — base64 inflates by a third. Same 10 MB
        // cap as the order form's PDF, so the same file passes both doors.
        var b64 = body.FileBase64 ?? "";
        if (b64.Length == 0) return Results.BadRequest(new { error = "A PDF is required." });
        if (b64.Length / 4 * 3 > Infinity.Api.Orders.OrderWriteRepository.ClinicalFileMaxBytes)
            return Results.BadRequest(new { error = "The clinical history PDF is larger than 10 MB." });

        byte[] bytes;
        try { bytes = Convert.FromBase64String(b64); }
        catch (FormatException) { return Results.BadRequest(new { error = "The file could not be read." }); }
        if (bytes.Length < 5 || bytes[0] != 0x25 || bytes[1] != 0x50 || bytes[2] != 0x44 || bytes[3] != 0x46)
            return Results.BadRequest(new { error = "Only PDF files can be attached." });

        if (await InReportScopeAsync(userId, principal, scopes, headers, sid.Trim(), ct)
                .ConfigureAwait(false) is null)
        {
            return Results.NotFound();
        }

        var (ok, error) = await clihis.SetAsync(sid.Trim(), bytes, userId, ct).ConfigureAwait(false);
        if (!ok) return Results.BadRequest(new { error = error ?? "The file could not be attached." });

        audit.Log("report.clinical_history.set", actor: userId, sid: sid.Trim(), ip: Audit.AuditIp.From(http));
        return Results.Ok(new { ok = true });
    }

    private static async Task<IResult> DeleteClinicalHistory(
        string sid,
        System.Security.Claims.ClaimsPrincipal principal,
        ScopeRepository scopes,
        SampleHeaderRepository headers,
        Reports.ClinicalHistoryRepository clihis,
        Audit.AuditLog audit,
        HttpContext http,
        CancellationToken ct)
    {
        if (principal.UserId() is not int userId) return Results.Unauthorized();
        if (string.IsNullOrWhiteSpace(sid) || sid.Length > 50) return Results.NotFound();

        if (await InReportScopeAsync(userId, principal, scopes, headers, sid.Trim(), ct)
                .ConfigureAwait(false) is null)
        {
            return Results.NotFound();
        }

        var (ok, error) = await clihis.DeleteAsync(sid.Trim(), userId, ct).ConfigureAwait(false);
        if (!ok) return Results.BadRequest(new { error = error ?? "The file could not be removed." });
        audit.Log("report.clinical_history.delete", actor: userId, sid: sid.Trim(), ip: Audit.AuditIp.From(http));
        return Results.Ok(new { ok = true });
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
        Reports.SmartReportAccessRepository smartAccess,
        Reports.ReportExtrasRepository extras,
        Reports.ReportLink links,
        ILoggerFactory loggers,
        Reports.ReportLockRepository locks,
        CancellationToken ct)
    {
        if (principal.UserId() is not int userId) return Results.Unauthorized();
        if (string.IsNullOrWhiteSpace(sid) || sid.Length > 50) return Results.BadRequest(new { error = "A SID is required." });

        var scope = await scopes.GetReportClientCodesAsync(userId, principal.Role(), ct).ConfigureAwait(false);
        if (scope.IsDenied) return Results.NotFound();

        var row = await repo.GetBySidAsync(scope.ClientCodes, sid, ct).ConfigureAwait(false);
        if (row is null) return Results.NotFound();

        /*
         * The balance lock gates the VIEW, not just the download. It always
         * did in Telo — "a report cannot be viewed or printed while there is
         * an outstanding balance" — but Infinity only checked it on the PDF
         * routes, so a held report was still fully readable on screen and the
         * hold amounted to an inconvenience about file format. Same 423 and
         * payload as the PDF gate, same escape hatches (PerminentUnlock, the
         * credit allowance) inside the repository; `message` rides along
         * because this answer reaches a PAGE, whose generic error path shows
         * the code alone otherwise.
         */
        var lockState = await locks.GetAsync(sid, ct).ConfigureAwait(false);
        if (lockState.Locked)
        {
            return Results.Json(new
            {
                error = "BALANCE_LOCKED",
                message = $"This report is on hold: ₹{Math.Round(lockState.DueAmount):N0} outstanding on the "
                        + (lockState.Reason == "client" ? "client account" : "patient's bill")
                        + ". Clear the balance to release it.",
                reason = lockState.Reason,
                dueAmount = lockState.DueAmount,
            }, statusCode: StatusCodes.Status423Locked);
        }

        // The paid gate. 404, not 403: whether a particular patient bought a
        // ₹99 extra is not something this route should confirm to someone who
        // did not, and "no such thing here" is the honest answer for a report
        // that was never purchased. The hidden button on the list is courtesy;
        // this is the rule.
        if (!await smartAccess.SidHasSmartReportAsync(sid, ct).ConfigureAwait(false))
            return Results.NotFound();

        // The booklet is signed too. It is a lab document a patient keeps, and
        // "never render a report without a sign" does not stop being true
        // because the reader is not a doctor. Same gate as the clinical sheet.
        var signoff = await Reports.ReportSignoff
            .RequireAsync(extras, row.Sid, loggers, ct).ConfigureAwait(false);
        if (signoff.Refusal is not null) return signoff.Refusal;

        return Results.Ok(smart.Build(
            row, signoff.Extras!, links.QrDataUrl(row.Sid), DateTimeOffset.UtcNow));
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
