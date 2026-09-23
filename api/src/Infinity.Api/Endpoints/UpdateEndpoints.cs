using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace Infinity.Api.Endpoints;

/// <summary>
/// The over-the-air update feed for the Stellar Synapse lab middleware.
///
/// electron-updater's generic provider needs exactly three static files behind
/// one base URL: latest.yml, the NSIS installer, and its blockmap. They are
/// served from a directory mounted into the container (compose maps ./updates
/// to /updates) and gated by a shared fleet key baked into every Synapse build,
/// sent as X-Update-Key. The key grants nothing but installer downloads, and is
/// rotated by changing Updates__SynapseKey here and SYNAPSE_UPDATE_KEY in the
/// Synapse build env together.
///
/// Range requests must work: differential updates download byte ranges of the
/// new installer against the previous blockmap, which is also why a publish
/// keeps the prior version's files in the directory instead of wiping it —
/// without them the updater quietly falls back to a full download.
/// </summary>
public static class UpdateEndpoints
{
    /// <summary>Exactly the artifacts a release consists of; anything else 404s.</summary>
    private static readonly Regex AllowedFile = new(
        @"^(latest\.yml|Stellar-Synapse-Setup-[0-9A-Za-z.\-]+\.(exe|blockmap))$",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);

    /// <summary>The installer named by electron-builder's manifest: its top-level "path:" line.</summary>
    private static readonly Regex ManifestPath = new(
        @"^path:\s*(\S+)\s*$",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);

    public static void MapUpdateEndpoints(this WebApplication app)
    {
        // Anonymous by design: the caller is an unattended lab PC, not a user.
        // No session cookie is ever present, so CSRF does not engage; the Site
        // rate-limit partition keeps one misbehaving client from monopolizing.
        app.MapGet("/api/updates/synapse/{fileName}", Get)
           .AllowAnonymous()
           .RequireRateLimiting(Auth.RateLimitPolicies.Site)
           .WithName("SynapseUpdateFeed");

        // Stable link for first installs: always the installer latest.yml
        // currently points at, resolved per request so the URL survives every
        // release. Guarded by HTTP Basic auth against Updates:DownloadPassword
        // (api/.env) — the browser prompts once, the credential travels only
        // over TLS. Only the exe is reachable here; the manifest and blockmaps
        // stay on the keyed feed above, so the updater's own path is unchanged.
        app.MapGet("/api/downloads/synapse/latest", GetLatestInstaller)
           .AllowAnonymous()
           .RequireRateLimiting(Auth.RateLimitPolicies.Site)
           .WithName("SynapseLatestInstaller");
    }

    private static IResult GetLatestInstaller(HttpContext http, IConfiguration config)
    {
        var password = config["Updates:DownloadPassword"];
        if (string.IsNullOrEmpty(password))
        {
            // Not configured on this deployment: indistinguishable from absent.
            return Results.NotFound();
        }

        if (!BasicAuthMatches(http.Request.Headers.Authorization.ToString(), password))
        {
            http.Response.Headers.WWWAuthenticate = "Basic realm=\"Stellar Synapse installer\", charset=\"UTF-8\"";
            return Results.Problem(
                title: "Unauthorized",
                detail: "Password required.",
                statusCode: StatusCodes.Status401Unauthorized);
        }

        var directory = Path.GetFullPath(config["Updates:Directory"] ?? "/updates/synapse");
        var manifest = Path.Combine(directory, "latest.yml");
        if (!File.Exists(manifest))
        {
            return Results.NotFound();
        }

        string? fileName = null;
        foreach (var line in File.ReadLines(manifest))
        {
            var m = ManifestPath.Match(line);
            if (m.Success)
            {
                fileName = m.Groups[1].Value;
                break;
            }
        }

        // Serve only an installer the feed itself would serve, and only the exe.
        if (fileName is null
            || !AllowedFile.IsMatch(fileName)
            || !fileName.EndsWith(".exe", StringComparison.Ordinal))
        {
            return Results.NotFound();
        }

        var path = Path.GetFullPath(Path.Combine(directory, fileName));
        if (!path.StartsWith(directory, StringComparison.Ordinal) || !File.Exists(path))
        {
            return Results.NotFound();
        }

        // Constant URL, changing content, and a credentialed response: no cache
        // on the way (Cloudflare included) may store or replay it.
        http.Response.Headers.CacheControl = "no-store";
        return Results.File(
            path,
            "application/octet-stream",
            fileDownloadName: fileName,
            enableRangeProcessing: true);
    }

    /// <summary>
    /// "Basic base64(user:password)" — any user name, the password compared in
    /// constant time. Malformed headers simply fail.
    /// </summary>
    private static bool BasicAuthMatches(string header, string expectedPassword)
    {
        const string scheme = "Basic ";
        if (!header.StartsWith(scheme, StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        string decoded;
        try
        {
            decoded = Encoding.UTF8.GetString(Convert.FromBase64String(header[scheme.Length..].Trim()));
        }
        catch (FormatException)
        {
            return false;
        }

        var colon = decoded.IndexOf(':');
        var presented = colon < 0 ? decoded : decoded[(colon + 1)..];
        return FixedTimeEquals(presented, expectedPassword);
    }

    private static IResult Get(string fileName, HttpContext http, IConfiguration config)
    {
        var expected = config["Updates:SynapseKey"];
        if (string.IsNullOrEmpty(expected))
        {
            // Feed not configured on this deployment: indistinguishable from absent.
            return Results.NotFound();
        }

        var presented = http.Request.Headers["X-Update-Key"].ToString();
        if (!FixedTimeEquals(presented, expected))
        {
            return Results.Problem(
                title: "Unauthorized",
                detail: "Unknown update key.",
                statusCode: StatusCodes.Status401Unauthorized);
        }

        if (!AllowedFile.IsMatch(fileName))
        {
            return Results.NotFound();
        }

        var directory = config["Updates:Directory"] ?? "/updates/synapse";
        var path = Path.GetFullPath(Path.Combine(directory, fileName));
        if (!path.StartsWith(Path.GetFullPath(directory), StringComparison.Ordinal) || !File.Exists(path))
        {
            return Results.NotFound();
        }

        var contentType = fileName.EndsWith(".yml", StringComparison.Ordinal)
            ? "text/yaml"
            : "application/octet-stream";

        return Results.File(path, contentType, enableRangeProcessing: true);
    }

    /// <summary>Constant-time comparison; a length mismatch still returns in fixed time for equal lengths.</summary>
    private static bool FixedTimeEquals(string presented, string expected)
    {
        var a = Encoding.UTF8.GetBytes(presented);
        var b = Encoding.UTF8.GetBytes(expected);
        return a.Length == b.Length && CryptographicOperations.FixedTimeEquals(a, b);
    }
}
