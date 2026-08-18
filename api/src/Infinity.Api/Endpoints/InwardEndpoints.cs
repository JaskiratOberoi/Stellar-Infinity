using System.Text;
using Infinity.Api.Audit;
using Infinity.Api.Auth;
using Infinity.Api.Orders;
using Infinity.Api.Worksheet;
using Microsoft.AspNetCore.Mvc;

namespace Infinity.Api.Endpoints;

/// <summary>
/// Sample transit / inward tracking — the port of the legacy Inward page
/// (menu 55, "Sample Tracking"; 58k scans in 90 days).
///
/// Permissions are deliberately NARROWER than the legacy grant. The LIS gives
/// page 55 to 21 usertypes including Client — 3,311 client-portal users can
/// open the scan page today, and a scan silently re-points the sample's
/// business unit and can trigger accession + billing at head office. Here the
/// scan requires order:accession, which the client role does not hold; the
/// list requires order:view and is client-code scoped like the worksheet.
/// Which roles should ultimately hold the scan is an ASK for the lab, recorded
/// in the phase's decision log.
/// </summary>
public static class InwardEndpoints
{
    public static void MapInwardEndpoints(this WebApplication app)
    {
        var g = app.MapGroup("/api/inward").RequireAuthorization();

        g.MapGet("/", List)
         .RequireCapability(Capabilities.OrderView)
         .WithName("InwardList");

        g.MapPost("/scan", Scan)
         .RequireCapability(Capabilities.OrderAccession)
         .WithName("InwardScan");
    }

    private static async Task<IResult> List(
        System.Security.Claims.ClaimsPrincipal principal,
        HttpContext http,
        ScopeRepository scopes,
        InwardRepository repo,
        CancellationToken ct,
        DateOnly? from = null,
        DateOnly? to = null,
        string? sid = null,
        int? clientId = null,
        string? bunit = null,
        string? format = null,
        int maxRows = InwardRepository.DefaultRows)
    {
        if (principal.UserId() is not int userId) return Results.Unauthorized();

        // Today on the LAB's calendar, not the container's UTC one — for the
        // first 5.5 hours of every IST day those are different days, and the
        // default window would open on yesterday.
        var today = DateOnly.FromDateTime(Domain.NobleTime.NowForNoble());
        var fromDate = from ?? today;
        var toDate = to ?? today;
        if (toDate < fromDate) (fromDate, toDate) = (toDate, fromDate);

        /*
         * Scope, and the one place inward differs from the worksheet.
         *
         * A CLIENT-scoped caller with no codes sees nothing, as everywhere
         * else. Lab staff are a different case, and treating them the same was
         * defect D9: a technician has no client-code mappings BY DESIGN — they
         * are lab staff, not tied to a collection centre — so their scope
         * resolves to Denied and the log came back empty. Measured at SRINAGAR:
         * 5,453 scans in 90 days, and the technician who made them saw none.
         *
         * The legacy page never scoped lab staff by client at all: branch users
         * were locked to their own `bunit` and nothing else (contract §5.2).
         * That lock lives in usp_inf_inward_list, derived server-side from the
         * actor's own user row so a caller cannot ask for another unit. So for
         * lab staff the business unit IS the scope, and the empty TVP is safe
         * precisely because the unit lock is not.
         *
         * The procedure fails closed on the remaining case — no client codes,
         * not unrestricted, and no usable business unit — so an unmapped role
         * cannot fall through the gap this opens.
         */
        var scope = await scopes.GetReportClientCodesAsync(userId, principal.Role(), ct).ConfigureAwait(false);

        // The fallback is keyed on order:accession, not merely order:view —
        // "you may scan, therefore you may see the log of scans". That keeps it
        // to people who actually work the bench and excludes `viewer`, which is
        // the catch-all for LIS user types Infinity does not recognise; giving
        // an unknown type the hub's whole transit log is not a trade worth
        // making to fix a technician's empty screen.
        var unitScoped = principal.HasCapability(Capabilities.OrderAccession);

        if (scope.IsDenied && !unitScoped)
        {
            return Results.Ok(new { rows = Array.Empty<InwardRow>(), count = 0, total = 0, capped = false });
        }

        IReadOnlyList<string> codes = scope.IsDenied ? Array.Empty<string>() : scope.ClientCodes;

        var wantCsv = string.Equals(format, "csv", StringComparison.OrdinalIgnoreCase);

        // The CSV is a take-it-all export; the screen pages nothing and caps
        // instead, saying so when the cap bites.
        var cap = wantCsv ? InwardRepository.MaxRows : Math.Clamp(maxRows, 1, InwardRepository.MaxRows);

        var result = await repo.ListAsync(
            userId, codes, scope.IsUnrestricted, fromDate, toDate, sid, clientId, bunit, cap, ct)
            .ConfigureAwait(false);

        if (wantCsv)
        {
            // A REAL export (contract FIX #19): correct Content-Type, honest
            // filename and extension. The legacy button rendered the grid's
            // HTML as "sampletracking.xls", which Excel opens under protest.
            //
            // A truncated export must SAY it is truncated. The ceiling is
            // reachable in about a fortnight of ordinary scanning (~700/day),
            // and an export that quietly stops at 10,000 rows while the screen
            // calls it the complete answer is a worse failure than the legacy
            // pseudo-.xls it replaces: that one at least looked wrong. The
            // count rides on a header AND on a trailing row, because whoever
            // opens this in Excel will never see a header.
            var stamp = Domain.NobleTime.NowForNoble().ToString("yyyyMMdd_HHmm");
            var truncated = result.Total > result.Rows.Count;

            if (truncated)
            {
                http.Response.Headers["X-Inward-Truncated"] =
                    $"{result.Rows.Count} of {result.Total}";
            }

            return Results.File(
                ToCsvBytes(result.Rows, truncated ? result.Total : null),
                "text/csv; charset=utf-8",
                $"inward_{fromDate:yyyyMMdd}-{toDate:yyyyMMdd}_{stamp}.csv");
        }

        return Results.Ok(new
        {
            rows = result.Rows,
            count = result.Rows.Count,
            total = result.Total,
            capped = result.Total > result.Rows.Count,
            from = fromDate,
            to = toDate,
        });
    }

