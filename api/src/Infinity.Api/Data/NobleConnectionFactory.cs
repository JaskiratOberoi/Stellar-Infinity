using System.Diagnostics;
using Microsoft.Data.SqlClient;
using Microsoft.Extensions.Options;

namespace Infinity.Api.Data;

/// <summary>
/// The ONLY place Infinity opens a connection to Noble. Everything that touches
/// the LIS database goes through here — mirroring Telo's rule that db/pool.ts is
/// the single SQL entrypoint, which is what makes pool limits and tracing
/// enforceable rather than aspirational.
///
/// There is no hand-rolled pool object: Microsoft.Data.SqlClient pools
/// internally, keyed on the connection string. That is why the string is built
/// exactly once here and cached — rebuilding it per request would silently
/// create additional pools and multiply the connection count against a database
/// that is shared with the live LIS.
/// </summary>
public sealed partial class NobleConnectionFactory
{
    private readonly string _connectionString;
    private readonly NobleOptions _options;
    private readonly ILogger<NobleConnectionFactory> _logger;

    public NobleConnectionFactory(IOptions<NobleOptions> options, ILogger<NobleConnectionFactory> logger)
    {
        _options = options.Value;
        _logger = logger;

        var problems = _options.Validate();
        if (problems.Count > 0)
        {
            throw new InvalidOperationException(
                "Noble connection is misconfigured: " + string.Join(" ", problems));
        }

        _connectionString = _options.BuildConnectionString();
    }

    /// <summary>Max connections this process will ever hold against Noble.</summary>
    public int MaxPoolSize => _options.MaxPoolSize;

    public async Task<SqlConnection> OpenAsync(CancellationToken ct = default)
    {
        var conn = new SqlConnection(_connectionString);
        try
        {
            await conn.OpenAsync(ct).ConfigureAwait(false);
            return conn;
        }
        catch
        {
            await conn.DisposeAsync().ConfigureAwait(false);
            throw;
        }
    }

    /// <summary>A read command carrying the default read timeout.</summary>
    public static SqlCommand CreateCommand(SqlConnection conn, string sql) =>
        new(sql, conn) { CommandType = System.Data.CommandType.Text };

    /// <summary>
    /// A command for a write stored procedure, carrying the longer write
    /// timeout. Use this for every usp_inf_* execution — order creation and
    /// accessioning legitimately exceed the read budget under load.
    /// </summary>
    public SqlCommand CreateWriteCommand(SqlConnection conn, string storedProcedure) =>
        new(storedProcedure, conn)
        {
            CommandType = System.Data.CommandType.StoredProcedure,
            CommandTimeout = _options.WriteCommandTimeoutSeconds,
        };

    /// <summary>
    /// Run a read against Noble with timing. Logs db.slow above the threshold so
    /// a query that degrades on production data volumes announces itself instead
    /// of quietly eating a connection.
    /// </summary>
    public async Task<T> QueryAsync<T>(
        string operation,
        Func<SqlConnection, CancellationToken, Task<T>> read,
        CancellationToken ct = default,
        int slowMs = 500)
    {
        var started = Stopwatch.GetTimestamp();
        try
        {
            await using var conn = await OpenAsync(ct).ConfigureAwait(false);
            var result = await read(conn, ct).ConfigureAwait(false);

            var elapsed = Stopwatch.GetElapsedTime(started).TotalMilliseconds;
            if (elapsed >= slowMs) LogSlow(_logger, operation, elapsed, slowMs);
            else LogQuery(_logger, operation, elapsed);

            return result;
        }
        catch (Exception ex)
        {
            LogError(_logger, operation, Stopwatch.GetElapsedTime(started).TotalMilliseconds, ex);
            throw;
        }
    }

    [LoggerMessage(EventId = 1010, Level = LogLevel.Warning, Message = "db.slow op={Operation} ms={ElapsedMs} thresholdMs={ThresholdMs}")]
    private static partial void LogSlow(ILogger logger, string operation, double elapsedMs, int thresholdMs);

    [LoggerMessage(EventId = 1011, Level = LogLevel.Debug, Message = "db.query op={Operation} ms={ElapsedMs}")]
    private static partial void LogQuery(ILogger logger, string operation, double elapsedMs);

    [LoggerMessage(EventId = 1012, Level = LogLevel.Error, Message = "db.error op={Operation} ms={ElapsedMs}")]
    private static partial void LogError(ILogger logger, string operation, double elapsedMs, Exception ex);
}
