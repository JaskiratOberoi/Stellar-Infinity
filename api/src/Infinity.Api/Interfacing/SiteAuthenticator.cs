using System.Data;
using Infinity.Api.Data;
using Infinity.Api.Worksheet;
using Microsoft.Data.SqlClient;

namespace Infinity.Api.Interfacing;

public sealed record AuthenticatedSite(int Id, string Code, string Name, string? Location);

/// <summary>
/// Authenticates a remote lab site from its <c>X-Site-Code</c> and
/// <c>X-Site-Key</c> headers.
///
/// The same design as <see cref="Instruments.InstrumentAuthenticator"/>, for
/// the same reasons: a site agent is not a person — no role, no MCC scope, no
/// session to revoke — and it must keep reporting when every human is signed
/// out. Its only permission is "may deposit status reports about itself".
///
/// Only the key hash is stored, and verification is the constant-time pbkdf2
/// comparison in <see cref="PasswordHash"/>.
/// </summary>
public sealed partial class SiteAuthenticator(
    NobleConnectionFactory db,
    Caching.InfinityCache cache,
    ILogger<SiteAuthenticator> logger)
{
    /// <summary>
    /// How long a code→hash lookup is cached. Short, because deactivating a
    /// compromised site must take effect quickly. The KEY is never cached —
    /// only the stored hash, which is useless on its own.
    /// </summary>
    private static readonly TimeSpan LookupTtl = TimeSpan.FromSeconds(60);

    private sealed record Registered(int Id, string Code, string Name, string? Location, string? Hash, bool IsActive);

    public async Task<AuthenticatedSite?> AuthenticateAsync(
        string? code, string? key, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(code) || string.IsNullOrWhiteSpace(key)) return null;

        var reg = await LookupAsync(code.Trim(), ct).ConfigureAwait(false);

        // Same null result for unknown, inactive and wrong-key: an anonymous
        // endpoint should not confirm which site codes exist.
        if (reg is null || !reg.IsActive || string.IsNullOrEmpty(reg.Hash))
        {
            LogRejected(logger, code ?? "(none)", reg is null ? "unknown" : !reg.IsActive ? "inactive" : "no key set");
            return null;
        }

        if (!PasswordHash.Verify(key, reg.Hash))
        {
            LogRejected(logger, reg.Code, "bad key");
            return null;
        }

        return new AuthenticatedSite(reg.Id, reg.Code, reg.Name, reg.Location);
    }

    /// <summary>
    /// Drop the cached lookup for one code, so a key rotation or deactivation
    /// takes effect on the next request rather than after the TTL.
    /// </summary>
    public Task InvalidateAsync(string code, CancellationToken ct = default) =>
        cache.RemoveAsync(CacheKey(code), ct);

    private static string CacheKey(string code) => $"labsite:{code.Trim().ToUpperInvariant()}";

    private async Task<Registered?> LookupAsync(string code, CancellationToken ct)
    {
        var cacheKey = CacheKey(code);

        var cached = await cache.GetAsync(cacheKey, ct).ConfigureAwait(false);
        if (cached is not null) return Decode(cached);

        var reg = await db.QueryAsync("labsite.lookup", async (conn, inner) =>
        {
            await using var cmd = new SqlCommand("dbo.usp_inf_lab_site_by_code", conn)
            {
                CommandType = CommandType.StoredProcedure,
            };
            cmd.Parameters.Add("@code", SqlDbType.NVarChar, 20).Value = code;

            await using var r = await cmd.ExecuteReaderAsync(CommandBehavior.SingleResult, inner).ConfigureAwait(false);
            if (!await r.ReadAsync(inner).ConfigureAwait(false)) return null;

            return new Registered(
                r.GetInt32(r.GetOrdinal("id")),
                r.GetString(r.GetOrdinal("code")),
                r.GetString(r.GetOrdinal("name")),
                r.IsDBNull(r.GetOrdinal("location")) ? null : r.GetString(r.GetOrdinal("location")),
                r.IsDBNull(r.GetOrdinal("api_key_hash")) ? null : r.GetString(r.GetOrdinal("api_key_hash")),
                !r.IsDBNull(r.GetOrdinal("is_active")) && r.GetBoolean(r.GetOrdinal("is_active")));
        }, ct).ConfigureAwait(false);

        // Negative results are cached too, so a misconfigured agent hammering
        // the endpoint cannot turn into a query per report.
        await cache.SetAsync(cacheKey, Encode(reg), LookupTtl, ct).ConfigureAwait(false);
        return reg;
    }

    /* The stored HASH travels through the cache, never the key — see the note
       in InstrumentAuthenticator, whose encoding this copies. ASCII unit
       separator, because a site name is free text that could contain a comma. */
    private const char Sep = '\u001F';

    private static string Encode(Registered? r) =>
        r is null ? "" : string.Join(Sep, r.Id, r.Code, r.Name, r.Location ?? "", r.Hash ?? "", r.IsActive ? "1" : "0");

    private static Registered? Decode(string s)
    {
        if (s.Length == 0) return null;
        var p = s.Split(Sep);
        return p.Length != 6 ? null
            : new Registered(
                int.Parse(p[0]), p[1], p[2],
                p[3].Length == 0 ? null : p[3],
                p[4].Length == 0 ? null : p[4],
                p[5] == "1");
    }

    [LoggerMessage(EventId = 1210, Level = LogLevel.Warning,
        Message = "labsite.auth.rejected code={Code} reason={Reason}")]
    private static partial void LogRejected(ILogger logger, string code, string reason);
}
