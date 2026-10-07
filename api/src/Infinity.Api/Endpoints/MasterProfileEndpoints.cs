using Infinity.Api.Auth;
using Infinity.Api.Catalogue;

namespace Infinity.Api.Endpoints;

/// <summary>
/// Master Profiles (packages) — the port of the legacy Technical > Master
/// Profile page (script 179). Super admin and admin only, as the LIS page is
/// a Technical-menu screen; 404 for everyone else, like the other editors.
///
/// Writes land in the SHARED catalogue tables through the script's
/// procedures, so the LIS, Telo and every order procedure see the same
/// package. The rule in port-decisions ("never edit the shared catalogue
/// from Infinity") was Jas's protection against side effects while the LIS
/// was the only author; this page IS the LIS's author, re-homed, and writes
/// what it would have written.
/// </summary>
public static class MasterProfileEndpoints
{
    public static void MapMasterProfileEndpoints(this WebApplication app)
    {
        var g = app.MapGroup("/api/catalogue/master-profiles").RequireAuthorization();
        g.MapGet("/", List).WithName("ListMasterProfiles");
        g.MapGet("/picker", Picker).WithName("MasterProfilePicker");
        g.MapGet("/{id:int}", Get).WithName("GetMasterProfile");
        g.MapPost("/", Create).WithName("CreateMasterProfile");
        g.MapPut("/{id:int}", Update).WithName("UpdateMasterProfile");
        g.MapPut("/{id:int}/active", SetActive).WithName("SetMasterProfileActive");
        g.MapDelete("/{id:int}", Delete).WithName("DeleteMasterProfile");
    }

    public sealed record MemberBody(string? Kind, int Id);
    public sealed record SaveBody(string? Code, string? Name, int? Ct, int? Mrp, bool? IsActive, IReadOnlyList<MemberBody>? Members);
    public sealed record ActiveBody(bool Active);

    private static bool IsEditor(System.Security.Claims.ClaimsPrincipal p) =>
        p.Role() is InfinityRoles.SuperAdmin or InfinityRoles.Admin;

    private static string By(int actor) => $"inf:{actor}";

    private static async Task<IResult> List(
        System.Security.Claims.ClaimsPrincipal principal, MasterProfileRepository repo, CancellationToken ct,
        string? search = null, int page = 1, int pageSize = 50)
    {
        if (!IsEditor(principal)) return Results.NotFound();
        var (rows, total) = await repo.ListAsync(search, page, Math.Clamp(pageSize, 1, 200), ct).ConfigureAwait(false);
        return Results.Ok(new { rows, total, page, pageSize });
    }

    private static async Task<IResult> Picker(
        System.Security.Claims.ClaimsPrincipal principal, MasterProfileRepository repo, CancellationToken ct,
        string kind = "test", string? search = null)
    {
        if (!IsEditor(principal)) return Results.NotFound();
        kind = kind.Trim().ToLowerInvariant();
        if (kind is not ("test" or "profile"))
            return Results.BadRequest(new { error = "kind must be test or profile." });
        return Results.Ok(await repo.PickerAsync(kind, search, ct).ConfigureAwait(false));
    }

    private static async Task<IResult> Get(
        int id, System.Security.Claims.ClaimsPrincipal principal, MasterProfileRepository repo, CancellationToken ct)
    {
        if (!IsEditor(principal)) return Results.NotFound();
        var d = await repo.GetAsync(id, ct).ConfigureAwait(false);
        return d is null ? Results.NotFound() : Results.Ok(d);
    }

    private static (IReadOnlyList<MemberRef> Members, IResult? Error) ReadMembers(SaveBody body)
    {
        var list = new List<MemberRef>();
        foreach (var m in body.Members ?? [])
        {
            var kind = (m.Kind ?? string.Empty).Trim().ToLowerInvariant();
            if (kind is not ("test" or "profile") || m.Id <= 0)
                return ([], Results.BadRequest(new { error = "Each member is a test or a profile with an id." }));
            if (!list.Any(x => x.Kind == kind && x.Id == m.Id)) list.Add(new MemberRef(kind, m.Id));
        }
        return (list, null);
    }

