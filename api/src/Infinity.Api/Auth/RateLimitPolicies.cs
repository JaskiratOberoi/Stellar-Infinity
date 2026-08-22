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
    /// Remote lab sites' Synapse agents (ping + status reports). A well-behaved
    /// agent reports every few seconds at most, so 120/min is head-room, not a
    /// budget; the cap exists to stop a misconfigured agent in a retry loop
    /// from saturating the API.
    /// </summary>
    public const string Site = "site";

    /// <summary>
    /// Guards the auto-authorization unlock password. See
    /// <see cref="AddInfinityRateLimiting"/> for the limit and why it is
    /// partitioned by user rather than by IP.
    /// </summary>
    public const string AutoAuth = "autoauth";

    /// <summary>
    /// The CCAvenue endpoints. The callback is the only unauthenticated write
    /// in the system — anyone who learns the URL can post to it — so it needs a
    /// limit that does not depend on there being a session to partition by.
    /// </summary>
    public const string Payment = "payment";

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

                /* A COARSE per-instance backstop, deliberately looser than the
                   real limit of 8 enforced by DistributedRateLimiter in the
                   login handler.

                   They were both 8, which meant this one always fired first and
                   shadowed the distributed check — so a blocked attempt never
                   reached the code that writes the login_blocked audit row, and
                   brute-force attempts went unrecorded. This layer now only
                   engages when the distributed limiter is unavailable (Redis
                   down) or when a single client is far outside normal use. */
                return RateLimitPartition.GetFixedWindowLimiter(key, _ => new FixedWindowRateLimiterOptions
                {
                    PermitLimit = 40,
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

            options.AddPolicy(Site, http =>
            {
                // Partitioned per site, so one faulty lab's agent cannot starve
                // the others. Falls back to IP when the header is absent — an
                // unidentified caller is not a site we want to be generous
                // with anyway. Same construction as the Instrument policy.
                var code = http.Request.Headers["X-Site-Code"].ToString();
                var key = string.IsNullOrWhiteSpace(code)
                    ? http.Connection.RemoteIpAddress?.ToString() ?? "unknown"
                    : code.ToUpperInvariant();

                return RateLimitPartition.GetFixedWindowLimiter(key, _ => new FixedWindowRateLimiterOptions
                {
                    PermitLimit = 120,
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

            // Payments. Partitioned by user when there is one and by IP when
            // there is not, because the two endpoints under this policy differ:
            // /checkout is authenticated, /callback cannot be — the customer
            // returns from CCAvenue on a cross-site POST that carries no
            // cookie.
            //
            // 30 a minute is far above any real use (a person pays once) and
            // far below what it takes to grind at the callback. The callback is
            // not a guessing oracle in the first place — a body that does not
            // decrypt under the working key never reaches the database — so
            // this is about load, not secrecy.
            options.AddPolicy(Payment, http =>
            {
                var key = http.User.UserId()?.ToString()
                          ?? http.Connection.RemoteIpAddress?.ToString()
                          ?? "unknown";

                return RateLimitPartition.GetFixedWindowLimiter(key, _ => new FixedWindowRateLimiterOptions
                {
                    PermitLimit = 30,
                    Window = TimeSpan.FromMinutes(1),
                    QueueLimit = 0,
                    QueueProcessingOrder = QueueProcessingOrder.OldestFirst,
                });
            });
        });
    }
}
