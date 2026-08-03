using System.Data;
using Infinity.Api.Data;
using Microsoft.Data.SqlClient;
using Microsoft.Extensions.Caching.Memory;

namespace Infinity.Api.Auth;

/// <summary>
/// Credential verification and session-version lookups against Noble.
/// </summary>
public sealed class AuthRepository(
    NobleConnectionFactory db,
    SqlRetry retry,
    IMemoryCache cache,
    ILogger<AuthRepository> logger)
{
    /// <summary>
    /// How long a session version is trusted from cache. Revocation therefore
    /// takes effect within this window rather than instantly — the alternative
    /// is a database round-trip on every authenticated request against a server
    /// shared with the live LIS. Telo makes the same trade at the same TTL.
    /// </summary>
    private static readonly TimeSpan SessionVersionTtl = TimeSpan.FromSeconds(30);

    /// <summary>
    /// Verify a username/password against Noble. Returns null when the
    /// credentials are wrong OR the account is not permitted to use Infinity —
    /// the caller must not distinguish the two, or it becomes a username oracle.
    /// </summary>
    public Task<AuthRow?> AuthenticateAsync(string username, string password, CancellationToken ct = default) =>
        retry.ExecuteAsync("auth.authenticate", token =>
            db.QueryAsync("auth.authenticate", async (conn, inner) =>
            {
                await using var cmd = new SqlCommand("dbo.usp_inf_authenticate", conn)
                {
                    CommandType = CommandType.StoredProcedure,
                };
                cmd.Parameters.Add("@Username", SqlDbType.NVarChar, 50).Value = username;
                cmd.Parameters.Add("@Password", SqlDbType.NVarChar, 50).Value = password;

                await using var reader = await cmd.ExecuteReaderAsync(CommandBehavior.SingleResult, inner)
                    .ConfigureAwait(false);

                if (!await reader.ReadAsync(inner).ConfigureAwait(false)) return null;

                return new AuthRow(
                    UserId: reader.GetOrdinalInt32("user_id") ?? 0,
                    Username: reader.GetOrdinalString("username") ?? username,
                    FirstName: reader.GetOrdinalString("first_name"),
                    LastName: reader.GetOrdinalString("last_name"),
                    Email: reader.GetOrdinalString("email"),
                    UsertypeId: reader.GetOrdinalInt32("usertype_id"),
                    UsertypeName: reader.GetOrdinalString("usertype_name"),
                    PccId: reader.GetOrdinalInt32("pcc_id"),
                    SubPccId: reader.GetOrdinalInt32("sub_pcc_id"),
                    BusinessUnitId: reader.GetOrdinalInt32("business_unit_id"),
                    InfinityRole: reader.GetOrdinalString("infinity_role"),
                    IsInfinityManaged: reader.GetOrdinalBool("is_infinity_managed"),
                    IsTeloManaged: reader.GetOrdinalBool("is_telo_managed"),
                    LisAccess: reader.GetOrdinalBool("lis_access"),
                    SessionVersion: reader.GetOrdinalInt32("session_version") ?? 0);
            }, token), ct);

    /// <summary>
    /// Current session version for a user, cached briefly.
    ///
    /// FAILS OPEN: on a database or cache error this returns the version the
    /// token already claims, so a transient blip does not sign out every user at
    /// once. The trade is that revocation is best-effort during an outage, which
    /// is the right way round — an outage should not become a lockout.
    /// </summary>
    public async Task<int> GetSessionVersionAsync(int userId, int fallback, CancellationToken ct = default)
    {
        var key = $"inf:sv:{userId}";
        if (cache.TryGetValue(key, out int cached)) return cached;

        try
        {
            var version = await retry.ExecuteAsync("auth.sessionVersion", token =>
                db.QueryAsync("auth.sessionVersion", async (conn, inner) =>
                {
                    await using var cmd = NobleConnectionFactory.CreateCommand(conn,
                        "SELECT version FROM dbo.inf_user_session_version WHERE user_id = @uid");
                    cmd.Parameters.Add("@uid", SqlDbType.Int).Value = userId;
                    cmd.CommandTimeout = 5;

                    var result = await cmd.ExecuteScalarAsync(inner).ConfigureAwait(false);
                    return result is null or DBNull ? 0 : Convert.ToInt32(result);
                }, token), ct).ConfigureAwait(false);

            cache.Set(key, version, SessionVersionTtl);
            return version;
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "auth.sessionVersion.failed userId={UserId} — failing open", userId);
            return fallback;
        }
    }
}

internal static class AuthReaderExtensions
{
    public static string? GetOrdinalString(this SqlDataReader r, string column)
    {
        var i = r.GetOrdinal(column);
        return r.IsDBNull(i) ? null : r.GetValue(i)?.ToString();
    }

    public static int? GetOrdinalInt32(this SqlDataReader r, string column)
    {
        var i = r.GetOrdinal(column);
        if (r.IsDBNull(i)) return null;
        var v = r.GetValue(i);
        return v switch
        {
            int n => n,
            short s => s,
            byte b => b,
            long l => (int)l,
            decimal d => (int)d,
            string s when int.TryParse(s, out var p) => p,
            _ => null,
        };
    }

    public static bool GetOrdinalBool(this SqlDataReader r, string column)
    {
        var i = r.GetOrdinal(column);
        if (r.IsDBNull(i)) return false;
        var v = r.GetValue(i);
        return v switch
        {
            bool b => b,
            int n => n != 0,
            byte b => b != 0,
            short s => s != 0,
            _ => false,
        };
    }
}
