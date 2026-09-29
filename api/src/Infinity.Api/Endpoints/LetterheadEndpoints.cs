using Infinity.Api.Auth;
using Infinity.Api.Reports;

namespace Infinity.Api.Endpoints;

/// <summary>
/// Per-client letterheads (inf_letterhead, script 171).
/// </summary>
/// <remarks>
/// <list type="bullet">
/// <item><c>/api/letterheads/options</c> — the paper picker's choices for the
/// caller: Noble's papers plus the profiles the caller may print, and the
/// default to start from (a client's own letterhead, when it has one).</item>
/// <item><c>/api/public/letterheads/{id}</c> — a profile's margins and nothing
/// else, for the print route, which lays out with no session when the
/// renderer drives it. Millimetres are not anyone's data.</item>
/// <item><c>/api/settings/letterheads</c> — the editor. Super admin and admin
/// only; 404 for everyone else, as the Reporting settings tab is.</item>
/// </list>
/// Every write bumps the profile's version, which rides in the PDF cache key
/// (ReportPaper.Key), so nothing rendered on the old layout is served again.
/// </remarks>
public static class LetterheadEndpoints
{
    public static void MapLetterheadEndpoints(this WebApplication app)
    {
        app.MapGet("/api/letterheads/options", GetOptions)
           .RequireAuthorization()
           .RequireCapability(Capabilities.ReportView)
           .WithName("GetLetterheadOptions");

        app.MapGet("/api/public/letterheads/{id:int}", GetPublicMargins)
           .AllowAnonymous()
           .WithName("GetPublicLetterheadMargins");

        var admin = app.MapGroup("/api/settings/letterheads").RequireAuthorization();
        admin.MapGet("/", List).WithName("ListLetterheads");
        admin.MapPost("/", Create).WithName("CreateLetterhead");
        admin.MapPut("/{id:int}", Update).WithName("UpdateLetterhead");
        admin.MapPut("/{id:int}/active", SetActive).WithName("SetLetterheadActive");
        admin.MapPut("/{id:int}/clients", SetClients).WithName("SetLetterheadClients");
        admin.MapGet("/{id:int}/artwork", GetArtwork).WithName("GetLetterheadArtwork");
        admin.MapPost("/{id:int}/artwork", UploadArtwork).DisableAntiforgery().WithName("UploadLetterheadArtwork");
        admin.MapDelete("/{id:int}/artwork", DeleteArtwork).WithName("DeleteLetterheadArtwork");
        admin.MapGet("/{id:int}/calibration", GetCalibration).WithName("GetLetterheadCalibration");
    }

    public sealed record CreateBody(string? Name, string? Kind);
    public sealed record UpdateBody(string? Name, string? Kind, decimal? FirstTopMm, decimal? TopMm, decimal? BottomMm,
                                    decimal? SideMm, decimal? NudgeXMm, decimal? NudgeYMm);
    public sealed record ActiveBody(bool Active);
    public sealed record ClientsBody(IReadOnlyList<string>? Clients);

    private static bool IsEditor(System.Security.Claims.ClaimsPrincipal p) =>
        p.Role() is InfinityRoles.SuperAdmin or InfinityRoles.Admin;

    private static object View(LetterheadProfile p) => new
    {
        p.Id, p.Name, p.Kind, p.FirstTopMm, p.TopMm, p.BottomMm, p.SideMm, p.NudgeXMm, p.NudgeYMm,
        p.HasArtwork, p.ArtworkMime, p.Version, p.IsActive, p.UpdatedAt, p.Clients,
    };