    private static async Task<IResult> Save(
        int? id, SaveBody body, System.Security.Claims.ClaimsPrincipal principal, HttpContext http,
        MasterProfileRepository repo, Audit.AuditLog audit, CancellationToken ct)
    {
        if (!IsEditor(principal) || principal.UserId() is not int actor) return Results.NotFound();
        var code = (body.Code ?? string.Empty).Trim();
        var name = (body.Name ?? string.Empty).Trim();
        if (code.Length is 0 or > 100) return Results.BadRequest(new { error = "A package needs a code of up to 100 characters." });
        if (name.Length is 0 or > 400) return Results.BadRequest(new { error = "A package needs a name of up to 400 characters." });
        if (body.Ct is < 0 || body.Mrp is < 0) return Results.BadRequest(new { error = "CT and MRP cannot be negative." });
        var (members, err) = ReadMembers(body);
        if (err is not null) return err;

        var res = await repo.SaveAsync(id, code, name, body.Ct, body.Mrp, body.IsActive ?? true, members, By(actor), ct)
            .ConfigureAwait(false);
        if (!res.Ok)
        {
            return res.ErrorCode == "NOT_FOUND"
                ? Results.NotFound()
                : Results.BadRequest(new { error = res.Message ?? "The package could not be saved.", code = res.ErrorCode });
        }
        audit.Log("catalogue.master_profile", actor: actor, ip: Audit.AuditIp.From(http),
            details: new { op = id is null ? "create" : "update", id = res.Id, code, name, body.Ct, body.Mrp, active = body.IsActive ?? true,
                           profiles = members.Count(m => m.Kind == "profile"), tests = members.Count(m => m.Kind == "test") });
        var d = await repo.GetAsync(res.Id!.Value, ct).ConfigureAwait(false);
        return Results.Ok(d);
    }

    private static Task<IResult> Create(
        SaveBody body, System.Security.Claims.ClaimsPrincipal principal, HttpContext http,
        MasterProfileRepository repo, Audit.AuditLog audit, CancellationToken ct) =>
        Save(null, body, principal, http, repo, audit, ct);

    private static Task<IResult> Update(
        int id, SaveBody body, System.Security.Claims.ClaimsPrincipal principal, HttpContext http,
        MasterProfileRepository repo, Audit.AuditLog audit, CancellationToken ct) =>
        Save(id, body, principal, http, repo, audit, ct);

    private static async Task<IResult> SetActive(
        int id, ActiveBody body, System.Security.Claims.ClaimsPrincipal principal, HttpContext http,
        MasterProfileRepository repo, Audit.AuditLog audit, CancellationToken ct)
    {
        if (!IsEditor(principal) || principal.UserId() is not int actor) return Results.NotFound();
        if (!await repo.SetActiveAsync(id, body.Active, By(actor), ct).ConfigureAwait(false)) return Results.NotFound();
        audit.Log("catalogue.master_profile", actor: actor, ip: Audit.AuditIp.From(http), details: new { op = "active", id, body.Active });
        return Results.Ok(await repo.GetAsync(id, ct).ConfigureAwait(false));
    }

    private static async Task<IResult> Delete(
        int id, System.Security.Claims.ClaimsPrincipal principal, HttpContext http,
        MasterProfileRepository repo, Audit.AuditLog audit, CancellationToken ct)
    {
        if (!IsEditor(principal) || principal.UserId() is not int actor) return Results.NotFound();
        // The package as it was, into the audit row: a delete here removes
        // every member and rate row, and the log is the only record left.
        var before = await repo.GetAsync(id, ct).ConfigureAwait(false);
        if (before is null) return Results.NotFound();
        var res = await repo.DeleteAsync(id, ct).ConfigureAwait(false);
        if (!res.Ok)
            return res.ErrorCode == "NOT_FOUND"
                ? Results.NotFound()
                : Results.BadRequest(new { error = res.Message ?? "The package could not be deleted.", code = res.ErrorCode });
        audit.Log("catalogue.master_profile", actor: actor, ip: Audit.AuditIp.From(http),
            details: new { op = "delete", id, before.Code, before.Name, before.Ct, before.Mrp,
                           members = before.Members.Select(m => new { m.Kind, m.Id, name = m.SnapshotName }) });
        return Results.Ok(new { ok = true });
    }
}
