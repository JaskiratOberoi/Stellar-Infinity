namespace Infinity.Api.Caching;

public sealed record RateLimitVerdict(bool Allowed, long? Count, int Limit, bool Distributed)
{
    public static RateLimitVerdict Allow(long? count, int limit, bool distributed) =>
        new(true, count, limit, distributed);

    public static RateLimitVerdict Deny(long count, int limit) => new(false, count, limit, true);
}

/// <summary>
/// Cluster-wide fixed-window rate limiting, layered ON TOP of the in-process
/// ASP.NET limiter rather than replacing it.
///
/// Two layers because they fail in opposite directions:
///
///   • The in-process limiter always works but only sees one instance, so N
///     instances mean N times the intended limit.
///   • This one is cluster-wide but depends on Redis.
///
/// Together, the effective limit is correct when Redis is up and degrades to
/// per-instance when it is not — never to unlimited. That is why
/// <see cref="InfinityCache.IncrementAsync"/> returns null rather than zero on
/// failure: treating a Redis outage as "count = 0" would quietly disable the
/// limit, which is the failure mode this whole class exists to avoid.
/// </summary>
public sealed partial class DistributedRateLimiter(InfinityCache cache, ILogger<DistributedRateLimiter> logger)
{
    /// <summary>
    /// Count this attempt against <paramref name="bucket"/>.
    ///
    /// Returns allowed = true when Redis is unavailable: the in-process limiter
    /// is still in force underneath, and failing closed here would mean a
    /// caching outage stopped clinicians signing in.
    /// </summary>
    public async Task<RateLimitVerdict> CheckAsync(
        string bucket, int limit, TimeSpan window, CancellationToken ct = default)
    {
        var count = await cache.IncrementAsync($"rl:{bucket}", window, ct).ConfigureAwait(false);

        if (count is null)
        {
            // Not distributed right now. Say so once per occurrence so the
            // degradation is visible rather than silent.
            LogDegraded(logger, bucket);
            return RateLimitVerdict.Allow(null, limit, distributed: false);
        }

        if (count > limit)
        {
            LogBlocked(logger, bucket, count.Value, limit);
            return RateLimitVerdict.Deny(count.Value, limit);
        }

        return RateLimitVerdict.Allow(count, limit, distributed: true);
    }

    [LoggerMessage(EventId = 1310, Level = LogLevel.Warning,
        Message = "ratelimit.degraded bucket={Bucket} — Redis unavailable, falling back to the per-instance limiter")]
    private static partial void LogDegraded(ILogger logger, string bucket);

    [LoggerMessage(EventId = 1311, Level = LogLevel.Warning,
        Message = "ratelimit.blocked bucket={Bucket} count={Count} limit={Limit}")]
    private static partial void LogBlocked(ILogger logger, string bucket, long count, int limit);
}
