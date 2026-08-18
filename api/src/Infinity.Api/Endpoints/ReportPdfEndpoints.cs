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
        RenderClient render,
        CancellationToken ct)
    {
        var (ok, fail) = await GateAsync(sid, principal, scopes, repo, locks, extras, loggers, ct).ConfigureAwait(false);
        if (!ok) return fail!;

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
    private static string PrintQuery(bool? split, string? exclude)
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
        if (split == true) q += "&split=1";
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
    private static async Task<(bool Ok, IResult? Fail)> GateAsync(
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
            return (false, Results.Unauthorized());
        if (string.IsNullOrWhiteSpace(sid) || sid.Length > 50)
            return (false, Results.BadRequest(new { error = "A SID is required." }));

        var scope = await scopes.GetReportClientCodesAsync(userId, principal.Role(), ct).ConfigureAwait(false);
        if (scope.IsDenied) return (false, Results.NotFound());

        var row = await repo.GetBySidAsync(scope.ClientCodes, sid, ct).ConfigureAwait(false);
        if (row is null) return (false, Results.NotFound());

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
            }, statusCode: StatusCodes.Status423Locked));
        }

        // Last, and deliberately after the lock: a report with nobody to sign it
        // is not issued at all. Checked HERE rather than inside the print route
        // so the refusal costs one query instead of a headless browser opening a
        // page it must then throw away. See ReportSignoff.
        if (requireSignatory)
        {
            var signoff = await ReportSignoff.RequireAsync(extras, sid, loggers, ct).ConfigureAwait(false);
            if (signoff.Refusal is not null) return (false, signoff.Refusal);
        }

        return (true, null);
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
        CancellationToken ct)
    {
        var (ok, fail) = await GateAsync(sid, principal, scopes, repo, locks, extras, loggers, ct).ConfigureAwait(false);
        if (!ok) return fail!;

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

            return Results.File(pdf, "application/pdf", $"Report_{Sanitise(sid)}.pdf");
        }
        catch (RenderFailedException)
        {
            return Results.Problem("The report could not be rendered.", statusCode: StatusCodes.Status502BadGateway);
        }
    }

    /// <summary>Several reports as one merged PDF, in the order given.</summary>
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

        foreach (var sid in sids)
        {
            var (ok, fail) = await GateAsync(sid, principal, scopes, repo, locks, extras, loggers, ct).ConfigureAwait(false);
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

            included.Add(new RenderClient.ReportRequest(
                // pdf=1 matters here too. Without it the print route renders in
                // its preview shape — tick boxes down the left and a letterhead
                // placeholder — and a fifty-report batch would carry both on
                // every page.
                //
                // A batch has no per-report selection: it comes from ticking
                // rows on the worksheet, not from opening each one, so every
                // report goes out whole.
                //
                // Split is accepted but nothing sends it yet — the batch bar
                // offers only "include graphs". Left at the continuous layout
                // rather than quietly adopting the preview's new default, which
                // would change what an existing batch download looks like
                // without anyone asking for it.
                Url: $"/print/report/{Uri.EscapeDataString(sid)}{PrintQuery(body!.Split, null)}",
                Attachments: await CollectGraphsAsync(graphs, sid, body.WithGraph, ct).ConfigureAwait(false),
                Headless: body.Headless));
        }

        if (included.Count == 0)
            return Results.BadRequest(new { error = "None of the selected reports can be released.", skipped });

        try
        {
            var pdf = await render.RenderAsync(included, http.Request.Headers.Cookie.ToString(), ct).ConfigureAwait(false);

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
        var (ok, fail) = await GateAsync(sid, principal, scopes, repo, locks, extras, loggers, ct,
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
    public sealed record BulkPdfRequest(
        IReadOnlyList<string>? Sids, bool WithGraph = true, bool? Headless = null, bool? Split = null);
}
