using System.Net;
using Microsoft.Data.SqlClient;

namespace Infinity.Api.Data;

/// <summary>
/// Connection settings for Noble (the shared LIS MS SQL Server).
/// Bound from configuration section "Noble"; in production these arrive as
/// environment variables (Noble__Server, Noble__Password, ...).
/// </summary>
public sealed class NobleOptions
{
    public const string SectionName = "Noble";

    /// <summary>Host, "host,port" or "host:port" (SQL Server convention).</summary>
    public string Server { get; set; } = "";
    public string Database { get; set; } = "Noble";
    public string User { get; set; } = "";
    public string Password { get; set; } = "";

    public bool Encrypt { get; set; } = true;
    public bool TrustServerCertificate { get; set; }

    /// <summary>Shows up in sys.dm_exec_sessions — how you spot Infinity's load on a shared server.</summary>
    public string ApplicationName { get; set; } = "InfinityApi";

    public int ConnectTimeoutSeconds { get; set; } = 15;

    /// <summary>Default per-command timeout for reads.</summary>
    public int CommandTimeoutSeconds { get; set; } = 45;

    /// <summary>
    /// Longer budget for write procedures. Telo declared an equivalent setting
    /// and then never wired it up, so its long writes silently ran under the
    /// 45s read timeout — this one is actually applied, by
    /// <see cref="NobleConnectionFactory.CreateWriteCommand"/>.
    /// </summary>
    public int WriteCommandTimeoutSeconds { get; set; } = 120;

    /// <summary>
    /// Hard cap on concurrent connections. Noble is shared with the live LIS:
    /// hundreds of concurrent API users must NOT become hundreds of concurrent
    /// SQL connections. Keep this small and absorb load in cache instead.
    /// </summary>
    public int MaxPoolSize { get; set; } = 20;

    public int MinPoolSize { get; set; }

    /// <summary>
    /// Optional. When the server is reached by bare IP but presents a
    /// certificate for a hostname, TLS validation fails on the name mismatch.
    /// Set this to the name on the certificate rather than reaching for
    /// TrustServerCertificate. (Telo's Node driver needed the equivalent
    /// `serverName` SNI override for the same reason.)
    /// </summary>
    public string? HostNameInCertificate { get; set; }

    public IReadOnlyList<string> Validate()
    {
        var problems = new List<string>();
        if (string.IsNullOrWhiteSpace(Server)) problems.Add("Noble:Server is required.");
        if (string.IsNullOrWhiteSpace(Database)) problems.Add("Noble:Database is required.");
        if (string.IsNullOrWhiteSpace(User)) problems.Add("Noble:User is required.");
        if (string.IsNullOrWhiteSpace(Password)) problems.Add("Noble:Password is required.");
        if (MaxPoolSize < 1) problems.Add("Noble:MaxPoolSize must be at least 1.");
        if (MinPoolSize < 0 || MinPoolSize > MaxPoolSize)
            problems.Add("Noble:MinPoolSize must be between 0 and MaxPoolSize.");
        return problems;
    }

    /// <summary>
    /// Build the connection string. Microsoft.Data.SqlClient pools internally,
    /// keyed on this exact string — so it must be built once and reused, never
    /// recomposed per request (a differing string silently creates a second
    /// pool and doubles your connection count against Noble).
    /// </summary>
    public string BuildConnectionString()
    {
        var (host, port) = SplitServer(Server);

        var b = new SqlConnectionStringBuilder
        {
            DataSource = port is null ? host : $"{host},{port}",
            InitialCatalog = Database,
            UserID = User,
            Password = Password,
            Encrypt = Encrypt,
            TrustServerCertificate = TrustServerCertificate,
            ApplicationName = ApplicationName,
            ConnectTimeout = ConnectTimeoutSeconds,
            CommandTimeout = CommandTimeoutSeconds,
            Pooling = true,
            MaxPoolSize = MaxPoolSize,
            MinPoolSize = MinPoolSize,
            // MARS costs throughput and we never interleave readers on one
            // connection; keep it off.
            MultipleActiveResultSets = false,
            // Fail a dead connection fast instead of handing it to a caller.
            ConnectRetryCount = 1,
            ConnectRetryInterval = 2,
        };

        if (!string.IsNullOrWhiteSpace(HostNameInCertificate))
        {
            b.HostNameInCertificate = HostNameInCertificate;
        }

        return b.ConnectionString;
    }

    /// <summary>Parse "host", "host,1433" or "host:1433" into its parts.</summary>
    internal static (string Host, int? Port) SplitServer(string raw)
    {
        var s = (raw ?? "").Trim();
        if (s.Length == 0) return ("", null);

        // Comma is SQL Server's own separator and unambiguous.
        var comma = s.LastIndexOf(',');
        if (comma > 0 && int.TryParse(s.AsSpan(comma + 1), out var cp))
            return (s[..comma].Trim(), cp);

        // A single colon is a port only when the left side is not an IPv6 literal.
        var colon = s.LastIndexOf(':');
        if (colon > 0 && s.IndexOf(':') == colon && int.TryParse(s.AsSpan(colon + 1), out var kp))
        {
            var left = s[..colon].Trim();
            if (!IPAddress.TryParse(left, out var ip) || ip.AddressFamily != System.Net.Sockets.AddressFamily.InterNetworkV6)
                return (left, kp);
        }

        return (s, null);
    }
}
