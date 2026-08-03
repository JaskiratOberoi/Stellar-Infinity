using System.Security.Claims;
using Infinity.Api.Auth;

namespace Infinity.Api.Endpoints;

public static class AuthEndpoints
{
    public static void MapAuthEndpoints(this WebApplication app)
    {
        var auth = app.MapGroup("/api/auth");

        auth.MapPost("/login", Login)
            .AllowAnonymous()
            .RequireRateLimiting(RateLimitPolicies.Login)
            .WithName("Login");

        auth.MapGet("/me", Me)
            .RequireAuthorization()
            .WithName("Me");
    }

    /// <summary>
    /// Sign in with LIS credentials.
    ///
    /// Every failure returns the same 401 and the same message. Distinguishing
    /// "no such user" from "wrong password" from "account disabled" turns this
    /// into an account-enumeration oracle, which matters more than usual here
    /// because the usernames are staff names.
    /// </summary>
    private static async Task<IResult> Login(
        LoginRequest request,
        AuthRepository authRepo,
        JwtIssuer jwt,
        Audit.AuditRepository audit,
        ILoggerFactory loggerFactory,
        HttpContext http,
        CancellationToken ct)
    {
        var logger = loggerFactory.CreateLogger("Auth");

        var username = request.Username?.Trim() ?? "";
        var actor = Audit.AuditActorAccessor.ForAnonymous(http, username);

        if (username.Length is 0 or > 50 || string.IsNullOrEmpty(request.Password) || request.Password.Length > 50)
        {
            return Unauthorized();
        }

        var row = await authRepo.AuthenticateAsync(username, request.Password, ct).ConfigureAwait(false);

        if (row is null)
        {
            // Log the attempt, never the password. The audit write is
            // best-effort and cannot turn a logging fault into an outage.
            logger.LogInformation("auth.login.failure username={Username}", username);
            await audit.WriteAuthEventAsync(new Audit.AuthAuditEntry
            {
                Event = Audit.AuthEvent.LoginFailed,
                ActorUsername = username,
                Succeeded = false,
                Detail = "Invalid credentials, or the account is not permitted to use Infinity.",
            }, actor, ct).ConfigureAwait(false);

            return Unauthorized();
        }

        var user = ToAuthenticatedUser(row);
        var (token, expiresAt) = jwt.Issue(user, row.SessionVersion);

        logger.LogInformation("auth.login.success userId={UserId} role={Role} managedBy={ManagedBy}",
            row.UserId, user.Role, user.ManagedBy);

        await audit.WriteAuthEventAsync(new Audit.AuthAuditEntry
        {
            Event = Audit.AuthEvent.Login,
            ActorUserId = row.UserId,
            ActorUsername = row.Username,
            Detail = $"role={user.Role} managedBy={user.ManagedBy}",
        }, actor with { UserId = row.UserId, Username = row.Username }, ct).ConfigureAwait(false);

        return Results.Ok(new LoginResponse(token, expiresAt, user));
    }

    /// <summary>The current token's identity, for the SPA to render nav and gates.</summary>
    private static IResult Me(ClaimsPrincipal principal)
    {
        var userId = principal.UserId();
        if (userId is null) return Results.Unauthorized();

        return Results.Ok(new
        {
            userId,
            username = principal.Identity?.Name,
            role = principal.FindFirstValue(ClaimTypes.Role),
            capabilities = principal.FindAll(JwtIssuer.CapabilityClaim).Select(c => c.Value).ToArray(),
            managedBy = principal.FindFirstValue(JwtIssuer.ManagedByClaim),
            lisAccess = principal.FindFirstValue(JwtIssuer.LisAccessClaim) == "1",
        });
    }

    internal static AuthenticatedUser ToAuthenticatedUser(AuthRow row)
    {
        var role = InfinityRoles.Resolve(row.InfinityRole, row.UsertypeId);
        var caps = InfinityRoles.CapabilitiesFor(role);

        var displayName = string.Join(' ', new[] { row.FirstName, row.LastName }
            .Where(s => !string.IsNullOrWhiteSpace(s))).Trim();

        var managedBy = row.IsInfinityManaged ? "infinity" : row.IsTeloManaged ? "telo" : "lis";

        return new AuthenticatedUser(
            UserId: row.UserId,
            Username: row.Username,
            DisplayName: string.IsNullOrEmpty(displayName) ? null : displayName,
            Email: row.Email,
            Role: role,
            Capabilities: caps.ToArray(),
            UsertypeId: row.UsertypeId,
            UsertypeName: row.UsertypeName,
            ManagedBy: managedBy,
            LisAccess: row.LisAccess);
    }

    private static IResult Unauthorized() => Results.Problem(
        title: "Unauthorized",
        detail: "Invalid username or password.",
        statusCode: StatusCodes.Status401Unauthorized);
}
