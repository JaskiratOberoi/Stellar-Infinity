using Infinity.Api.Auth;
using Infinity.Api.Domain;
using Infinity.Api.Reads;
using Infinity.Api.Reports;

namespace Infinity.Api.Endpoints;

/// <summary>
/// Downloads: the report as a PDF, a batch of them merged, and the LIS graph
/// attachment on its own.
/// </summary>
/// <remarks>
/// Every route here goes through the same three gates, in the same order, and
/// the order matters: identity, then scope, then the balance lock. Scope before
/// lock means a SID outside your scope is a 404 whatever its balance — asking
/// "is this report locked?" must not be a way to learn that it exists.
/// </remarks>
public static class ReportPdfEndpoints
{
    /// <summary>
    /// A merged download is capped. Not for the renderer's sake — it streams a
    /// batch through a warm browser quite happily — but because a request for a
    /// thousand reports is a mistake, and it should come back as a message
    /// rather than a two-hour wait behind a spinner.
    /// </summary>
    private const int MaxBulkReports = 50;

    public static void MapReportPdfEndpoints(this WebApplication app)
    {
        var reports = app.MapGroup("/api/reports")
                         .RequireAuthorization()
                         .RequireCapability(Capabilities.ReportView);

        reports.MapGet("/{sid}/pdf", GetReportPdf).WithName("GetReportPdf");
        reports.MapGet("/{sid}/smart/pdf", GetSmartPdf).WithName("GetSmartReportPdf");
        reports.MapGet("/{sid}/graph", GetReportGraph).WithName("GetReportGraph");
        reports.MapPost("/pdf/bulk", PostBulkPdf).WithName("GetBulkReportPdf");
    }

    /// <summary>
    /// The patient-facing Smart Report as a PDF.
    /// </summary>
    /// <remarks>
    /// Rendered HEADLESS and unnumbered, unlike every other route here. The
    /// Smart Report is a self-branded booklet with its own cover, so pasting it
    /// onto Noble's clinical letterhead would be wrong twice over — the cover
    /// would sit under someone else's header, and "Page 1 of 9" stamped across
    /// it reads as a lab document rather than something handed to a patient.
    /// Telo draws the same distinction for the same reason.
    ///
    /// No graph stapling either: the LIS graph belongs to the clinical report.
    /// </remarks>
    private static async Task<IResult> GetSmartPdf(
        string sid,
        System.Security.Claims.ClaimsPrincipal principal,
        HttpContext http,
        ScopeRepository scopes,
        ReportsRepository repo,
        ReportLockRepository locks,
        ReportExtrasRepository extras,
        ILoggerFactory loggers,
        SmartReportAccessRepository smartAccess,
        RenderClient render,
        Caching.InfinityCache cache,
        Audit.AuditLog audit,
        CancellationToken ct)
    {
        var (ok, fail, row) = await GateAsync(sid, principal, scopes, repo, locks, extras, loggers, ct).ConfigureAwait(false);
        if (!ok) return fail!;

        // Sold, not given. Same 404 as the data route behind it — see
        // SmartReportAccessRepository.
        if (!await smartAccess.SidHasSmartReportAsync(sid, ct).ConfigureAwait(false))
            return Results.NotFound();

        audit.Log("report.smart_pdf", actor: principal.UserId(), sid: sid, ip: Audit.AuditIp.From(http));

        var key = PdfCacheKey("smart", sid, row!.LastModifiedAt, "-");
        if (await cache.GetBytesAsync(key, ct).ConfigureAwait(false) is { } cached)
        {
            http.Response.Headers["X-Report-Cache"] = "hit";
            return Results.File(cached, "application/pdf", $"HealthSummary_{Sanitise(sid)}.pdf");
        }

        try
        {
            var pdf = await render.RenderAsync(
                [new RenderClient.ReportRequest(
                    Url: $"/print/report/{Uri.EscapeDataString(sid)}/smart",
                    Attachments: null,
                    Headless: true,
                    PageNumbers: false)],
                http.Request.Headers.Cookie.ToString(),
                ct).ConfigureAwait(false);

            await cache.SetBytesAsync(key, pdf, PdfCacheTtl, ct).ConfigureAwait(false);
            http.Response.Headers["X-Report-Cache"] = "miss";
            return Results.File(pdf, "application/pdf", $"HealthSummary_{Sanitise(sid)}.pdf");
        }
        catch (RenderFailedException)
        {
            return Results.Problem("The summary could not be rendered.", statusCode: StatusCodes.Status502BadGateway);
        }
    }

