using System.Data;
using Infinity.Api.Data;
using Infinity.Api.Worksheet;
using Microsoft.Data.SqlClient;
using Microsoft.Extensions.Caching.Memory;

namespace Infinity.Api.Instruments;

public sealed record AuthenticatedInstrument(int Id, string Code, string Name);

/// <summary>
/// Authenticates an analyser from its <c>X-Instrument-Code</c> and
/// <c>X-Instrument-Key</c> headers.
///
/// Deliberately NOT a user JWT. An analyser has no role, no MCC scope and no
/// session to revoke; it must keep posting when every human is signed out, and
/// it must never inherit a person's privileges. Its only permission is "may
/// deposit readings into the inbox".
///
/// Only the key hash is stored, and verification is the constant-time
/// pbkdf2 comparison in <see cref="PasswordHash"/> — the same primitive as the
/// auto-auth unlock secret.
/// </summary>
public sealed partial class InstrumentAuthenticator(
    NobleConnectionFactory db,
    IMemoryCache cache,
    ILogger<InstrumentAuthenticator> logger)
{
    /// <summary>
    /// How long a code→hash lookup is cached. Short, because deactivating a
    /// compromised analyser must take effect quickly. The KEY is never cached —
    /// only the stored hash, which is useless on its own.
    /// </summary>
    private static readonly TimeSpan LookupTtl = TimeSpan.FromSeconds(60);

    private sealed record Registered(int Id, string Code, string Name, string? Hash, bool IsActive);

    public async Task<AuthenticatedInstrument?> AuthenticateAsync(
        string? code, string? key, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(code) || string.IsNullOrWhiteSpace(key)) return null;

        var reg = await LookupAsync(code.Trim(), ct).ConfigureAwait(false);

        // Same null result for unknown, inactive and wrong-key: an analyser
        // endpoint should not confirm which instrument codes exist.
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

        return new AuthenticatedInstrument(reg.Id, reg.Code, reg.Name);
    }

    private async Task<Registered?> LookupAsync(string code, CancellationToken ct)
    {
        var cacheKey = $"inf:instrument:{code.ToUpperInvariant()}";
        if (cache.TryGetValue(cacheKey, out Registered? hit)) return hit;

        var reg = await db.QueryAsync("instrument.lookup", async (conn, inner) =>
        {
            await using var cmd = new SqlCommand("dbo.usp_inf_instrument_by_code", conn)
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
                r.IsDBNull(r.GetOrdinal("api_key_hash")) ? null : r.GetString(r.GetOrdinal("api_key_hash")),
                !r.IsDBNull(r.GetOrdinal("is_active")) && r.GetBoolean(r.GetOrdinal("is_active")));
        }, ct).ConfigureAwait(false);

        // Negative results are cached too, so a misconfigured analyser hammering
        // the endpoint cannot turn into a query per message.
        cache.Set(cacheKey, reg, LookupTtl);
        return reg;
    }

    [LoggerMessage(EventId = 1200, Level = LogLevel.Warning,
        Message = "instrument.auth.rejected code={Code} reason={Reason}")]
    private static partial void LogRejected(ILogger logger, string code, string reason);
}
