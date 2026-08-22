using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Options;
using StackExchange.Redis;

namespace Infinity.Api.Caching;

/// <summary>
/// Shared cache and atomic counter, backed by Redis when configured and by the
/// in-process cache when not.
///
/// Every Redis operation degrades to the in-process path on failure rather than
/// throwing. That choice is deliberate and asymmetric with how the CALLERS
/// treat a miss:
///
///   • A cache miss is always safe — the caller re-reads from Noble.
///   • A rate-limit miss is NOT safe, so the in-process limiter stays active as
///     a second layer underneath. Losing Redis degrades the limit from
///     cluster-wide to per-instance; it never removes it. See
///     <see cref="RateLimitPolicies"/>.
///
/// Fail-closed on a Redis outage was the other option, and is what Telo does
/// for login. Rejected here: a lab that cannot sign in cannot release results,
/// and a caching fault should not become a clinical outage. Degrading the limit
/// is the lesser harm, and it is logged loudly.
/// </summary>
public sealed partial class InfinityCache : IAsyncDisposable
{
    private readonly CacheOptions _options;
    private readonly IMemoryCache _local;
    private readonly ILogger<InfinityCache> _logger;
    private readonly ConnectionMultiplexer? _redis;
    private readonly IDatabase? _db;

    public bool IsDistributed => _db is not null;

    public InfinityCache(IOptions<CacheOptions> options, IMemoryCache local, ILogger<InfinityCache> logger)
    {
        _options = options.Value;
        _local = local;
        _logger = logger;

        if (string.IsNullOrWhiteSpace(_options.ConnectionString))
        {
            LogLocalOnly(_logger);
            return;
        }

        try
        {
            var config = ConfigurationOptions.Parse(_options.ConnectionString);
            config.AbortOnConnectFail = false;   // keep retrying in the background
            config.ConnectTimeout = _options.ConnectTimeoutMs;
            config.SyncTimeout = _options.OperationTimeoutMs;
            config.AsyncTimeout = _options.OperationTimeoutMs;
            config.ClientName = "InfinityApi";

            _redis = ConnectionMultiplexer.Connect(config);
            _db = _redis.GetDatabase();
            LogConnected(_logger, _options.ConnectionString);
        }
        catch (Exception ex)
        {
            // Startup must not fail on an unreachable Redis unless the operator
            // has declared the deployment multi-instance (validated separately).
            LogConnectFailed(_logger, ex);
        }
    }

    private string Key(string key) => _options.KeyPrefix + key;

    /// <summary>Read a cached string, or null. Never throws.</summary>
    public async Task<string?> GetAsync(string key, CancellationToken ct = default)
    {
        if (_db is not null)
        {
            try
            {
                var value = await _db.StringGetAsync(Key(key)).WaitAsync(ct).ConfigureAwait(false);
                if (value.HasValue) return value.ToString();
                return null;
            }
            catch (Exception ex)
            {
                LogDegraded(_logger, "get", ex.Message);
            }
        }

        return _local.TryGetValue(Key(key), out string? local) ? local : null;
    }

    /// <summary>Read cached bytes, or null. Never throws.</summary>
    public async Task<byte[]?> GetBytesAsync(string key, CancellationToken ct = default)
    {
        if (_db is not null)
        {
            try
            {
                var value = await _db.StringGetAsync(Key(key)).WaitAsync(ct).ConfigureAwait(false);
                if (value.HasValue) return (byte[]?)value;
                return null;
            }
            catch (Exception ex)
            {
                LogDegraded(_logger, "getbytes", ex.Message);
            }
        }

        return _local.TryGetValue(Key(key), out byte[]? local) ? local : null;
    }

    /// <summary>
    /// Write cached bytes. Never throws. Redis stores binary natively, so a
    /// PDF goes in as-is — base64 would add a third to every value for
    /// nothing. The in-process fallback carries the value's size so a burst of
    /// large documents evicts instead of accumulating.
    /// </summary>
    public async Task SetBytesAsync(string key, byte[] value, TimeSpan ttl, CancellationToken ct = default)
    {
        if (_db is not null)
        {
            try
            {
                await _db.StringSetAsync(Key(key), value, ttl).WaitAsync(ct).ConfigureAwait(false);
                return;
            }
            catch (Exception ex)
            {
                LogDegraded(_logger, "setbytes", ex.Message);
            }
        }

        _local.Set(Key(key), value, new MemoryCacheEntryOptions
        {
            AbsoluteExpirationRelativeToNow = ttl,
            Size = value.Length,
        });
    }

    /// <summary>Write a cached string. Never throws.</summary>
    public async Task SetAsync(string key, string value, TimeSpan ttl, CancellationToken ct = default)
    {
        if (_db is not null)
        {
            try
            {
                await _db.StringSetAsync(Key(key), value, ttl).WaitAsync(ct).ConfigureAwait(false);
                return;
            }
            catch (Exception ex)
            {
                LogDegraded(_logger, "set", ex.Message);
            }
        }

        _local.Set(Key(key), value, ttl);
    }

    /// <summary>
    /// Remove a key. Best-effort in BOTH stores — after a Redis failure a stale
    /// value may have been written locally, and an invalidation that only
    /// reached one of them is worse than useless.
    /// </summary>
    public async Task RemoveAsync(string key, CancellationToken ct = default)
    {
        _local.Remove(Key(key));

        if (_db is null) return;

        try
        {
            await _db.KeyDeleteAsync(Key(key)).WaitAsync(ct).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            LogDegraded(_logger, "remove", ex.Message);
        }
    }

    /// <summary>
    /// Atomically increment a fixed-window counter and return the new count,
    /// setting the expiry on first use.
    ///
    /// Returns null when the counter could not be read — the caller must then
    /// rely on the in-process limiter rather than treating it as zero, which
    /// would silently disable the limit.
    /// </summary>
    public async Task<long?> IncrementAsync(string key, TimeSpan window, CancellationToken ct = default)
    {
        if (_db is null) return null;

        try
        {
            var full = Key(key);
            var count = await _db.StringIncrementAsync(full).WaitAsync(ct).ConfigureAwait(false);

            // Only the first increment sets the TTL, so the window is fixed
            // from its first hit rather than sliding on every request.
            if (count == 1)
            {
                await _db.KeyExpireAsync(full, window).WaitAsync(ct).ConfigureAwait(false);
            }

            return count;
        }
        catch (Exception ex)
        {
            LogDegraded(_logger, "increment", ex.Message);
            return null;
        }
    }

    public async ValueTask DisposeAsync()
    {
        if (_redis is not null) await _redis.DisposeAsync().ConfigureAwait(false);
    }

    [LoggerMessage(EventId = 1300, Level = LogLevel.Information,
        Message = "cache.local-only — no Redis configured. Correct for a single instance; set Cache__ConnectionString before running a second.")]
    private static partial void LogLocalOnly(ILogger logger);

    [LoggerMessage(EventId = 1301, Level = LogLevel.Information, Message = "cache.redis.connected endpoint={Endpoint}")]
    private static partial void LogConnected(ILogger logger, string endpoint);

    [LoggerMessage(EventId = 1302, Level = LogLevel.Error,
        Message = "cache.redis.connect-failed — running on the in-process cache; rate limits are per-instance until Redis returns")]
    private static partial void LogConnectFailed(ILogger logger, Exception ex);

    [LoggerMessage(EventId = 1303, Level = LogLevel.Warning,
        Message = "cache.redis.degraded op={Operation} error={Error} — falling back to the in-process cache")]
    private static partial void LogDegraded(ILogger logger, string operation, string error);
}