    /// <summary>
    /// The query string the renderer's print route is loaded with.
    /// </summary>
    /// <remarks>
    /// <c>pdf=1</c> always: it is what tells the route to drop the tick boxes
    /// and the letterhead placeholder, and to omit unticked rows outright
    /// rather than dimming them.
    ///
    /// The exclusion list is re-parsed to integers and re-joined rather than
    /// forwarded as given. The result is a URL the render service fetches with
    /// the caller's own session cookie, so a caller-supplied fragment reaching
    /// it unchecked would be theirs to compose — this keeps the only thing that
    /// can appear there to digits and commas.
    /// </remarks>
    private static string PrintQuery(bool? split, string? exclude, bool splitDept = false)
    {
        var ids = (exclude ?? string.Empty)
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(s => int.TryParse(s, out var n) && n > 0 ? n : 0)
            .Where(n => n > 0)
            // A duplicate changes nothing but lengthens a URL that a very wide
            // report can already make long.
            .Distinct()
            .ToArray();

        var q = "?pdf=1";
        if (splitDept) q += "&split=dept";
        else if (split == true) q += "&split=1";
        if (ids.Length > 0) q += "&exclude=" + string.Join(",", ids);
        return q;
    }

    /// <summary>
    /// Identity, scope, balance lock and signatory — or the IResult to return
    /// instead of a report.
    /// </summary>
    /// <param name="requireSignatory">
    /// False only for the graph attachment. That route hands over a
    /// chromatogram the instrument produced, not a report, and there is nothing
    /// on it for a doctor to sign; refusing it because the REPORT cannot be
    /// issued would withhold a file the lab already owns for a reason that has
    /// nothing to do with it. Every route that renders a report leaves this on.
    /// </param>
    private static async Task<(bool Ok, IResult? Fail, Reads.WorksheetRow? Row)> GateAsync(
        string sid,
        System.Security.Claims.ClaimsPrincipal principal,
        ScopeRepository scopes,
        ReportsRepository repo,
        ReportLockRepository locks,
        ReportExtrasRepository extras,
        ILoggerFactory loggers,
        CancellationToken ct,
        bool requireSignatory = true)
    {
        if (principal.UserId() is not int userId)
            return (false, Results.Unauthorized(), null);
        if (string.IsNullOrWhiteSpace(sid) || sid.Length > 50)
            return (false, Results.BadRequest(new { error = "A SID is required." }), null);

        var scope = await scopes.GetReportClientCodesAsync(userId, principal.Role(), ct).ConfigureAwait(false);
        if (scope.IsDenied) return (false, Results.NotFound(), null);

        var row = await repo.GetBySidAsync(scope.ClientCodes, sid, ct).ConfigureAwait(false);
        if (row is null) return (false, Results.NotFound(), null);

        var lockState = await locks.GetAsync(sid, ct).ConfigureAwait(false);
        if (lockState.Locked)
        {
            // 423 Locked, matching Telo. A distinct status rather than 403 so the
            // SPA can say WHY — "clear the balance" is an action the operator can
            // take, where "forbidden" is a dead end.
            return (false, Results.Json(new
            {
                error = "BALANCE_LOCKED",
                reason = lockState.Reason,
                dueAmount = lockState.DueAmount,
            }, statusCode: StatusCodes.Status423Locked), null);
        }

        // Last, and deliberately after the lock: a report with nobody to sign it
        // is not issued at all. Checked HERE rather than inside the print route
        // so the refusal costs one query instead of a headless browser opening a
        // page it must then throw away. See ReportSignoff.
        if (requireSignatory)
        {
            var signoff = await ReportSignoff.RequireAsync(extras, sid, loggers, ct).ConfigureAwait(false);
            if (signoff.Refusal is not null) return (false, signoff.Refusal, null);
        }

        return (true, null, row);
    }

