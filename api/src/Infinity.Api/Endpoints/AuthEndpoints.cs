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

        auth.MapPost("/logout", Logout)
            .RequireAuthorization()
            .WithName("Logout");
    }

    /// <summary>
    /// Sign out.
    ///
    /// The JWT is stateless, so this cannot invalidate the token itself — the
    /// browser discarding it is what ends the session. What this DOES do is
    /// drop server-side state the session had earned, which the browser cannot
    /// clear on its own: the Jarvis unlock grant, so signing out and back in
    /// re-locks auto-authorisation rather than silently resuming it — and the
    /// order cart, so the next session starts with an empty form instead of
    /// the shopping of a session that chose to end.
    ///
    /// Best-effort by design. A logout that fails must still let the client
    /// discard its token, so this never returns an error the UI would act on.
    /// </summary>
    private static async Task<IResult> Logout(
        ClaimsPrincipal principal,
        Infinity.Api.Worksheet.AutoAuthGate jarvis,
        Orders.CartStore carts,
        Microsoft.Extensions.Options.IOptions<AuthCookieOptions> cookieOptions,
        HttpContext http,
        ILoggerFactory loggerFactory,
        CancellationToken ct)
    {
        // Clear FIRST, so a failure in the revoke below still ends the session.
        AuthCookies.Clear(http.Response, cookieOptions.Value);

        if (principal.UserId() is int uid)
        {
            try
            {
                await jarvis.RevokeAsync(uid, principal.SessionVersion(), ct).ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                loggerFactory.CreateLogger("Logout").LogWarning(ex, "logout.revoke.failed userId={UserId}", uid);
            }
            try
            {
                await carts.ClearAsync(uid, ct).ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                loggerFactory.CreateLogger("Logout").LogWarning(ex, "logout.cart.failed userId={UserId}", uid);
            }
        }

        return Results.Ok(new { ok = true });
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
        Microsoft.Extensions.Options.IOptions<AuthCookieOptions> cookieOptions,
        Audit.AuditRepository audit,
        Caching.DistributedRateLimiter limiter,
        Orders.CartStore carts,
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

        /* Cluster-wide brute-force limit, on top of the per-instance ASP.NET
           one on this route. The in-process limiter alone multiplies by the
           instance count, so eight attempts becomes eight PER container.
           Partitioned by username+IP for the same reason as the in-process
           policy: whole collection centres share one NAT address, so an
           IP-only bucket lets one fat-fingered password lock out a branch. */
        var ip = http.Connection.RemoteIpAddress?.ToString() ?? "unknown";
        var verdict = await limiter.CheckAsync(
            $"login:{username.ToLowerInvariant()}|{ip}", limit: 8, TimeSpan.FromMinutes(15), ct)
            .ConfigureAwait(false);

        if (!verdict.Allowed)
        {
            await audit.WriteAuthEventAsync(new Audit.AuthAuditEntry
            {
                Event = Audit.AuthEvent.LoginBlocked,
                ActorUsername = username,
                Succeeded = false,
                Detail = $"Rate limited after {verdict.Count} attempts in 15 minutes.",
            }, actor, ct).ConfigureAwait(false);

            return Results.Problem(
                title: "Too many attempts",
                detail: "Too many sign-in attempts. Try again in a few minutes.",
                statusCode: StatusCodes.Status429TooManyRequests);
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

        // Per-user grants sit ON TOP of the role - today, walk-in ordering for
        // a client account the lab has chosen to allow. Assembled here because
        // capabilities are baked into the token and this is the only moment
        // they exist; the grant procedure bumps the session version so a
        // revoke cannot outlive it.
        // A NEW session starts with an empty order form. Logout clears the
        // cart too, but sessions also end by expiry or a closed browser, and
        // this is the one gate every fresh session passes through — without
        // it, a basket abandoned days ago greets every login. Best-effort:
        // an unreachable Redis must not block a sign-in.
        try { await carts.ClearAsync(row.UserId, ct).ConfigureAwait(false); }
        catch (Exception ex) { logger.LogWarning(ex, "login.cart.clear.failed userId={UserId}", row.UserId); }

        var grants = await authRepo.GrantedCapabilitiesAsync(row.UserId, ct).ConfigureAwait(false);
        var user = ToAuthenticatedUser(row, grants);
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

        // The token goes into an httpOnly cookie, NOT the response body. It is
        // deliberately no longer readable by script — that is the whole point
        // of the move, and returning it here too would hand the XSS surface
        // straight back.
        var csrf = AuthCookies.NewCsrfToken();
        AuthCookies.Issue(http.Response, cookieOptions.Value, token, csrf, expiresAt);

        return Results.Ok(new LoginResponse(expiresAt, user));
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

    internal static AuthenticatedUser ToAuthenticatedUser(
        AuthRow row, IReadOnlyList<string>? extraGrants = null)
    {
        var role = InfinityRoles.Resolve(row.InfinityRole, row.UsertypeId);
        // Union, never replacement: a grant ADDS to what the role gives and
        // can never remove anything.
        var caps = extraGrants is { Count: > 0 }
            ? InfinityRoles.CapabilitiesFor(role).Concat(extraGrants)
                           .Distinct(StringComparer.Ordinal).ToArray()
            : InfinityRoles.CapabilitiesFor(role).ToArray();

        var displayName = string.Join(' ', new[] { row.FirstName, row.LastName }
            .Where(s => !string.IsNullOrWhiteSpace(s))).Trim();

        var managedBy = row.IsInfinityManaged ? "infinity" : row.IsTeloManaged ? "telo" : "lis";

        return new AuthenticatedUser(
            UserId: row.UserId,
            Username: row.Username,
            DisplayName: string.IsNullOrEmpty(displayName) ? null : displayName,
            Email: row.Email,
            Role: role,
            Capabilities: caps,
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
