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

    public static void MapUpdateEndpoints(this WebApplication app)
    {
        // Anonymous by design: the caller is an unattended lab PC, not a user.
        // No session cookie is ever present, so CSRF does not engage; the Site
        // rate-limit partition keeps one misbehaving client from monopolizing.
        app.MapGet("/api/updates/synapse/{fileName}", Get)
           .AllowAnonymous()
           .RequireRateLimiting(Auth.RateLimitPolicies.Site)
           .WithName("SynapseUpdateFeed");
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