    /* ---------------------------------------------------------------------
     * The finished-PDF cache.
     *
     * An issued report is immutable: its content changes only when someone
     * reopens and re-saves the sample, and every such act bumps the sample's
     * lastmodified_date. So the date IS the invalidation — it rides in the
     * key, and a stale entry simply stops being addressed. Graphs can be
     * attached in the LIS without touching the sample, so their count and
     * newest id ride along too. TTL bounds Redis memory and doubles as the
     * horizon for the one thing the key cannot see: a redeploy that changes
     * the print layout itself. Bump the version to orphan everything at once.
     * ------------------------------------------------------------------- */
    private const string PdfCacheV = "1";
    private static readonly TimeSpan PdfCacheTtl = TimeSpan.FromMinutes(45);

    private static string PdfCacheKey(
        string kind, string sid, DateTimeOffset? lastModified, string options) =>
        $"rptpdf:{PdfCacheV}:{kind}:{sid.ToUpperInvariant()}:{lastModified?.UtcTicks ?? 0}:{options}";

    /// <summary>count.maxid of the SID's graph attachments, without the bytes.</summary>
    private static async Task<string> GraphFingerprintAsync(
        GraphRepository graphs, string sid, bool wanted, CancellationToken ct)
    {
        if (!wanted) return "off";
        var meta = await graphs.ListAsync(sid, ct).ConfigureAwait(false);
        return meta.Count == 0 ? "0" : $"{meta.Count}.{meta[^1].Id}";
    }

    /// <summary>The report as a PDF on the Noble letterhead.</summary>
    /// <param name="split">One department per sheet, as the preview shows it.</param>
    /// <param name="exclude">
    /// Comma-separated result ids the operator unticked in the preview. Filtered
    /// to integers here rather than passed through: this string is appended to
    /// the URL the renderer loads, and anything else in it would be injected
    /// into that query.
    /// </param>
    private static async Task<IResult> GetReportPdf(
        string sid,
        bool? withGraph,
        bool? headless,
        bool? split,
        string? exclude,
        System.Security.Claims.ClaimsPrincipal principal,
        HttpContext http,
        ScopeRepository scopes,
        ReportsRepository repo,
        ReportLockRepository locks,
        ReportExtrasRepository extras,
        ILoggerFactory loggers,
        GraphRepository graphs,
        RenderClient render,
        Caching.InfinityCache cache,
        Audit.AuditLog audit,
        CancellationToken ct)
    {
        var (ok, fail, row) = await GateAsync(sid, principal, scopes, repo, locks, extras, loggers, ct).ConfigureAwait(false);
        if (!ok) return fail!;

        audit.Log("report.pdf", actor: principal.UserId(), sid: sid, ip: Audit.AuditIp.From(http));

        // Everything that changes the bytes is in the key; the exclude list is
        // already digits-and-commas by the time PrintQuery is done with it.
        var graphFp = await GraphFingerprintAsync(graphs, sid, withGraph == true, ct).ConfigureAwait(false);
        var key = PdfCacheKey("report", sid, row!.LastModifiedAt,
            $"s{(split == true ? 1 : 0)}h{(headless == true ? 1 : 0)}g{graphFp}x{PrintQuery(split, exclude)}");

        if (await cache.GetBytesAsync(key, ct).ConfigureAwait(false) is { } cached)
        {
            http.Response.Headers["X-Report-Cache"] = "hit";
            return Results.File(cached, "application/pdf", $"Report_{Sanitise(sid)}.pdf");
        }

        var attachments = await CollectGraphsAsync(graphs, sid, withGraph == true, ct).ConfigureAwait(false);

        try
        {
            var pdf = await render.RenderAsync(
                [new RenderClient.ReportRequest(
                    Url: $"/print/report/{Uri.EscapeDataString(sid)}{PrintQuery(split, exclude)}",
                    Attachments: attachments,
                    Headless: headless)],
                http.Request.Headers.Cookie.ToString(),
                ct).ConfigureAwait(false);

            await cache.SetBytesAsync(key, pdf, PdfCacheTtl, ct).ConfigureAwait(false);
            http.Response.Headers["X-Report-Cache"] = "miss";
            return Results.File(pdf, "application/pdf", $"Report_{Sanitise(sid)}.pdf");
        }
        catch (RenderFailedException)
        {
            return Results.Problem("The report could not be rendered.", statusCode: StatusCodes.Status502BadGateway);
        }
    }

