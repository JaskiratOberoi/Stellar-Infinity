using System.Security.Claims;
using Infinity.Api.Auth;
using Infinity.Api.Reads;

namespace Infinity.Api.Reports;

/// <summary>
/// The gate in front of a PATIENT'S Smart Report: every sample it is built
/// from must pass the same checks the clinical report passes, and all of
/// them must belong to one patient who bought the booklet.
/// </summary>
/// <remarks>
/// <para>
/// The Smart Report was first built per sample, because its route took a
/// SID. A visit is several tubes — an HR203A is four — and a patient handed
/// four booklets, each explaining a quarter of their results, is not what
/// the ₹99 bought. So the booklet is now built from every sample of the
/// visit the caller names, and this is the one place the set is checked:
/// once here, for both the JSON the modal reads and the PDF the download
/// renders, so the two can never disagree about what may be shown.
/// </para>
/// <para>
/// Per sample, in this order: scope (404), existence (404), a report exists
/// from authorisation onward (425), the balance lock (423). Then across the
/// set: one patient (400), the purchase (404 — see
/// <see cref="SmartReportAccessRepository"/> on why not 403), and a signatory
/// on every sample (<see cref="ReportSignoff"/>). Signers are the union across
/// samples, first seen first, capped at the three the booklet's band holds:
/// a serum tube and an EDTA tube are signed by different departments, and a
/// booklet that names only one of them has an unsigned half.
/// </para>
/// </remarks>
public static class SmartReportGate
{
    /// <summary>A visit is a handful of tubes; a list longer than this is a mistake, not a visit.</summary>
    public const int MaxSids = 50;

    /// <param name="Signers">Union across the samples, at most three.</param>
    /// <param name="ProcessedAt">The first sample's processing unit — one lab ran the visit.</param>
    public sealed record Passed(
        IReadOnlyList<WorksheetRow> Rows,
        IReadOnlyList<ReportSigner> Signers,
        ProcessingUnit? ProcessedAt);

    /// <summary>The comma-separated <c>sids</c> query, trimmed, deduplicated and capped.</summary>
    public static IReadOnlyList<string> ParseSids(string? sids) =>
        (sids ?? string.Empty)
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Where(s => s.Length <= 50)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .Take(MaxSids)
            .ToList();

    public static async Task<(IResult? Fail, Passed? Ok)> PassAsync(
        IReadOnlyList<string> sids,
        ClaimsPrincipal principal,
        ScopeRepository scopes,
        ReportsRepository repo,
        ReportLockRepository locks,
        ReportExtrasRepository extras,
        SmartReportAccessRepository access,
        ILoggerFactory loggers,
        CancellationToken ct)
    {
        if (principal.UserId() is not int userId) return (Results.Unauthorized(), null);
        if (sids.Count == 0)
            return (Results.BadRequest(new { error = "At least one SID is required." }), null);

        var scope = await scopes.GetReportClientCodesAsync(userId, principal.Role(), ct).ConfigureAwait(false);
        if (scope.IsDenied) return (Results.NotFound(), null);

        var rows = new List<WorksheetRow>(sids.Count);
        foreach (var sid in sids)
        {
            var row = await repo.GetBySidAsync(scope.ClientCodes, sid, ct).ConfigureAwait(false);
            if (row is null) return (Results.NotFound(), null);

            // Same rule as every report route: nothing is issued before
            // authorisation. Named, because the caller sent a set and needs
            // to know which member is the problem.
            if (row.StatusCode is not (6 or 7 or 8 or 9))
            {
                return (Results.Json(new
                {
                    error = "REPORT_NOT_READY",
                    message = $"Sample {sid} has not been authorised yet, so it cannot be part of the Smart Report.",
                    sid,
                }, statusCode: 425), null);
            }

            var lockState = await locks.GetAsync(sid, ct).ConfigureAwait(false);
            if (lockState.Locked)
            {
                return (Results.Json(new
                {
                    error = "BALANCE_LOCKED",
                    message = $"This report is on hold: ₹{Math.Round(lockState.DueAmount):N0} outstanding on the "
                            + (lockState.Reason == "client" ? "client account" : "patient's bill")
                            + ". Clear the balance to release it.",
                    reason = lockState.Reason,
                    dueAmount = lockState.DueAmount,
                    sid,
                }, statusCode: StatusCodes.Status423Locked), null);
            }

            rows.Add(row);
        }

        if (rows.Select(r => r.Pid).Distinct().Count() > 1)
        {
            return (Results.BadRequest(new
            {
                error = "ONE_PATIENT",
                message = "A Smart Report covers one patient; these samples belong to more than one.",
            }), null);
        }

        // Bought per order, so one sample answers for the visit.
        if (!await access.SidHasSmartReportAsync(rows[0].Sid, ct).ConfigureAwait(false))
            return (Results.NotFound(), null);

        var signers = new List<ReportSigner>(3);
        ProcessingUnit? unit = null;
        foreach (var row in rows)
        {
            var signoff = await ReportSignoff.RequireAsync(extras, row.Sid, loggers, ct).ConfigureAwait(false);
            if (signoff.Refusal is not null) return (signoff.Refusal, null);
            unit ??= signoff.Extras!.ProcessedAt;
            foreach (var s in signoff.Extras!.Signers)
            {
                if (signers.Count >= 3) break;
                if (signers.All(x => x.Id != s.Id)) signers.Add(s);
            }
        }

        return (null, new Passed(rows, signers, unit));
    }
}
