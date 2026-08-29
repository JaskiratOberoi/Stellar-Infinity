using System.Security.Claims;
using Infinity.Api.Admin;
using Infinity.Api.Auth;

namespace Infinity.Api.Endpoints;

public static class AdminEndpoints
{
    public sealed record SetFlagRequest(bool Enabled);
    public sealed record SetRoleRequest(string Role);
    public sealed record ResetPasswordRequest(string Password);

    public static void MapAdminEndpoints(this WebApplication app)
    {
        // Every route in this group requires user:manage — applied to the group
        // so a new admin endpoint cannot be added without the gate.
        var admin = app.MapGroup("/api/admin")
                       .RequireAuthorization()
                       .RequireCapability(Capabilities.UserManage);

        admin.MapGet("/users", ListUsers).WithName("ListUsers");
        admin.MapGet("/users/{userId:int}", GetUserDetail).WithName("GetUserDetail");
        admin.MapGet("/users/{userId:int}/client-codes/search", SearchClientCodes).WithName("SearchClientCodes");
        admin.MapPut("/users/{userId:int}/client-codes", SetClientCodes).WithName("SetClientCodes");
        admin.MapPut("/users/{userId:int}/profile", UpdateProfile).WithName("UpdateProfile");
        admin.MapPost("/users", CreateUser).WithName("CreateUser");
        admin.MapPut("/users/{userId:int}/lis-access", SetLisAccess).WithName("SetLisAccess");
        admin.MapPut("/users/{userId:int}/active", SetActive).WithName("SetActive");
        admin.MapPut("/users/{userId:int}/role", SetRole).WithName("SetRole");
        admin.MapPut("/users/{userId:int}/capability-grant", SetCapabilityGrant)
             .WithName("SetCapabilityGrant");
        admin.MapPut("/users/{userId:int}/password", ResetPassword).WithName("ResetPassword");
        // Reveal the current plaintext password. Audited on every call.
        admin.MapGet("/users/{userId:int}/password", ViewPassword).WithName("ViewPassword");

        // Centre balance-lock controls. Reached from a client account's
        // settings (their own centre), but addressed by centre id because the
        // lock is a property of the centre, not the user.
        admin.MapGet("/centres/lock-state", GetCentreLockState).WithName("GetCentreLockState");
        admin.MapPut("/centres/{mcc:int}/permanent-unlock", SetPermanentUnlock).WithName("SetPermanentUnlock");
        admin.MapPost("/centres/{mcc:int}/temp-unlock", GrantTempUnlock).WithName("GrantTempUnlock");

        admin.MapGet("/roles", () => Results.Ok(
            InfinityRoles.All.Select(r => new
            {
                role = r,
                capabilities = InfinityRoles.CapabilitiesFor(r).OrderBy(c => c, StringComparer.Ordinal).ToArray(),
            })));
    }

    private static async Task<IResult> ListUsers(
        AdminRepository repo,
        CancellationToken ct,
        string? search = null,
        int page = 1,
        int pageSize = 50)
    {
        var result = await repo.ListUsersAsync(search, page, pageSize, ct).ConfigureAwait(false);
        return Results.Ok(result);
    }

    public sealed record SetClientCodesRequest(IReadOnlyList<string> Codes);

    private static async Task<IResult> GetUserDetail(int userId, AdminRepository repo, CancellationToken ct)
    {
        var detail = await repo.GetUserDetailAsync(userId, ct).ConfigureAwait(false);
        return detail is null ? Results.NotFound() : Results.Ok(detail);
    }

    private static async Task<IResult> SearchClientCodes(
        int userId, AdminRepository repo, CancellationToken ct,
        string? search = null, int page = 1, int pageSize = 50)
    {
        var result = await repo.SearchClientCodesAsync(userId, search, page, pageSize, ct).ConfigureAwait(false);
        return Results.Ok(new
        {
            options = result.Rows,
            total = result.Total,
            page = result.Page,
            pageSize = result.PageSize,
            pageCount = result.PageCount,
        });
    }