    /// <summary>
    /// Several reports as one merged PDF, in the LIS's own order — NOT the
    /// order they were sent in. See the note on the reordering below.
    /// </summary>
    private static async Task<IResult> PostBulkPdf(
        BulkPdfRequest body,
        System.Security.Claims.ClaimsPrincipal principal,
        HttpContext http,
        ScopeRepository scopes,
        ReportsRepository repo,
        ReportLockRepository locks,
        ReportExtrasRepository extras,
        ILoggerFactory loggers,
        GraphRepository graphs,
        RenderClient render,
        Caching.InfinityCache cache,
        Audit.AuditLog audit,
        CancellationToken ct)
    {
        var sids = (body?.Sids ?? [])
            .Where(s => !string.IsNullOrWhiteSpace(s) && s.Length <= 50)
            .Select(s => s.Trim())
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();

        if (sids.Count == 0) return Results.BadRequest(new { error = "Select at least one report." });
        if (sids.Count > MaxBulkReports)
            return Results.BadRequest(new { error = $"Up to {MaxBulkReports} reports can be merged at once." });

        // Each SID is gated independently. One locked or out-of-scope report
        // does NOT fail the batch — it is reported as skipped and the rest are
        // delivered, because a rider waiting on nineteen reports should not be
        // held up by the twentieth.
        var included = new List<RenderClient.ReportRequest>();
        var skipped = new List<object>();
        var misses = new List<(int Index, string Key)>();

        audit.Log("report.pdf_bulk", actor: principal.UserId(), ip: Audit.AuditIp.From(http),
            details: new { requested = sids.Count });

        /*
         * The stapled merge comes out in a chronological order, not the order
         * the screen happened to send: the reporting list is newest-first, so
         * passing its order straight through produced the reports back to
         * front. See OrderAsLisAsync.
         *
         * The complete patient report does NOT go through here — it is one
         * department-major document rather than a stack of per-sample ones, so
         * a sequence of whole reports cannot express it. See the deptMajor
         * branch below.
         */
        var deptMajor = body!.DeptMajor == true;
        if (!deptMajor)
        {
            sids = (await repo.OrderAsLisAsync(sids, ct).ConfigureAwait(false)).ToList();
        }

        // Gated, in the order given. The complete report re-orders them into
        // department units; the stapled merge keeps the sequence resolved
        // above. The stamps ride along so a unit's cache entry expires when its
        // sample is re-authorised, exactly as a whole report's does.
        var allowed = new List<string>();
        var rowStamps = new Dictionary<string, DateTimeOffset?>(StringComparer.OrdinalIgnoreCase);

        var hits = 0;
        foreach (var sid in sids)
        {
            var (ok, fail, row) = await GateAsync(sid, principal, scopes, repo, locks, extras, loggers, ct).ConfigureAwait(false);
            if (!ok)
            {
                // Named separately from "unavailable": an operator can act on
                // "unsigned" — someone has to configure a signatory — where
                // "unavailable" tells them only that it did not come.
                skipped.Add(new
                {
                    sid,
                    reason = fail is IStatusCodeHttpResult s
                        ? s.StatusCode switch
                        {
                            StatusCodes.Status423Locked => "balance",
                            StatusCodes.Status409Conflict => "unsigned",
                            StatusCodes.Status503ServiceUnavailable => "unsigned",
                            _ => "unavailable",
                        }
                        : "unavailable",
                });
                continue;
            }

            allowed.Add(sid);
            rowStamps[sid] = row!.LastModifiedAt;

            // The complete report is cut into department units below, so there
            // is no whole-sample document to build here. Gating still had to
            // run per SID, which is why this sits inside the loop rather than
            // replacing it.
            if (deptMajor) continue;

            // The batch shares the single route's cache, entry for entry. A hit
            // travels as finished bytes for the renderer to staple; a miss is
            // rendered individually below so ITS bytes land in the cache too —
            // the second pull of the same PID assembles without a browser.
            var graphFp = await GraphFingerprintAsync(graphs, sid, body!.WithGraph, ct).ConfigureAwait(false);
            var query = PrintQuery(body.Split, null, body.SplitDept == true);
            // n0: rendered WITHOUT per-report page numbers, because the batch
            // is numbered as one document at the staple. Distinct from the
            // single route's cache, whose documents carry their own numbers.
            var key = PdfCacheKey("report", sid, row!.LastModifiedAt,
                $"n0s{(body.Split == true ? 1 : 0)}d{(body.SplitDept == true ? 1 : 0)}h{(body.Headless == true ? 1 : 0)}g{graphFp}x{query}");

            if (await cache.GetBytesAsync(key, ct).ConfigureAwait(false) is { } cachedDoc)
            {
                hits++;
                included.Add(new RenderClient.ReportRequest(
                    Url: null, PdfB64: Convert.ToBase64String(cachedDoc)));
                continue;
            }

            included.Add(new RenderClient.ReportRequest(
                // pdf=1 matters here too. Without it the print route renders in
                // its preview shape — tick boxes down the left and a letterhead
                // placeholder — and a fifty-report batch would carry both on
                // every page.
                //
                // A batch has no per-report selection: it comes from ticking
                // rows on the worksheet, not from opening each one, so every
                // report goes out whole.
                Url: $"/print/report/{Uri.EscapeDataString(sid)}{query}",
                Attachments: await CollectGraphsAsync(graphs, sid, body.WithGraph, ct).ConfigureAwait(false),
                Headless: body.Headless,
                PageNumbers: false));
            misses.Add((included.Count - 1, key));
        }

        /*
         * The complete patient report — one document, not a stack.
         *
         * Departments run in the lab's own Orderno sequence and the samples sit
         * INSIDE them, which is why this cannot be assembled by stapling
         * per-sample PDFs: the LIS prints one sample's tests under two
         * different department headings with other samples in between, and a
         * whole-report-per-sample merge can only ever keep a sample together.
         *
         * One render, so one browser trip and no per-sample cache. A complete
         * report is pulled far less often than a single one, and its cache key
         * would have to fold every sample's last-modified stamp together.
         */
        if (deptMajor)
        {
            if (allowed.Count == 0)
                return Results.BadRequest(new { error = "None of the selected reports can be released.", skipped });

            var units = await repo.GetPatientUnitsAsync(allowed, ct).ConfigureAwait(false);

            // A sample with no authorised result belongs to no department and
            // so produces no unit. Falling through to the stapled merge would
            // silently hand back a differently-shaped document, so say it
            // plainly instead.
            if (units.Count == 0)
                return Results.BadRequest(new { error = "None of the selected reports can be released.", skipped });

            var deptDocs = new List<RenderClient.ReportRequest>();
            var deptMisses = new List<(int Index, string Key)>();
            var graphed = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

            for (var i = 0; i < units.Count; i++)
            {
                var u = units[i];
                var last = i == units.Count - 1;

                // Only the LAST unit closes the document. The LIS prints no end
                // marker at all; one at the foot of every sheet-run would put
                // five "End of Report" lines inside a single report.
                var query = $"?pdf=1&split=dept&dept={Uri.EscapeDataString(u.Department)}"
                          + (last ? string.Empty : "&end=0");

                // A sample's graphs ride with the FIRST unit that sample appears
                // in, so a tube whose tests span two departments does not carry
                // its graph sheets twice. Decided BEFORE the cache is consulted
                // and folded into the key: a cached unit already has its graphs
                // baked in, so deciding after a hit would attach them a second
                // time to the next unit of the same sample.
                var carriesGraphs = graphed.Add(u.Sid);

                var graphFp = carriesGraphs
                    ? await GraphFingerprintAsync(graphs, u.Sid, body.WithGraph, ct).ConfigureAwait(false)
                    : "0";
                var key = PdfCacheKey("reportdept", u.Sid, rowStamps.GetValueOrDefault(u.Sid),
                    $"{u.Department}|e{(last ? 1 : 0)}h{(body.Headless == true ? 1 : 0)}g{graphFp}");

                if (await cache.GetBytesAsync(key, ct).ConfigureAwait(false) is { } cachedUnit)
                {
                    hits++;
                    deptDocs.Add(new RenderClient.ReportRequest(
                        Url: null, PdfB64: Convert.ToBase64String(cachedUnit)));
                    continue;
                }

                var attachments = carriesGraphs
                    ? await CollectGraphsAsync(graphs, u.Sid, body.WithGraph, ct).ConfigureAwait(false)
                    : null;

                deptDocs.Add(new RenderClient.ReportRequest(
                    Url: $"/print/report/{Uri.EscapeDataString(u.Sid)}{query}",
                    Attachments: attachments,
                    Headless: body.Headless,
                    PageNumbers: false));
                deptMisses.Add((deptDocs.Count - 1, key));
            }

            try
            {
                var cookie = http.Request.Headers.Cookie.ToString();
                if (deptMisses.Count > 0)
                {
                    using var gate = new SemaphoreSlim(3);
                    await Task.WhenAll(deptMisses.Select(async m =>
                    {
                        await gate.WaitAsync(ct).ConfigureAwait(false);
                        try
                        {
                            var one = await render.RenderAsync([deptDocs[m.Index]], cookie, ct).ConfigureAwait(false);
                            await cache.SetBytesAsync(m.Key, one, PdfCacheTtl, ct).ConfigureAwait(false);
                            deptDocs[m.Index] = new RenderClient.ReportRequest(
                                Url: null, PdfB64: Convert.ToBase64String(one));
                        }
                        finally
                        {
                            gate.Release();
                        }
                    })).ConfigureAwait(false);
                }

                http.Response.Headers["X-Report-Cache"] = $"{hits}/{deptDocs.Count}";

                var patientPdf = await render.RenderAsync(
                    deptDocs, cookie, ct, numberPages: true).ConfigureAwait(false);

                if (skipped.Count > 0)
                    http.Response.Headers["X-Reports-Skipped"] = System.Text.Json.JsonSerializer.Serialize(skipped);

                var when = NobleTime.NowForNoble().ToString("yyyyMMdd-HHmm");
                return Results.File(patientPdf, "application/pdf", $"Reports_{allowed.Count}_{when}.pdf");
            }
            catch (RenderFailedException)
            {
                return Results.Problem("The report could not be rendered.", statusCode: StatusCodes.Status502BadGateway);
            }
        }

        if (included.Count == 0)
            return Results.BadRequest(new { error = "None of the selected reports can be released.", skipped });

        try
        {
            /*
             * Misses render one document per call, in parallel, capped at the
             * renderer's own page ceiling — then everything, hit and fresh
             * alike, goes back as finished bytes for one concatenation pass.
             * Two trips instead of one, but each fresh document comes back
             * alone, which is what lets it be CACHED; the old single-trip
             * shape returned only the merged batch, so a repeated PID
             * download re-rendered every report every time.
             */
            var cookieHeader = http.Request.Headers.Cookie.ToString();
            if (misses.Count > 0)
            {
                using var gate = new SemaphoreSlim(3);
                await Task.WhenAll(misses.Select(async m =>
                {
                    await gate.WaitAsync(ct).ConfigureAwait(false);
                    try
                    {
                        var one = await render.RenderAsync([included[m.Index]], cookieHeader, ct).ConfigureAwait(false);
                        await cache.SetBytesAsync(m.Key, one, PdfCacheTtl, ct).ConfigureAwait(false);
                        included[m.Index] = new RenderClient.ReportRequest(
                            Url: null, PdfB64: Convert.ToBase64String(one));
                    }
                    finally
                    {
                        gate.Release();
                    }
                })).ConfigureAwait(false);
            }

            http.Response.Headers["X-Report-Cache"] = $"{hits}/{included.Count}";

            // The whole bundle numbered once, "Page 1 of 8" meaning the stack
            // in hand — graph sheets counted like any other sheet.
            var pdf = await render.RenderAsync(included, cookieHeader, ct, numberPages: true).ConfigureAwait(false);

            // The skip list rides on a header: the body has to be the PDF, and a
            // silent short delivery ("I asked for 20, I got 19") is exactly the
            // kind of thing nobody notices until it matters.
            if (skipped.Count > 0)
                http.Response.Headers["X-Reports-Skipped"] = System.Text.Json.JsonSerializer.Serialize(skipped);

            var stamp = NobleTime.NowForNoble().ToString("yyyyMMdd-HHmm");
            return Results.File(pdf, "application/pdf", $"Reports_{included.Count}_{stamp}.pdf");
        }
        catch (RenderFailedException)
        {
            return Results.Problem("The reports could not be rendered.", statusCode: StatusCodes.Status502BadGateway);
        }
    }

