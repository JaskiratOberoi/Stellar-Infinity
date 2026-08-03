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
        admin.MapPost("/users", CreateUser).WithName("CreateUser");
        admin.MapPut("/users/{userId:int}/lis-access", SetLisAccess).WithName("SetLisAccess");
        admin.MapPut("/users/{userId:int}/active", SetActive).WithName("SetActive");
        admin.MapPut("/users/{userId:int}/role", SetRole).WithName("SetRole");
        admin.MapPut("/users/{userId:int}/password", ResetPassword).WithName("ResetPassword");

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