    /// <summary>
    /// Replace a user's client-code access.
    ///
    /// This decides whose patients the user can see, so the result is audited
    /// per code with the previous owner of each removed mapping — "access
    /// changed" alone would not survive a later question about who lost what.
    /// The in-process scope cache is invalidated immediately; the procedure has
    /// already bumped the session version so outstanding tokens die too.
    /// </summary>
    private static async Task<IResult> SetClientCodes(
        int userId,
        SetClientCodesRequest request,
        AdminRepository repo,
        ScopeRepository scopes,
        Audit.AuditRepository audit,
        ClaimsPrincipal principal,
        HttpContext http,
        CancellationToken ct)
    {
        if (principal.UserId() is not int actor) return Results.Unauthorized();
        if (request.Codes is null) return Results.BadRequest(new { error = "A codes array is required (send [] to revoke all)." });
        if (request.Codes.Count > 2000) return Results.BadRequest(new { error = "Too many codes in one request." });

        var result = await repo.SetClientCodesAsync(userId, request.Codes, actor, ct).ConfigureAwait(false);

        if (!result.Ok)
        {
            return MapFailure(new SpResult(false, result.ErrorCode, result.Message));
        }

        // Cluster-wide now: with the in-process cache this only cleared the
        // instance that served the admin request, so every other instance kept
        // serving the old client-code scope until its own TTL expired.
        await scopes.InvalidateAsync(userId, ct).ConfigureAwait(false);

        if (result.Changes.Count > 0)
        {
            var granted = result.Changes.Where(c => c.Change == "added").Select(c => c.ClientCode);
            var revoked = result.Changes.Where(c => c.Change == "removed")
                                        .Select(c => c.PriorOwner is { Length: > 0 } o && !o.StartsWith("inf:", StringComparison.OrdinalIgnoreCase)
                                            ? $"{c.ClientCode}(was {o})"
                                            : c.ClientCode);

            await audit.WriteAuthEventAsync(new Audit.AuthAuditEntry
            {
                Event = Audit.AuthEvent.ScopeChange,
                ActorUserId = actor,
                TargetUserId = userId,
                Detail = Trim500($"granted=[{string.Join(' ', granted)}] revoked=[{string.Join(' ', revoked)}]"),
            }, Audit.AuditActorAccessor.For(http), ct).ConfigureAwait(false);
        }

        return Results.Ok(new { added = result.Added, removed = result.Removed, changes = result.Changes });
    }

    private static async Task<IResult> UpdateProfile(
        int userId,
        UpdateProfileRequest request,
        AdminRepository repo,
        Audit.AuditRepository audit,
        ClaimsPrincipal principal,
        HttpContext http,
        CancellationToken ct)
    {
        if (principal.UserId() is not int actor) return Results.Unauthorized();
        if (string.IsNullOrWhiteSpace(request.FirstName))
            return Results.BadRequest(new { error = "A first name is required." });

        var result = await repo.UpdateProfileAsync(userId, request, actor, ct).ConfigureAwait(false);
        if (!result.Ok) return MapFailure(result);

        await audit.WriteAuthEventAsync(new Audit.AuthAuditEntry
        {
            Event = Audit.AuthEvent.ProfileChange,
            ActorUserId = actor,
            TargetUserId = userId,
            Detail = Trim500($"name={request.FirstName} {request.LastName} email={request.Email}"),
        }, Audit.AuditActorAccessor.For(http), ct).ConfigureAwait(false);

        return Results.NoContent();
    }

    private static string Trim500(string s) => s.Length <= 500 ? s : s[..500];

    private static async Task<IResult> CreateUser(
        CreateUserRequest request,
        AdminRepository repo,
        ClaimsPrincipal principal,
        ILoggerFactory loggerFactory,
        CancellationToken ct)
    {
        if (principal.UserId() is not int actor) return Results.Unauthorized();

        if (string.IsNullOrWhiteSpace(request.Username) || string.IsNullOrWhiteSpace(request.Password))
        {
            return Results.BadRequest(new { error = "Username and password are required." });
        }

        // Checked here as well as in SQL so the caller gets a clean 400 with the
        // valid options, rather than a generic procedure error.
        if (!InfinityRoles.IsValid(request.InfinityRole))
        {
            return Results.BadRequest(new
            {
                error = $"Unknown role '{request.InfinityRole}'.",
                validRoles = InfinityRoles.All.ToArray(),
            });
        }

        var result = await repo.CreateUserAsync(request, actor, ct).ConfigureAwait(false);

        if (!result.Ok) return MapFailure(result);

        loggerFactory.CreateLogger("Admin").LogInformation(
            "admin.user.created userId={UserId} role={Role} lisAccess={LisAccess} actor={Actor}",
            result.UserId, request.InfinityRole, request.GrantLisAccess, actor);

        return Results.Created($"/api/admin/users/{result.UserId}", new { userId = result.UserId });
    }