    /// <summary>
    /// The LIS graph attachment on its own. <c>?meta=1</c> answers "is there
    /// one, and for which tests" without moving the bytes — that is what decides
    /// whether the SPA shows the control at all.
    /// </summary>
    private static async Task<IResult> GetReportGraph(
        string sid,
        bool? meta,
        System.Security.Claims.ClaimsPrincipal principal,
        ScopeRepository scopes,
        ReportsRepository repo,
        ReportLockRepository locks,
        ReportExtrasRepository extras,
        ILoggerFactory loggers,
        GraphRepository graphs,
        CancellationToken ct)
    {
        var (ok, fail, _) = await GateAsync(sid, principal, scopes, repo, locks, extras, loggers, ct,
                                            requireSignatory: false).ConfigureAwait(false);
        if (!ok) return fail!;

        if (meta == true)
        {
            var list = await graphs.ListAsync(sid, ct).ConfigureAwait(false);
            return Results.Ok(new { count = list.Count, tests = list.Select(g => g.TestName).Where(n => n is not null) });
        }

        var files = await graphs.GetFilesAsync(sid, ct).ConfigureAwait(false);
        if (files.Count == 0) return Results.NotFound();

        // One file goes out as-is. Several are left to the caller to merge —
        // only the PDF path needs them stapled, and that is the renderer's job.
        var first = files[0];
        var ext = first.Mime switch
        {
            "image/png" => "png",
            "image/jpeg" => "jpg",
            _ => "pdf",
        };
        return Results.File(first.Bytes, first.Mime, $"Graph_{Sanitise(sid)}.{ext}");
    }

