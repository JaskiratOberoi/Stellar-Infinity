using System.Threading.RateLimiting;
using Microsoft.AspNetCore.RateLimiting;

namespace Infinity.Api.Auth;

public static class RateLimitPolicies
{
    public const string Login = "login";

    /// <summary>
    /// Instrument ingestion. Separate from the login limiter and far more
    /// generous: a busy analyser legitimately posts continuously, and throttling
    /// it would drop clinical results. The cap exists only to stop a
    /// malfunctioning or misconfigured driver from saturating the API.
    /// </summary>
    public const string Instrument = "instrument";

    /// <summary>
    /// Guards the auto-authorization unlock password. See
    /// <see cref="AddInfinityRateLimiting"/> for the limit and why it is
    /// partitioned by user rather than by IP.
    /// </summary>
    public const string AutoAuth = "autoauth";

    /// <summary>
    /// Brute-force protection on /api/auth/login: 8 attempts per 15 minutes,
    /// partitioned by username + client IP (matching Telo's limits).
    ///
    /// Partitioning by username as well as IP matters in this deployment: whole
    /// collection centres sit behind one NAT address, so an IP-only limit would
    /// let one person's fat-fingered password lock out their entire branch.
    ///
    /// NOTE: this is an in-memory limiter, so it is per-process. It is correct
    /// for the current single-instance deployment; the moment a second instance
    /// exists the effective limit doubles, and this must move to Redis to stay
    /// meaningful.
    /// </summary>
    public static void AddInfinityRateLimiting(this IServiceCollection services)
    {
        services.AddRateLimiter(options =>
        {
            options.RejectionStatusCode = StatusCodes.Status429TooManyRequests;

            options.AddPolicy(Login, http =>
            {
                var ip = http.Connection.RemoteIpAddress?.ToString() ?? "unknown";

                // The body is not readable here without buffering, so the
                // username is taken from a header the SPA sets. Absent it, the
                // limit degrades to per-IP, which is the safe direction.
                var username = http.Request.Headers["X-Login-User"].ToString();
                var key = string.IsNullOrWhiteSpace(username) ? ip : $"{username.ToLowerInvariant()}|{ip}";

                return RateLimitPartition.GetFixedWindowLimiter(key, _ => new FixedWindowRateLimiterOptions
                {
                    PermitLimit = 8,
                    Window = TimeSpan.FromMinutes(15),
                    QueueLimit = 0,
                    QueueProcessingOrder = QueueProcessingOrder.OldestFirst,
                });
            });

            options.AddPolicy(Instrument, http =>
            {
                // Partitioned per analyser, so one faulty bench cannot starve
                // the others. Falls back to IP when the header is absent — an
                // unidentified caller is not an analyser we want to be generous
                // with anyway.
                var code = http.Request.Headers["X-Instrument-Code"].ToString();
                var key = string.IsNullOrWhiteSpace(code)
                    ? http.Connection.RemoteIpAddress?.ToString() ?? "unknown"
                    : code.ToUpperInvariant();

                return RateLimitPartition.GetFixedWindowLimiter(key, _ => new FixedWindowRateLimiterOptions
                {
                    PermitLimit = 600,
                    Window = TimeSpan.FromMinutes(1),
                    QueueLimit = 0,
                    QueueProcessingOrder = QueueProcessingOrder.OldestFirst,
                });
            });

            // The auto-authorization unlock password is a SHARED secret that an
            // authenticated admin can submit repeatedly, so the endpoint that
            // checks it must not be a free guessing oracle.
            //
            // Partitioned by user id, not IP: every admin in a lab shares one
            // NAT address, and one person mistyping the password must not stop
            // their colleagues from working. The token is already validated by
            // the time this runs, so the subject claim is trustworthy here in a
            // way the login limiter's header is not.
            //
            // Tighter than login (5 per 15 min) because a legitimate admin
            // types this once per session, not once per attempt at recalling
            // which of their passwords it is.
            options.AddPolicy(AutoAuth, http =>
            {
                var key = http.User.UserId()?.ToString()
                          ?? http.Connection.RemoteIpAddress?.ToString()
                          ?? "unknown";

                return RateLimitPartition.GetFixedWindowLimiter(key, _ => new FixedWindowRateLimiterOptions
                {
                    PermitLimit = 5,
                    Window = TimeSpan.FromMinutes(15),
                    QueueLimit = 0,
                    QueueProcessingOrder = QueueProcessingOrder.OldestFirst,
                });
            });
        });
    }
}
