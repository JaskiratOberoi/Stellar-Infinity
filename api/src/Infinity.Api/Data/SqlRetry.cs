using Microsoft.Data.SqlClient;

namespace Infinity.Api.Data;

/// <summary>
/// Retry for genuinely transient SQL failures, and nothing else.
///
/// The classification below is deliberately narrow, and the reason matters:
/// Telo's original implementation retried anything whose message contained the
/// word "failed", which meant application errors raised by stored procedures
/// got replayed — on a non-idempotent write that is a duplicate order. Only add
/// a code here if a retry is provably safe.
///
/// IMPORTANT: <see cref="ExecuteAsync"/> is safe for reads and for writes that
/// are idempotent or that fail atomically before committing. Do not wrap a
/// multi-step write that can partially commit.
/// </summary>
public sealed partial class SqlRetry(ILogger<SqlRetry> logger)
{
    /// <summary>
    /// Transient SQL Server error numbers. Sources: connection/transport
    /// failures, lock contention, and Azure SQL throttling codes (harmless to
    /// keep even on-prem).
    /// </summary>
    private static readonly HashSet<int> TransientNumbers =
    [
        -2,     // command/connect timeout (SqlException surfaces .NET timeouts as -2)
        20,     // instance does not support encryption (seen during failover)
        53,     // network path not found / server not found — TCP provider error 40
        64,     // connection terminated during login
        121,    // semaphore timeout period has expired
        233,    // no process on the other end of the pipe
        258,    // wait operation timed out
        997,    // overlapped I/O operation is in progress
        1205,   // deadlock victim
        1222,   // lock request timeout
        4060,   // cannot open database (often a transient failover)
        10053,  // transport-level error: connection aborted
        10054,  // transport-level error: connection reset by peer
        10060,  // network/instance error, connection timed out
        10928,  // resource limit reached
        10929,  // server too busy
        11001,  // no such host is known (DNS blip)
        40197,  // service error processing the request
        40501,  // service busy
        40613,  // database unavailable
        49918,  // cannot process request, not enough resources
        49919,  // cannot process create/update request
        49920,  // cannot process request, too many operations
    ];

    public const int DefaultAttempts = 3;

    public Task<T> ExecuteAsync<T>(
        string operation,
        Func<CancellationToken, Task<T>> action,
        CancellationToken ct = default,
        int attempts = DefaultAttempts) => RunAsync(operation, action, attempts, ct);

    public async Task ExecuteAsync(
        string operation,
        Func<CancellationToken, Task> action,
        CancellationToken ct = default,
        int attempts = DefaultAttempts)
    {
        await RunAsync<object?>(operation, async token =>
        {
            await action(token).ConfigureAwait(false);
            return null;
        }, attempts, ct).ConfigureAwait(false);
    }

    private async Task<T> RunAsync<T>(
        string operation,
        Func<CancellationToken, Task<T>> action,
        int attempts,
        CancellationToken ct)
    {
        for (var attempt = 1; ; attempt++)
        {
            try
            {
                return await action(ct).ConfigureAwait(false);
            }
            catch (Exception ex) when (attempt < attempts && IsTransient(ex) && !ct.IsCancellationRequested)
            {
                // Linear backoff: contention here is usually a lock or a blip,
                // not a thundering herd, so exponential just adds latency.
                var delay = TimeSpan.FromMilliseconds(200 * attempt);
                LogRetry(logger, operation, attempt, attempts, delay.TotalMilliseconds, Describe(ex));
                await Task.Delay(delay, ct).ConfigureAwait(false);
            }
            catch (Exception ex) when (attempt >= attempts && IsTransient(ex))
            {
                LogExhausted(logger, operation, attempts, Describe(ex));
                throw;
            }
        }
    }

    /// <summary>
    /// Classify a failure as safe-to-retry. Checks every error in the
    /// <see cref="SqlException.Errors"/> collection, not just the top-level
    /// Number, because the interesting code is often not first.
    /// </summary>
    public static bool IsTransient(Exception ex)
    {
        switch (ex)
        {
            case SqlException sqlEx:
                foreach (SqlError err in sqlEx.Errors)
                {
                    if (TransientNumbers.Contains(err.Number)) return true;

                    // Severity class >= 20 is a fatal transport-level error: the
                    // connection is gone. This check is NOT redundant with the
                    // number list — on Linux, TCP provider failures ("error: 40 -
                    // Could not open a connection") arrive with Number = 0 and
                    // carry only Class = 20, so number matching alone silently
                    // never retries a network blip. Verified empirically against
                    // Microsoft.Data.SqlClient 6.0.1.
                    if (err.Class >= 20) return true;
                }
                return MessageLooksTransient(sqlEx.Message);

            case TimeoutException:
                return true;

            // Socket/DNS failures while opening a connection surface wrapped.
            case System.Net.Sockets.SocketException:
            case System.ComponentModel.Win32Exception:
                return true;

            case InvalidOperationException ioe:
                // "Timeout expired. The timeout period elapsed prior to obtaining
                // a connection from the pool" — pool exhaustion under a spike.
                // Worth one retry; if it persists, MaxPoolSize is the real fix.
                return ioe.Message.Contains("from the pool", StringComparison.OrdinalIgnoreCase);

            default:
                return ex.InnerException is not null && IsTransient(ex.InnerException);
        }
    }

    private static bool MessageLooksTransient(string? message)
    {
        if (string.IsNullOrEmpty(message)) return false;

        // Noble's trigger_PreventDuplicate rolls back with this message when two
        // sessions race for the same SID. Retrying is correct: the order
        // procedure reserves a fresh SID block on the next attempt.
        if (message.Contains("DUPLICATES PREVENTED", StringComparison.OrdinalIgnoreCase)) return true;

        return message.Contains("deadlock", StringComparison.OrdinalIgnoreCase);
    }

    private static string Describe(Exception ex) =>
        ex is SqlException s ? $"SqlException {s.Number}: {s.Message}" : $"{ex.GetType().Name}: {ex.Message}";

    [LoggerMessage(EventId = 1001, Level = LogLevel.Information,
        Message = "db.retry.transient op={Operation} attempt={Attempt}/{Attempts} backoffMs={BackoffMs} cause={Cause}")]
    private static partial void LogRetry(ILogger logger, string operation, int attempt, int attempts, double backoffMs, string cause);

    [LoggerMessage(EventId = 1002, Level = LogLevel.Warning,
        Message = "db.retry.exhausted op={Operation} attempts={Attempts} cause={Cause}")]
    private static partial void LogExhausted(ILogger logger, string operation, int attempts, string cause);
}
