using System.Security.Claims;
using Infinity.Api.Auth;

namespace Infinity.Api.Audit;

/// <summary>
/// Resolves who is acting and from where, for the audit trails.
///
/// Everything here comes from the SERVER's view of the request — the user id
/// from the validated token, the IP from the connection after the forwarded-
/// headers middleware has processed it. Nothing is taken from a client-supplied
/// body field.
///
/// The legacy LIS reads HTTP_X_FORWARDED_FOR straight from the request (any
/// caller can set it) and in places logs the server's own MAC address as though
/// it identified the user. Neither is done here.
/// </summary>
public static class AuditActorAccessor
{
    public static AuditActor For(HttpContext http)
    {
        var principal = http.User;

        return new AuditActor(
            UserId: principal.UserId(),
            Username: principal.Identity?.IsAuthenticated == true
                ? principal.FindFirstValue(System.IdentityModel.Tokens.Jwt.JwtRegisteredClaimNames.UniqueName)
                : null,
            // Post-middleware RemoteIpAddress: real when the request came
            // through our own nginx, the proxy's own address otherwise. Never
            // the raw header value.
            Ip: http.Connection.RemoteIpAddress?.ToString(),
            UserAgent: http.Request.Headers.UserAgent.ToString() is { Length: > 0 } ua ? ua : null);
    }

    /// <summary>
    /// Actor for an unauthenticated request (a failed login), carrying the
    /// username as SUPPLIED so an attempt against a non-existent account is
    /// still visible in the trail.
    /// </summary>
    public static AuditActor ForAnonymous(HttpContext http, string? attemptedUsername) =>
        For(http) with { UserId = null, Username = attemptedUsername };
}
