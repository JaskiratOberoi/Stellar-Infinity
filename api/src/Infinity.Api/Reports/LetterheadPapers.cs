using System.Security.Claims;
using Infinity.Api.Auth;

namespace Infinity.Api.Reports;

/// <summary>
/// Turns the <c>paper</c> a download asks for into a <see cref="ReportPaper"/>,
/// including a client's own letterhead (<c>lh:{id}</c>), and decides where a
/// letterhead may go.
/// </summary>
/// <remarks>
/// A letterhead is the client's branding, so it goes on that client's reports
/// and on nobody else's: <c>lh:{id}</c> resolves only when EVERY report in the
/// document was booked under a client code assigned to that profile (a
/// bundle is one paper, one print run). Anything else — another centre's
/// report, a bundle mixing centres, a retired profile, a client account asking
/// for a profile outside its scope — prints on Noble's letterhead rather than
/// failing the download: the report still leaves, on the lab's own paper. The
/// paper picker offers the same rule (/api/letterheads/options?clients=), so
/// this is the backstop, not the usual path.
/// </remarks>
public sealed class LetterheadPapers(LetterheadRepository letterheads, ScopeRepository scopes)
{
    /// <param name="reportClients">The client code of every report in the document.</param>
    /// <param name="editorPreview">
    /// Admin → Letterheads' "Preview with a report": an editor (super admin,
    /// admin) may see any letterhead on a test report before assigning it. For
    /// anyone else the flag changes nothing.
    /// </param>
    public async Task<ReportPaper> ResolveAsync(string? paper, bool? headless, ClaimsPrincipal principal,
                                                IReadOnlyCollection<string?> reportClients, CancellationToken ct = default,
                                                bool editorPreview = false)
    {
        if (ReportPaper.LetterheadIdOf(paper) is not int id) return ReportPaper.Resolve(paper, headless);
        var p = await letterheads.GetAsync(id, ct).ConfigureAwait(false);
        var preview = editorPreview && principal.Role() is InfinityRoles.SuperAdmin or InfinityRoles.Admin;
        if (p is null || (!preview && !p.IsActive) || (!preview && !Covers(p, reportClients))
            || !await MayUseAsync(p, principal, ct).ConfigureAwait(false))
            return ReportPaper.Letterhead;
        return await PaperOfAsync(p, ct).ConfigureAwait(false);
    }

    /// <summary>True when every one of these client codes is assigned to the profile (and there is at least one).</summary>
    public static bool Covers(LetterheadProfile p, IReadOnlyCollection<string?> clients)
    {
        var codes = clients.Select(c => c?.Trim() ?? string.Empty).ToList();
        if (codes.Count == 0 || codes.Any(c => c.Length == 0)) return false;
        var mine = new HashSet<string>(p.Clients, StringComparer.OrdinalIgnoreCase);
        return codes.All(mine.Contains);
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
