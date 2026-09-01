using Infinity.Api.Reads;
using Infinity.Api.Reports;

namespace Infinity.Api.Endpoints;

/// <summary>
/// The patient's own copy, opened from the QR on the printed report.
///
/// The ONLY unauthenticated route in the API that returns patient data. Every
/// decision below exists because of that.
/// </summary>
/// <remarks>
/// <para>
/// ── HOW THIS IS GATED ─────────────────────────────────────────────────────
/// There is no session, so there is no scope. What stands in for it is the
/// token: an HMAC of the SID that only appears on the printed report for that
/// SID. It is checked in constant time, and with no secret configured it never
/// matches — so a deployment that has not been given one serves nothing here
/// rather than everything.
/// </para>
/// <para>
/// The balance lock still applies. A centre with an outstanding balance has its
/// reports held, and a route that bypassed that would be the way around it —
/// the patient's copy is the same document, released on the same terms.
/// </para>
/// <para>
/// ── WHAT IT DELIBERATELY DOES NOT DO ──────────────────────────────────────
/// It returns one status for every failure: 404. A bad token, an unknown SID,
/// a held report and a disabled feature are indistinguishable from outside.
/// Distinguishing them would turn this route into an oracle for which SIDs
/// exist, which is exactly what the unguessable token is there to prevent.
///
/// It serves the PDF only. There is no JSON, no result list, and no way to ask
/// it a narrower question, because everything it can be asked is another thing
/// that has to be right when nobody is logged in.
/// </para>
/// </remarks>
public static class PublicReportEndpoints
{
    public static void MapPublicReportEndpoints(this WebApplication app)
    {
        // No RequireAuthorization, and no capability. Read the remarks above
        // before adding anything else to this group.
        var pub = app.MapGroup("/api/public/reports");

        pub.MapGet("/{sid}/pdf", GetPublicPdf)
           .WithName("GetPublicReportPdf")
           .AllowAnonymous();

        // The same report as JSON, for the print ROUTE to draw itself from.
        //
        // The PDF above is produced by pointing the renderer at /print/report,
        // and that page has to fetch its data with no session — so the token
        // has to open a data route as well as a document one. It is the same
        // gate, the same lock and the same 404-for-everything as the PDF.
        pub.MapGet("/{sid}", GetPublicReport)
           .WithName("GetPublicReport")
           .AllowAnonymous();
    }

    /// <summary>The report as JSON, on the strength of the token alone.</summary>
    private static async Task<IResult> GetPublicReport(
        string sid,
        string? t,
        ReportLink links,
        ReportsRepository repo,
        ReportExtrasRepository extras,
        CatalogueDetailRepository catalogue,
        ReportLockRepository locks,
        ILoggerFactory loggers,
        CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(sid) || sid.Length > 50) return Results.NotFound();
        if (!links.Verify(sid, t)) return Results.NotFound();

        var row = await repo.GetBySidAsync([], sid, ct).ConfigureAwait(false);
        if (row is null) return Results.NotFound();

        // No report exists before authorisation, and the public route reveals
        // nothing about why — the same 404 as an unknown SID.
        if (row.StatusCode is not (7 or 8 or 9)) return Results.NotFound();

        var lockState = await locks.GetAsync(sid, ct).ConfigureAwait(false);
        if (lockState.Locked) return Results.NotFound();

        // The patient's own copy is held to the same rule as the lab's: an
        // unsigned report is not a report. See ReportSignoff.
        var signoff = await ReportSignoff.RequireAsync(extras, row.Sid, loggers, ct).ConfigureAwait(false);
        if (signoff.Refusal is not null) return signoff.Refusal;
        var more = signoff.Extras!;