    public sealed record ScanRequest(string Vailid);

    /// <summary>
    /// One barcode-gun scan.
    ///
    /// Two steps, deliberately not one transaction. usp_inf_inward_scan commits
    /// the tracking leg + business-unit overwrite + audit atomically and
    /// reports what happened; then, only when the scanner sits at head office
    /// (business unit 1) and the sample was still Sample Sent (status 1), the
    /// EXISTING accession path runs — usp_telo_accession_samples via
    /// AccessionRepository, the same procedure the Accessioning screen uses,
    /// whose amount_checked latch makes the billing debit charge-once. A
    /// failure between the steps leaves "arrived, not registered", which is
    /// coherent and retryable from the Accessioning queue; the legacy page's
    /// unhandled mid-chain failures left half-accessioned samples instead
    /// (contract quirk 21).
    ///
    /// There is intentionally no client-code scope check on the scan target
    /// (contract KEEP #18): a hub receives every client's vials, and refusing
    /// to log a physical arrival because of a mapping would be data loss. The
    /// capability gate plus the list-side scoping are the controls.
    /// </summary>
    private static async Task<IResult> Scan(
        [FromBody] ScanRequest request,
        HttpContext http,
        System.Security.Claims.ClaimsPrincipal principal,
        InwardRepository repo,
        AccessionRepository accession,
        CancellationToken ct)
    {
        if (principal.UserId() is not int userId) return Results.Unauthorized();

        var sid = request.Vailid?.Trim();
        if (string.IsNullOrWhiteSpace(sid) || sid.Length > 50)
        {
            return Results.BadRequest(new { error = "A Sample ID of 1-50 characters is required." });
        }

        InwardScanOutcome outcome;
        try
        {
            outcome = await repo.ScanAsync(sid, AuditActorAccessor.For(http), ct).ConfigureAwait(false);
        }
        catch (WorksheetRefusedException ex)
        {
            return ex.IsPermission
                ? Results.Problem(title: "Forbidden", detail: ex.Message, statusCode: StatusCodes.Status403Forbidden)
                : Results.BadRequest(new { error = ex.Message });
        }

        // Inward at head office of a sent sample IS accession (contract KEEP
        // #5) — through the one existing path, never a clone of its billing.
        var shouldAccession = outcome is
        {
            NoWorkorder: false,
            ScannerBusinessUnitId: 1,
            SampleStatus: 1,
        };

        var accessionTriggered = false;
        var accessionOk = false;
        string? accessionMessage = null;
        var registered = 0;

        if (shouldAccession)
        {
            accessionTriggered = true;
            var username = principal.Username();
            if (string.IsNullOrWhiteSpace(username))
            {
                accessionMessage = "The scan was logged, but the acting user could not be identified for registration.";
            }
            else
            {
                try
                {
                    var acc = await accession.AccessionAsync(userId, username!, [sid], ct).ConfigureAwait(false);
                    accessionOk = acc.Ok && acc.Registered > 0;
                    registered = acc.Registered;
                    accessionMessage = acc.Ok
                        ? (acc.Registered > 0 ? null : "Already accessioned, or no longer registrable.")
                        : acc.Message;
                }
                catch (Exception) when (!ct.IsCancellationRequested)
                {
                    // The scan itself is committed; the sample is "arrived, not
                    // registered" and stays on the Accessioning queue. Say so
                    // rather than failing the whole scan.
                    accessionMessage = "The arrival was logged, but registration failed — "
                        + "register it from the Accessioning queue.";
                }
            }
        }

        return Results.Ok(new
        {
            outcome = outcome.Outcome,
            noWorkorder = outcome.NoWorkorder,
            slno = outcome.Slno,
            patientName = outcome.PatientName,
            sex = outcome.Sex,
            sampleStatus = outcome.SampleStatus,
            tests = outcome.Tests,
            oldBusinessUnit = outcome.OldBusinessUnit,
            businessUnit = outcome.ScannerBusinessUnit,
            accession = new
            {
                triggered = accessionTriggered,
                ok = accessionOk,
                registered,
                message = accessionMessage,
            },
        });
    }

