using System.Security.Claims;
using Infinity.Api.Auth;

namespace Infinity.Api.Reports;

/// <summary>
/// Turns the <c>paper</c> a download asks for into a <see cref="ReportPaper"/>,
/// including a client's own letterhead (<c>lh:{id}</c>), and decides who may
/// use which.
/// </summary>
/// <remarks>
/// The lab (every unrestricted reporter) may print any active profile — a desk
/// prints for every centre. A client account may print only the profiles
/// assigned to a code in its own scope: a letterhead is the client's branding,
/// and another centre's must not be a thing one can put on a report. A paper
/// the caller may not use resolves to Noble's letterhead rather than failing
/// the download: the report still leaves, on the lab's own paper.
/// </remarks>
public sealed class LetterheadPapers(LetterheadRepository letterheads, ScopeRepository scopes)
{
    public async Task<ReportPaper> ResolveAsync(string? paper, bool? headless, ClaimsPrincipal principal, CancellationToken ct = default)
    {
        if (ReportPaper.LetterheadIdOf(paper) is not int id) return ReportPaper.Resolve(paper, headless);
        var p = await letterheads.GetAsync(id, ct).ConfigureAwait(false);
        if (p is null || !p.IsActive || !await MayUseAsync(p, principal, ct).ConfigureAwait(false))
            return ReportPaper.Letterhead;
        return await PaperOfAsync(p, ct).ConfigureAwait(false);
    }

    /// <summary>
    /// The patient's copy (the QR / public link): the centre's own DIGITAL
    /// letterhead when it has one, otherwise Noble's, as before. Stationery is
    /// never the answer here — the patient's copy is not printed on anyone's
    /// pre-printed sheet.
    /// </summary>
    public async Task<ReportPaper> PublicCopyAsync(string? clientCode, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(clientCode)) return ReportPaper.Letterhead;
        var map = await letterheads.ForClientsAsync([clientCode.Trim()], ct).ConfigureAwait(false);
        if (map.Count == 0) return ReportPaper.Letterhead;
        var p = await letterheads.GetAsync(map.Values.First(), ct).ConfigureAwait(false);
        if (p is not { IsActive: true, Composites: true }) return ReportPaper.Letterhead;
        return await PaperOfAsync(p, ct).ConfigureAwait(false);
    }

    public async Task<bool> MayUseAsync(LetterheadProfile p, ClaimsPrincipal principal, CancellationToken ct = default)
    {
        if (InfinityRoles.IsUnrestrictedReporter(principal.Role())) return true;
        if (principal.UserId() is not int userId) return false;
        var scope = await scopes.GetReportClientCodesAsync(userId, principal.Role(), ct).ConfigureAwait(false);
        if (scope.IsDenied) return false;
        if (scope.IsUnrestricted) return true;
        var mine = new HashSet<string>(scope.ClientCodes.Select(c => c.Trim()), StringComparer.OrdinalIgnoreCase);
        return p.Clients.Any(mine.Contains);
    }

    private async Task<ReportPaper> PaperOfAsync(LetterheadProfile p, CancellationToken ct)
    {
        var art = p.Kind == "digital" ? await letterheads.GetArtworkAsync(p, ct).ConfigureAwait(false) : null;
        return ReportPaper.For(p, art);
    }
}