    private static async Task<IResult> GetOptions(
        System.Security.Claims.ClaimsPrincipal principal,
        LetterheadRepository letterheads,
        LetterheadPapers papers,
        CancellationToken ct)
    {
        var lab = InfinityRoles.IsUnrestrictedReporter(principal.Role());
        var all = await letterheads.ListAsync(activeOnly: true, ct).ConfigureAwait(false);
        var mine = new List<LetterheadProfile>();
        foreach (var p in all)
            if (lab || await papers.MayUseAsync(p, principal, ct).ConfigureAwait(false)) mine.Add(p);

        var options = new List<object>
        {
            new { value = "letterhead", label = "With Noble letterhead", group = "noble" },
            new { value = "noble", label = "Noble pre-printed paper", group = "noble" },
        };
        // A client with its own letterhead has no use for the generic 40mm
        // sheet: its own profile IS its stationery, with the right margins.
        if (lab || mine.Count == 0)
            options.Add(new { value = "plain", label = "Client letterhead 40mm", group = "noble" });
        foreach (var p in mine)
            options.Add(new
            {
                value = "lh:" + p.Id.ToString(System.Globalization.CultureInfo.InvariantCulture),
                label = p.Kind == "digital" ? p.Name + " (digital)" : p.Name + " (pre-printed)",
                group = "client",
            });

        // The client's own letterhead is where it starts; the lab keeps
        // whatever the desk last chose.
        string? defaultPaper = !lab && mine.Count > 0
            ? "lh:" + mine[0].Id.ToString(System.Globalization.CultureInfo.InvariantCulture)
            : null;
        return Results.Ok(new { options, defaultPaper });
    }

    private static async Task<IResult> GetPublicMargins(int id, LetterheadRepository letterheads, CancellationToken ct)
    {
        var p = await letterheads.GetAsync(id, ct).ConfigureAwait(false);
        if (p is null) return Results.NotFound();
        return Results.Ok(new { p.Id, p.FirstTopMm, p.TopMm, p.BottomMm, p.SideMm, p.Version });
    }

    private static async Task<IResult> List(System.Security.Claims.ClaimsPrincipal principal, LetterheadRepository letterheads, CancellationToken ct)
    {
        if (!IsEditor(principal)) return Results.NotFound();
        var all = await letterheads.ListAsync(activeOnly: false, ct).ConfigureAwait(false);
        return Results.Ok(all.Select(View));
    }

    private static async Task<IResult> Create(
        CreateBody body, System.Security.Claims.ClaimsPrincipal principal, HttpContext http,
        LetterheadRepository letterheads, Audit.AuditLog audit, CancellationToken ct)
    {
        if (!IsEditor(principal) || principal.UserId() is not int actor) return Results.NotFound();
        var name = body.Name?.Trim();
        if (string.IsNullOrEmpty(name) || name.Length > 120) return Results.BadRequest(new { error = "A name of 1-120 characters is required." });
        var kind = body.Kind is "digital" ? "digital" : "stationery";
        var id = await letterheads.CreateAsync(name, kind, actor, ct).ConfigureAwait(false);
        audit.Log("settings.letterhead", actor: actor, ip: Audit.AuditIp.From(http), details: new { op = "create", id, name, kind });
        return Results.Ok(View((await letterheads.GetAsync(id, ct).ConfigureAwait(false))!));
    }