    private static async Task<IReadOnlyList<RenderClient.Attachment>?> CollectGraphsAsync(
        GraphRepository graphs, string sid, bool wanted, CancellationToken ct)
    {
        if (!wanted) return null;
        var files = await graphs.GetFilesAsync(sid, ct).ConfigureAwait(false);
        if (files.Count == 0) return null;
        return files.Select(f => new RenderClient.Attachment(Convert.ToBase64String(f.Bytes), f.Mime)).ToList();
    }

    /// <summary>A SID reaches the filename, so it must not be able to steer it.</summary>
    private static string Sanitise(string sid) =>
        new(sid.Where(c => char.IsLetterOrDigit(c) || c is '-' or '_').ToArray());

    /// <param name="Split">
    /// One department per sheet. Defaults off so a batch download keeps the
    /// layout it has always had; no caller sends it yet.
    /// </param>
    /// <param name="SplitDept">
    /// One DEPARTMENT per sheet — the complete-report layout. The PID download
    /// always sends it: the LIS's own PID report separates departments, and a
    /// combined document that runs them together reads as one giant sample.
    /// </param>
    /// <param name="Headless">
    /// Skip the letterhead artwork, for pre-printed stationery — the same
    /// choice the LIS offers as its "Without Header" button.
    /// </param>
    /// <param name="DeptMajor">
    /// Assemble ONE complete report with the departments on the outside and
    /// the samples within, the way the LIS's PID report prints — instead of
    /// stapling one whole report per sample. Sent by the PID download only;
    /// the worksheet's multi-select merge stays a stack of per-sample reports,
    /// because there the samples are the point and need not share a patient.
    /// </param>
    public sealed record BulkPdfRequest(
        IReadOnlyList<string>? Sids, bool WithGraph = true, bool? Headless = null, bool? Split = null,
        bool? SplitDept = null, bool? DeptMajor = null);
}