    /// <summary>
    /// THE LIS access switch. Granting sets tbl_med_user_master.IsActive = 1,
    /// which is the only gate the legacy LIS reads — so these credentials start
    /// working on the LIS immediately. Revoking sets it back to 0.
    /// Only valid for Infinity-created accounts; SQL enforces that.
    /// </summary>
    private static async Task<IResult> SetLisAccess(
        int userId,
        SetFlagRequest request,
        AdminRepository repo,
        ClaimsPrincipal principal,
        ILoggerFactory loggerFactory,
        CancellationToken ct)
    {
        if (principal.UserId() is not int actor) return Results.Unauthorized();

        var result = await repo.SetLisAccessAsync(userId, request.Enabled, actor, ct).ConfigureAwait(false);
        if (!result.Ok) return MapFailure(result);

        loggerFactory.CreateLogger("Admin").LogWarning(
            "admin.user.lisAccess userId={UserId} enabled={Enabled} actor={Actor}",
            userId, request.Enabled, actor);

        return Results.NoContent();
    }

    private static async Task<IResult> SetActive(
        int userId,
        SetFlagRequest request,
        AdminRepository repo,
        ClaimsPrincipal principal,
        CancellationToken ct)
    {
        if (principal.UserId() is not int actor) return Results.Unauthorized();

        var result = await repo.SetActiveAsync(userId, request.Enabled, actor, ct).ConfigureAwait(false);
        return result.Ok ? Results.NoContent() : MapFailure(result);
    }

    public sealed record CapabilityGrantRequest(string Capability, bool Granted);

    /// <summary>
    /// Grant or revoke ONE per-user capability - today, walk-in ordering for a
    /// collection centre that the lab has chosen to allow.
    ///
    /// The grantable set is enforced twice below this: the procedure names it,
    /// and the table's CHECK constraint is the backstop. Neither trusts this
    /// endpoint, which is the point - a per-user grant path that accepted any
    /// capability string would be a way to hand out user:manage.
    ///
    /// The procedure bumps the target's session version, so a revoke takes
    /// effect on their next request rather than when their token expires.
    /// </summary>
    private static async Task<IResult> SetCapabilityGrant(
        int userId,
        CapabilityGrantRequest body,
        System.Security.Claims.ClaimsPrincipal principal,
        AdminRepository repo,
        CancellationToken ct)
    {
        if (principal.UserId() is not int actor) return Results.Unauthorized();
        if (string.IsNullOrWhiteSpace(body?.Capability))
            return Results.BadRequest(new { error = "A capability is required." });

        var r = await repo.SetCapabilityGrantAsync(
            userId, body.Capability.Trim(), body.Granted, actor, ct).ConfigureAwait(false);

        return r.Ok
            ? Results.Ok(new { ok = true, message = r.Message })
            : Results.BadRequest(new { error = r.Message, code = r.ErrorCode });
    }

    private static async Task<IResult> SetRole(
        int userId,
        SetRoleRequest request,
        AdminRepository repo,
        ClaimsPrincipal principal,
        CancellationToken ct)
    {
        if (principal.UserId() is not int actor) return Results.Unauthorized();

        if (!InfinityRoles.IsValid(request.Role))
        {
            return Results.BadRequest(new
            {
                error = $"Unknown role '{request.Role}'.",
                validRoles = InfinityRoles.All.ToArray(),
            });
        }

        var result = await repo.SetRoleAsync(userId, request.Role, actor, ct).ConfigureAwait(false);
        return result.Ok ? Results.NoContent() : MapFailure(result);
    }