    private static async Task<IResult> Update(
        int id, UpdateBody body, System.Security.Claims.ClaimsPrincipal principal, HttpContext http,
        LetterheadRepository letterheads, Audit.AuditLog audit, CancellationToken ct)
    {
        if (!IsEditor(principal) || principal.UserId() is not int actor) return Results.NotFound();
        var before = await letterheads.GetAsync(id, ct).ConfigureAwait(false);
        if (before is null) return Results.NotFound();

        var name = body.Name?.Trim();
        if (name is not null && (name.Length == 0 || name.Length > 120)) return Results.BadRequest(new { error = "A name of 1-120 characters is required." });
        if (body.Kind is not null and not ("digital" or "stationery")) return Results.BadRequest(new { error = "Kind is digital or stationery." });

        static decimal? Round(decimal? v) => v is decimal d ? Math.Round(d, 1, MidpointRounding.AwayFromZero) : null;
        var edit = new LetterheadEdit(name, body.Kind, Round(body.FirstTopMm), Round(body.TopMm), Round(body.BottomMm),
                                      Round(body.SideMm), Round(body.NudgeXMm), Round(body.NudgeYMm));
        var first = edit.FirstTopMm ?? before.FirstTopMm;
        var top = edit.TopMm ?? before.TopMm;
        var bottom = edit.BottomMm ?? before.BottomMm;
        var side = edit.SideMm ?? before.SideMm;
        var nx = edit.NudgeXMm ?? before.NudgeXMm;
        var ny = edit.NudgeYMm ?? before.NudgeYMm;
        // The same bounds the table's CHECK holds, said in words: at least
        // 97mm of report on every sheet.
        if (first is < 0 or > 120 || top is < 0 or > 120 || bottom is < 0 or > 120)
            return Results.BadRequest(new { error = "Top and bottom margins must be between 0 and 120 mm." });
        if (side is < 0 or > 40) return Results.BadRequest(new { error = "Side margins must be between 0 and 40 mm." });
        if (first + bottom > 200 || top + bottom > 200)
            return Results.BadRequest(new { error = "Top and bottom together may not exceed 200 mm — the report needs room." });
        if (nx is < -10 or > 10 || ny is < -10 or > 10)
            return Results.BadRequest(new { error = "A printer nudge is at most 10 mm either way." });

        await letterheads.UpdateAsync(id, edit, actor, ct).ConfigureAwait(false);
        var after = (await letterheads.GetAsync(id, ct).ConfigureAwait(false))!;
        audit.Log("settings.letterhead", actor: actor, ip: Audit.AuditIp.From(http),
            details: new { op = "update", id, from = View(before), to = View(after) });
        return Results.Ok(View(after));
    }

    private static async Task<IResult> SetActive(
        int id, ActiveBody body, System.Security.Claims.ClaimsPrincipal principal, HttpContext http,
        LetterheadRepository letterheads, Audit.AuditLog audit, CancellationToken ct)
    {
        if (!IsEditor(principal) || principal.UserId() is not int actor) return Results.NotFound();
        if (await letterheads.GetAsync(id, ct).ConfigureAwait(false) is null) return Results.NotFound();
        await letterheads.SetActiveAsync(id, body.Active, actor, ct).ConfigureAwait(false);
        audit.Log("settings.letterhead", actor: actor, ip: Audit.AuditIp.From(http), details: new { op = "active", id, body.Active });
        return Results.Ok(View((await letterheads.GetAsync(id, ct).ConfigureAwait(false))!));
    }

    private static async Task<IResult> SetClients(
        int id, ClientsBody body, System.Security.Claims.ClaimsPrincipal principal, HttpContext http,
        LetterheadRepository letterheads, Audit.AuditLog audit, CancellationToken ct)
    {
        if (!IsEditor(principal) || principal.UserId() is not int actor) return Results.NotFound();
        var before = await letterheads.GetAsync(id, ct).ConfigureAwait(false);
        if (before is null) return Results.NotFound();
        var codes = (body.Clients ?? [])
            .Select(c => c?.Trim().ToUpperInvariant() ?? string.Empty)
            .Where(c => c.Length is > 0 and <= 50)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();
        if (codes.Count > 500) return Results.BadRequest(new { error = "Up to 500 client codes per letterhead." });
        var unknown = await letterheads.SetClientsAsync(id, codes, actor, ct).ConfigureAwait(false);
        var after = (await letterheads.GetAsync(id, ct).ConfigureAwait(false))!;
        audit.Log("settings.letterhead", actor: actor, ip: Audit.AuditIp.From(http),
            details: new { op = "clients", id, from = before.Clients, to = after.Clients, unknown });
        return Results.Ok(new { letterhead = View(after), unknown });
    }

    private static async Task<IResult> GetArtwork(
        int id, System.Security.Claims.ClaimsPrincipal principal, LetterheadRepository letterheads, CancellationToken ct)
    {
        if (!IsEditor(principal)) return Results.NotFound();
        var p = await letterheads.GetAsync(id, ct).ConfigureAwait(false);
        if (p is null) return Results.NotFound();
        var art = await letterheads.GetArtworkAsync(p, ct).ConfigureAwait(false);
        return art is null ? Results.NotFound() : Results.File(art.Bytes, art.Mime);
    }

