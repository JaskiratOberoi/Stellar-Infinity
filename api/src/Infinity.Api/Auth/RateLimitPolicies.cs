using System.Threading.RateLimiting;
using Microsoft.AspNetCore.RateLimiting;

namespace Infinity.Api.Auth;

public static class RateLimitPolicies
{
    public const string Login = "login";

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
        });
    }
}
