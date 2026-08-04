namespace Infinity.Api.Caching;

public sealed class CacheOptions
{
    public const string SectionName = "Cache";

    /// <summary>
    /// StackExchange.Redis connection string, e.g. <c>redis:6379</c>.
    ///
    /// Empty is a legitimate configuration: the app then runs entirely on the
    /// in-process cache, which is correct for a single instance and is what the
    /// deployment has been until now. It is NOT correct for two instances, and
    /// <see cref="RequireDistributed"/> exists to make that a startup failure
    /// rather than a subtle one.
    /// </summary>
    public string ConnectionString { get; set; } = "";

    /// <summary>
    /// Set true on any multi-instance deployment. Startup then fails if Redis
    /// is not configured, instead of silently running with per-instance state
    /// where rate limits multiply by the instance count and token revocation
    /// only reaches whichever instance happens to serve the next request.
    /// </summary>
    public bool RequireDistributed { get; set; }

    /// <summary>Prefix on every key, so Infinity can share a Redis with Telo.</summary>
    public string KeyPrefix { get; set; } = "inf:";

    public int ConnectTimeoutMs { get; set; } = 3000;
    public int OperationTimeoutMs { get; set; } = 1000;

    public IReadOnlyList<string> Validate()
    {
        var problems = new List<string>();

        if (RequireDistributed && string.IsNullOrWhiteSpace(ConnectionString))
        {
            problems.Add("Cache:RequireDistributed is set but Cache:ConnectionString is empty. " +
                         "A multi-instance deployment cannot run on the in-process cache.");
        }

        if (ConnectTimeoutMs is < 100 or > 30_000) problems.Add("Cache:ConnectTimeoutMs must be 100-30000.");
        if (OperationTimeoutMs is < 50 or > 10_000) problems.Add("Cache:OperationTimeoutMs must be 50-10000.");

        return problems;
    }
}