    private static async Task<IResult> ResetPassword(
        int userId,
        ResetPasswordRequest request,
        AdminRepository repo,
        ClaimsPrincipal principal,
        CancellationToken ct)
    {
        if (principal.UserId() is not int actor) return Results.Unauthorized();

        if (string.IsNullOrWhiteSpace(request.Password) || request.Password.Length > 50)
        {
            return Results.BadRequest(new { error = "A password of 1-50 characters is required." });
        }

        var result = await repo.ResetPasswordAsync(userId, request.Password, actor, ct).ConfigureAwait(false);
        return result.Ok ? Results.NoContent() : MapFailure(result);
    }

    private static async Task<IResult> ViewPassword(
        int userId,
        AdminRepository repo,
        ClaimsPrincipal principal,
        Audit.AuditLog audit,
        HttpContext http,
        CancellationToken ct)
    {
        if (principal.UserId() is not int actor) return Results.Unauthorized();

        var (result, password) = await repo.ViewPasswordAsync(userId, actor, ct).ConfigureAwait(false);
        if (!result.Ok) return MapFailure(result);

        // The reveal is the sensitive act, so it is logged whether or not the
        // admin then does anything with what they saw. The password itself is
        // never put in the audit detail — only that it was viewed, and by whom.
        audit.Log("admin.password.viewed", actor: actor, ip: Audit.AuditIp.From(http),
            details: new { targetUserId = userId });

        return Results.Ok(new { password });
    }

    private static async Task<IResult> GetCentreLockState(
        AdminRepository repo, CancellationToken ct, string? mccIds = null)
    {
        var ids = (mccIds ?? "")
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(s => int.TryParse(s, out var n) ? n : (int?)null)
            .Where(n => n is > 0).Select(n => n!.Value)
            .Distinct().Take(50).ToList();
        if (ids.Count == 0) return Results.Ok(new { centres = Array.Empty<object>() });

        var states = await repo.CentreLockStatesAsync(ids, ct).ConfigureAwait(false);
        return Results.Ok(new { centres = states });
    }

    private static async Task<IResult> SetPermanentUnlock(
        int mcc,
        SetFlagRequest request,
        AdminRepository repo,
        ClaimsPrincipal principal,
        Audit.AuditLog audit,
        HttpContext http,
        CancellationToken ct)
    {
        if (principal.UserId() is not int actor) return Results.Unauthorized();

        var result = await repo.SetPermanentUnlockAsync(mcc, request.Enabled, actor, ct).ConfigureAwait(false);
        if (!result.Ok) return MapFailure(result);

        // Real money implication — a permanently-unlocked centre is never
        // balance-locked — so it goes in the trail with the new state.
        audit.Log("centre.unlock.permanent", actor: actor, ip: Audit.AuditIp.From(http),
            details: new { mcc, enabled = request.Enabled });

        return Results.NoContent();
    }

    public sealed record TempUnlockRequest(int Hours);

    private static async Task<IResult> GrantTempUnlock(
        int mcc,
        TempUnlockRequest request,
        AdminRepository repo,
        ClaimsPrincipal principal,
        Audit.AuditLog audit,
        HttpContext http,
        CancellationToken ct)
    {
        if (principal.UserId() is not int actor) return Results.Unauthorized();

        var (result, expire) = await repo.GrantTempUnlockAsync(mcc, request.Hours, actor, ct).ConfigureAwait(false);
        if (!result.Ok) return MapFailure(result);

        audit.Log("centre.unlock.temp", actor: actor, ip: Audit.AuditIp.From(http),
            details: new { mcc, hours = request.Hours, until = expire });

        return Results.Ok(new { expire });
    }

    /// <summary>Map the procedures' error_code onto the right HTTP status.</summary>
    private static IResult MapFailure(SpResult result) => result.ErrorCode switch
    {
        "NOT_FOUND" => Results.NotFound(new { error = result.Message }),
        "VALIDATION" => Results.BadRequest(new { error = result.Message }),
        "CONFLICT" => Results.Conflict(new { error = result.Message }),
        "FORBIDDEN" => Results.Problem(
            title: "Forbidden", detail: result.Message, statusCode: StatusCodes.Status403Forbidden),
        _ => Results.Problem(
            title: "Operation failed", detail: result.Message, statusCode: StatusCodes.Status500InternalServerError),
    };
}