        var results = await ReportEnrichment.ApplyAsync(catalogue, row, ct).ConfigureAwait(false);

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
            // The QR rides on the patient's copy too, the same as Telo prints
            // it. The earlier reasoning — that a code reopening the page you
            // hold is furniture — held only for a patient reading on screen;
            // the printed sheet is the common case, and there the QR is the ONE
            // way back to a verifiable copy from a piece of paper. It also has
            // to match the lab's own report, which carries it, or the two
            // documents disagree on whether the mark is there.
            //
            // The token it encodes is the same token that already opened this
            // page, so nothing is exposed that the holder of the sheet did not
            // already have — see ReportLink on that being the intended
            // property of the patient link, not a leak.
            Qr = links.QrDataUrl(row.Sid),
        });
    }

    private static async Task<IResult> GetPublicPdf(
        string sid,
        string? t,
        HttpContext http,
        ReportLink links,
        ReportsRepository repo,
        ReportLockRepository locks,
        GraphRepository graphs,
        RenderClient render,
        ILoggerFactory logs,
        CancellationToken ct)
    {
        var log = logs.CreateLogger("Infinity.Api.PublicReport");

        if (string.IsNullOrWhiteSpace(sid) || sid.Length > 50) return Results.NotFound();
        if (!links.Verify(sid, t))
        {
            // Worth a line: a run of these is someone trying tokens, and it is
            // the only signal that would show it. The SID is logged, the token
            // is not.
            log.LogWarning("publicreport.badtoken sid={Sid} ip={Ip}",
                sid, http.Connection.RemoteIpAddress?.ToString() ?? "?");
            return Results.NotFound();
        }

        // Empty client-code list = unrestricted, which is what "no session"
        // means here. The token has already established WHICH report may be
        // read, so the scope check has nothing left to narrow.
        var row = await repo.GetBySidAsync([], sid, ct).ConfigureAwait(false);
        if (row is null) return Results.NotFound();

        // Same rule as the JSON route above: nothing issued, nothing served.
        if (row.StatusCode is not (7 or 8 or 9)) return Results.NotFound();

        var lockState = await locks.GetAsync(sid, ct).ConfigureAwait(false);
        // 404, not 423. The signed-in route says "clear the balance" because a
        // member of staff can act on that; a patient cannot, and telling them
        // their report is being withheld over their centre's unpaid bill is not
        // this route's news to break.
        if (lockState.Locked) return Results.NotFound();

        try
        {
            var attachments = await CollectGraphsAsync(graphs, sid, ct).ConfigureAwait(false);

            var pdf = await render.RenderAsync(
                [new RenderClient.ReportRequest(
                    // Headless: false — the patient's copy is the one that has
                    // to carry the letterhead, because it is not being printed
                    // onto Noble's pre-printed paper.
                    // The token travels into the print route: with no cookie,
                    // it is the only thing that will open the data behind it.
                    Url: $"/print/report/{Uri.EscapeDataString(sid)}?pdf=1&split=1&t={Uri.EscapeDataString(links.Token(sid))}",
                    Attachments: attachments,
                    Headless: false)],
                // No cookie. The print route must serve this render on the
                // strength of the token alone — see PrintReport's token path.
                cookieHeader: null,
                ct).ConfigureAwait(false);

            log.LogInformation("publicreport.served sid={Sid}", sid);
            return Results.File(pdf, "application/pdf", $"Report_{Sanitise(sid)}.pdf");
        }
        catch (RenderFailedException)
        {
            return Results.Problem("The report could not be rendered.",
                statusCode: StatusCodes.Status502BadGateway);
        }
    }

    /// <summary>
    /// The stapled graph, when the sample has one.
    /// </summary>
    /// <remarks>
    /// Same shape as the signed-in route's collector, but swallowing: the
    /// patient's copy should be the same document the lab prints, and an
    /// attachment read that fails is not worth failing the report over when
    /// there is nobody logged in to retry it.
    /// </remarks>
    private static async Task<IReadOnlyList<RenderClient.Attachment>?> CollectGraphsAsync(
        GraphRepository graphs, string sid, CancellationToken ct)
    {
        try
        {
            var files = await graphs.GetFilesAsync(sid, ct).ConfigureAwait(false);
            if (files.Count == 0) return null;
            return files
                .Select(f => new RenderClient.Attachment(Convert.ToBase64String(f.Bytes), f.Mime))
                .ToList();
        }
        catch
        {
            return null;
        }
    }

    private static string Sanitise(string s) =>
        new(s.Where(c => char.IsLetterOrDigit(c) || c is '-' or '_').ToArray());
}