    private static async Task<IResult> UploadArtwork(
        int id, HttpRequest request, System.Security.Claims.ClaimsPrincipal principal, HttpContext http,
        LetterheadRepository letterheads, Audit.AuditLog audit, CancellationToken ct)
    {
        if (!IsEditor(principal) || principal.UserId() is not int actor) return Results.NotFound();
        if (await letterheads.GetAsync(id, ct).ConfigureAwait(false) is null) return Results.NotFound();
        if (!request.HasFormContentType) return Results.BadRequest(new { error = "Upload the file as form data." });
        var form = await request.ReadFormAsync(ct).ConfigureAwait(false);
        var file = form.Files.GetFile("file");
        if (file is null || file.Length == 0) return Results.BadRequest(new { error = "No file was supplied." });
        if (file.Length > LetterheadRepository.MaxArtworkBytes)
            return Results.BadRequest(new { error = "That file is too large. The limit is 8 MB." });

        using var ms = new MemoryStream();
        await file.CopyToAsync(ms, ct).ConfigureAwait(false);
        var bytes = ms.ToArray();
        // The bytes say what the file is; the browser's label is not trusted.
        var mime = Sniff(bytes);
        if (mime is null) return Results.BadRequest(new { error = "Upload a PDF, PNG or JPEG of the full A4 letterhead." });

        await letterheads.SetArtworkAsync(id, bytes, mime, actor, ct).ConfigureAwait(false);
        audit.Log("settings.letterhead", actor: actor, ip: Audit.AuditIp.From(http),
            details: new { op = "artwork", id, mime, bytes = bytes.Length, file.FileName });
        return Results.Ok(View((await letterheads.GetAsync(id, ct).ConfigureAwait(false))!));
    }

    private static string? Sniff(byte[] b)
    {
        if (b.Length > 4 && b[0] == 0x25 && b[1] == 0x50 && b[2] == 0x44 && b[3] == 0x46) return "application/pdf";
        if (b.Length > 8 && b[0] == 0x89 && b[1] == 0x50 && b[2] == 0x4E && b[3] == 0x47) return "image/png";
        if (b.Length > 3 && b[0] == 0xFF && b[1] == 0xD8 && b[2] == 0xFF) return "image/jpeg";
        return null;
    }

    private static async Task<IResult> DeleteArtwork(
        int id, System.Security.Claims.ClaimsPrincipal principal, HttpContext http,
        LetterheadRepository letterheads, Audit.AuditLog audit, CancellationToken ct)
    {
        if (!IsEditor(principal) || principal.UserId() is not int actor) return Results.NotFound();
        if (await letterheads.GetAsync(id, ct).ConfigureAwait(false) is null) return Results.NotFound();
        await letterheads.SetArtworkAsync(id, null, null, actor, ct).ConfigureAwait(false);
        audit.Log("settings.letterhead", actor: actor, ip: Audit.AuditIp.From(http), details: new { op = "artwork_removed", id });
        return Results.Ok(View((await letterheads.GetAsync(id, ct).ConfigureAwait(false))!));
    }

    private static async Task<IResult> GetCalibration(
        int id, System.Security.Claims.ClaimsPrincipal principal, LetterheadRepository letterheads, RenderClient render, CancellationToken ct)
    {
        if (!IsEditor(principal)) return Results.NotFound();
        var p = await letterheads.GetAsync(id, ct).ConfigureAwait(false);
        if (p is null) return Results.NotFound();
        var art = await letterheads.GetArtworkAsync(p, ct).ConfigureAwait(false);
        try
        {
            var pdf = await render.CalibrationAsync(p, art, ct).ConfigureAwait(false);
            return Results.File(pdf, "application/pdf", $"letterhead-{p.Id}-calibration.pdf");
        }
        catch (RenderFailedException)
        {
            return Results.Problem("The calibration sheet could not be drawn.", statusCode: StatusCodes.Status502BadGateway);
        }
    }
}