    /* ---- CSV ---- */

    /// <param name="truncatedTotal">
    /// The true row count when the export hit its ceiling, else null. Written
    /// as a final line so the person reading the file in Excel — who will
    /// never see a response header — is told the file is partial.
    /// </param>
    private static byte[] ToCsvBytes(IReadOnlyList<InwardRow> rows, long? truncatedTotal = null)
    {
        var sb = new StringBuilder();
        sb.AppendLine("slno,sid,patient,sex,client,tests,scanned_by,scanned_at,unit,"
            + "received_1_by,received_1_at,received_2_by,received_2_at,received_3_by,received_3_at");

        foreach (var r in rows)
        {
            sb.Append(r.Slno).Append(',')
              .Append(Csv(r.Sid)).Append(',')
              .Append(Csv(r.PatientName)).Append(',')
              .Append(Csv(r.Sex)).Append(',')
              .Append(Csv(r.ClientCode)).Append(',')
              .Append(Csv(r.Tests)).Append(',')
              .Append(Csv(r.ScannedBy)).Append(',')
              .Append(Csv(Stamp(r.ScannedAt))).Append(',')
              .Append(Csv(r.Bunit)).Append(',')
              .Append(Csv(r.ReceivedOne)).Append(',')
              .Append(Csv(Stamp(r.ReceivedOneAt))).Append(',')
              .Append(Csv(r.ReceivedTwo)).Append(',')
              .Append(Csv(Stamp(r.ReceivedTwoAt))).Append(',')
              .Append(Csv(r.ReceivedThree)).Append(',')
              .Append(Csv(Stamp(r.ReceivedThreeAt)))
              .AppendLine();
        }

        if (truncatedTotal is long total)
        {
            // First column so it survives any spreadsheet's column handling,
            // and worded so nobody mistakes it for a scan row.
            sb.Append(Csv($"TRUNCATED — this file holds the first {rows.Count:N0} of "
                + $"{total:N0} matching scans. Narrow the date range to export the rest."))
              .AppendLine();
        }

        // BOM so Excel decodes UTF-8 instead of guessing the ANSI code page —
        // patient names here are not always ASCII.
        return [.. Encoding.UTF8.GetPreamble(), .. Encoding.UTF8.GetBytes(sb.ToString())];
    }

    /// <summary>IST wall-clock, since the whole lab reads times that way.</summary>
    private static string? Stamp(DateTimeOffset? at) => at?.ToString("yyyy-MM-dd HH:mm");

    private static string Csv(string? value)
    {
        if (string.IsNullOrEmpty(value)) return "";
        var needsQuotes = value.Contains(',') || value.Contains('"')
            || value.Contains('\n') || value.Contains('\r');
        return needsQuotes ? "\"" + value.Replace("\"", "\"\"") + "\"" : value;
    }
}
