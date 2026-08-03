using Microsoft.AspNetCore.Authentication.JwtBearer;

namespace Infinity.Api.Auth;

/// <summary>
/// Turns stateless JWTs into revocable ones.
///
/// A signed token is valid until it expires, which means a disabled account, a
/// demoted role, or a reset password would all keep working for the rest of the
/// token's lifetime. Every admin procedure bumps
/// dbo.inf_user_session_version; this check compares the token's <c>sv</c> claim
/// against the current value and rejects the token if it is stale.
/// </summary>
public static class SessionVersionValidator
{
    public static JwtBearerEvents Create() => new()
    {
        OnTokenValidated = async context =>
        {
            var principal = context.Principal;
            if (principal is null)
            {
                context.Fail("No principal.");
                return;
            }

            var userId = principal.UserId();
            if (userId is null)
            {
                context.Fail("Token has no subject.");
                return;
            }

            var claimed = principal.FindFirst(JwtIssuer.SessionVersionClaim)?.Value;
            if (!int.TryParse(claimed, out var tokenVersion))
            {
                context.Fail("Token has no session version.");
                return;
            }

            var repo = context.HttpContext.RequestServices.GetRequiredService<AuthRepository>();

            // Fails open on a database error (returns `tokenVersion`), so an
            // outage does not sign out every user simultaneously.
            var current = await repo.GetSessionVersionAsync(
                userId.Value, tokenVersion, context.HttpContext.RequestAborted).ConfigureAwait(false);

            if (current != tokenVersion)
            {
                context.HttpContext.RequestServices
                    .GetRequiredService<ILoggerFactory>()
                    .CreateLogger("Auth")
                    .LogInformation("auth.session.revoked userId={UserId} token={TokenVersion} current={Current}",
                        userId, tokenVersion, current);

                context.Fail("Session has been revoked.");
            }
        },
    };
}
