using System.Data;
using Infinity.Api.Data;
using Microsoft.Data.SqlClient;
using Microsoft.Extensions.Caching.Memory;

namespace Infinity.Api.Auth;

/// <summary>
/// A user's report visibility, as the worksheet procedure needs it.
///
/// <paramref name="ClientCodes"/> is only meaningful when neither
/// <paramref name="IsUnrestricted"/> nor <paramref name="IsDenied"/> is set —
/// an empty list is ambiguous to the procedure (it means "all"), so the two
/// extremes are modelled explicitly instead.
/// </summary>
public sealed record ReportScope(IReadOnlyList<string> ClientCodes, bool IsUnrestricted, bool IsDenied)
{
    /// <summary>No centres at all: the caller must see nothing.</summary>
    public static ReportScope Denied { get; } = new([], false, true);

    /// <summary>Every centre: pass an empty TVP, which the procedure reads as no filter.</summary>
    public static ReportScope Unrestricted { get; } = new([], true, false);
}

/// <summary>
/// MCC scope — which collection centres a user may see data for. This is the
/// control that stops one client's staff reading another client's patients, so
/// it is resolved server-side from the user id in the token and NEVER accepted
/// from the client.
///
/// Ported from Telo's db/read/userScope.ts, including its two deliberately
/// different resolutions (operational vs reporting) — see below.
/// </summary>
public sealed class ScopeRepository(
    NobleConnectionFactory db,
    SqlRetry retry,
    IMemoryCache cache)
{
    /// <summary>Usertypes the legacy LIS does not centre-scope at all.</summary>
    private static readonly int[] UnrestrictedUsertypes = [1 /* Super Admin */, 5 /* Admin */];

    /// <summary>
    /// Client logins (a collection-centre account). Hard-locked to their OWN
    /// centre — sales mappings are ignored so a client can never act on
    /// another MCC even if an admin adds mappings to their account.
    /// </summary>
    private static readonly int[] ClientUsertypes =
    [
        2 /* Client */, 7 /* Sub Client */, 8 /* CLIENT REPORTING */,
        10 /* CLIENT ACCESSION */, 12 /* CLIENT INVOICE */,
    ];

    private static readonly TimeSpan Ttl = TimeSpan.FromMinutes(5);

    /// <summary>
    /// Operational scope: what the user may ORDER and BILL under.
    ///
    /// Note the missing IsActive filter on the unrestricted branch — that is
    /// intentional and copied from Telo. IsActive is not a liveness flag for
    /// client codes and the LIS ignores it too; filtering on it silently kept
    /// ~1,700 live client codes out of every admin's scope.
    /// </summary>
    public Task<IReadOnlyList<int>> GetScopeAsync(int userId, CancellationToken ct = default) =>
        Cached($"inf:scope:{userId}", Query(userId, """
            DECLARE @ut INT = (SELECT usertypeid FROM dbo.tbl_med_user_master WHERE id = @uid);

            IF @ut IN (1, 5)
                SELECT id AS mcc_code FROM dbo.tbl_med_mcc_unit_master;
            ELSE IF @ut IN (2, 7, 8, 10, 12)
                SELECT u.PCC_Id AS mcc_code FROM dbo.tbl_med_user_master u
                WHERE u.id = @uid AND u.PCC_Id IS NOT NULL AND u.PCC_Id > 0
                UNION
                SELECT u.sub_pcc_id FROM dbo.tbl_med_user_master u
                WHERE u.id = @uid AND u.sub_pcc_id IS NOT NULL AND u.sub_pcc_id > 0;
            ELSE
                SELECT DISTINCT m.mcc_code
                FROM dbo.tbl_med_user_sales_mcc_mapping m
                WHERE m.user_id = @uid AND m.mcc_code IS NOT NULL
                UNION
                SELECT u.PCC_Id FROM dbo.tbl_med_user_master u
                WHERE u.id = @uid AND u.PCC_Id IS NOT NULL AND u.PCC_Id > 0
                UNION
                SELECT u.sub_pcc_id FROM dbo.tbl_med_user_master u
                WHERE u.id = @uid AND u.sub_pcc_id IS NOT NULL AND u.sub_pcc_id > 0;
            """), ct);

    /// <summary>
    /// Reporting scope: which centres' REPORTS the user may view.
    ///
    /// Deliberately different from the operational scope: admin-assigned
    /// mappings are honoured for EVERY usertype, including the client ones.
    /// Telo learned this the hard way — a CLIENT REPORTING user locked to their
    /// own centre saw zero reports, because the codes an admin had granted them
    /// were exactly the mappings the usertype lock discarded.
    ///
    /// Safe because this governs visibility only; ordering and billing still go
    /// through <see cref="GetScopeAsync"/>.
    /// </summary>
    public Task<IReadOnlyList<int>> GetReportScopeAsync(int userId, CancellationToken ct = default) =>
        Cached($"inf:reportscope:{userId}", Query(userId, """
            SELECT DISTINCT m.mcc_code
            FROM dbo.tbl_med_user_sales_mcc_mapping m
            WHERE m.user_id = @uid AND m.mcc_code IS NOT NULL
            UNION
            SELECT u.PCC_Id FROM dbo.tbl_med_user_master u
            WHERE u.id = @uid AND u.PCC_Id IS NOT NULL AND u.PCC_Id > 0
            UNION
            SELECT u.sub_pcc_id FROM dbo.tbl_med_user_master u
            WHERE u.id = @uid AND u.sub_pcc_id IS NOT NULL AND u.sub_pcc_id > 0;
            """), ct);

    /// <summary>
    /// The caller's report scope expressed as LIS client codes (e.g. "DL0002"),
    /// which is what the worksheet procedure filters on.
    ///
    /// The three states are kept distinct on purpose. The worksheet procedure
    /// treats an EMPTY code list as "no filter — every code", so collapsing
    /// "this user may see nothing" into the same empty list would hand that
    /// user the entire lab. <see cref="ReportScope.Denied"/> exists so the
    /// endpoint can short-circuit before the query is ever built.
    /// </summary>
    public async Task<ReportScope> GetReportClientCodesAsync(int userId, CancellationToken ct = default)
    {
        var ids = await GetReportScopeAsync(userId, ct).ConfigureAwait(false);

        if (ids.Count == 0) return ReportScope.Denied;
        if (ids.Count > Data.ScopeFilter.UnrestrictedThreshold) return ReportScope.Unrestricted;

        var key = $"inf:reportcodes:{userId}";
        if (cache.TryGetValue(key, out IReadOnlyList<string>? hit) && hit is not null)
            return new ReportScope(hit, false, false);

        var codes = await retry.ExecuteAsync("scope.reportCodes", token =>
            db.QueryAsync("scope.reportCodes", async (conn, inner) =>
            {
                await using var cmd = NobleConnectionFactory.CreateCommand(conn, "");
                var names = new List<string>(ids.Count);
                for (var i = 0; i < ids.Count; i++)
                {
                    names.Add($"@i{i}");
                    cmd.Parameters.Add($"@i{i}", SqlDbType.Int).Value = ids[i];
                }

                cmd.CommandText = $"""
                    SELECT u.MCCUnitCode
                    FROM dbo.tbl_med_mcc_unit_master u
                    WHERE u.id IN ({string.Join(',', names)})
                      AND u.MCCUnitCode IS NOT NULL
                      AND LTRIM(RTRIM(u.MCCUnitCode)) <> ''
                    """;

                await using var r = await cmd.ExecuteReaderAsync(CommandBehavior.SingleResult, inner)
                    .ConfigureAwait(false);

                var list = new List<string>();
                while (await r.ReadAsync(inner).ConfigureAwait(false))
                {
                    if (!r.IsDBNull(0)) list.Add(r.GetString(0).Trim());
                }
                return (IReadOnlyList<string>)list;
            }, token), ct).ConfigureAwait(false);

        cache.Set(key, codes, Ttl);

        // A user mapped only to centres that have no client code would resolve
        // to an empty list here — which the procedure would read as "all".
        // Deny instead.
        return codes.Count == 0 ? ReportScope.Denied : new ReportScope(codes, false, false);
    }

    public void Invalidate(int userId)
    {
        cache.Remove($"inf:scope:{userId}");
        cache.Remove($"inf:reportscope:{userId}");
        cache.Remove($"inf:reportcodes:{userId}");
    }

    private async Task<IReadOnlyList<int>> Cached(
        string key, Func<CancellationToken, Task<IReadOnlyList<int>>> load, CancellationToken ct)
    {
        if (cache.TryGetValue(key, out IReadOnlyList<int>? hit) && hit is not null) return hit;

        var scope = await load(ct).ConfigureAwait(false);
        cache.Set(key, scope, Ttl);
        return scope;
    }

    private Func<CancellationToken, Task<IReadOnlyList<int>>> Query(int userId, string sql) =>
        token => retry.ExecuteAsync("scope.resolve", inner =>
            db.QueryAsync("scope.resolve", async (conn, ct2) =>
            {
                await using var cmd = NobleConnectionFactory.CreateCommand(conn, sql);
                cmd.Parameters.Add("@uid", SqlDbType.Int).Value = userId;

                await using var reader = await cmd.ExecuteReaderAsync(CommandBehavior.SingleResult, ct2)
                    .ConfigureAwait(false);

                var ids = new List<int>();
                while (await reader.ReadAsync(ct2).ConfigureAwait(false))
                {
                    if (!reader.IsDBNull(0)) ids.Add(Convert.ToInt32(reader.GetValue(0)));
                }
                return (IReadOnlyList<int>)ids;
            }, inner), token);
}
