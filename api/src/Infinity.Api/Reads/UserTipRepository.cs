using System.Data;
using Infinity.Api.Data;

namespace Infinity.Api.Reads;

/// <summary>
/// How many sign-ins each introductory tip has been shown on, per account
/// (inf_user_tip, script 161). A tip is shown on at most two sign-ins.
/// </summary>
public sealed class UserTipRepository(NobleConnectionFactory db, SqlRetry retry)
{
    /// <summary>The tips the client knows. Anything else is refused, so the table cannot fill with arbitrary keys.</summary>
    public static readonly IReadOnlySet<string> Known = new HashSet<string>(StringComparer.Ordinal)
    {
        "dark-mode", "report-format",
    };

    public const int MaxShowings = 2;

    public async Task<IReadOnlyDictionary<string, int>> GetAsync(int userId, CancellationToken ct = default)
    {
        return await retry.ExecuteAsync("tips.get", token =>
            db.QueryAsync("tips.get", async (conn, inner) =>
            {
                await using var cmd = NobleConnectionFactory.CreateCommand(conn,
                    "SELECT tip, shown FROM dbo.inf_user_tip WHERE user_id = @u");
                cmd.Parameters.Add("@u", SqlDbType.Int).Value = userId;
                var map = new Dictionary<string, int>(StringComparer.Ordinal);
                await using var r = await cmd.ExecuteReaderAsync(inner).ConfigureAwait(false);
                while (await r.ReadAsync(inner).ConfigureAwait(false))
                {
                    map[r.Str("tip") ?? string.Empty] = r.Int("shown");
                }
                return (IReadOnlyDictionary<string, int>)map;
            }, token), ct).ConfigureAwait(false);
    }

    /// <summary>Counts one showing; returns the new count.</summary>
    public async Task<int> MarkShownAsync(int userId, string tip, CancellationToken ct = default)
    {
        return await retry.ExecuteAsync("tips.shown", token =>
            db.QueryAsync("tips.shown", async (conn, inner) =>
            {
                await using var cmd = NobleConnectionFactory.CreateCommand(conn, """
                    MERGE dbo.inf_user_tip AS t
                    USING (SELECT @u AS user_id, @tip AS tip) AS s
                    ON t.user_id = s.user_id AND t.tip = s.tip
                    WHEN MATCHED THEN UPDATE SET shown = t.shown + 1, last_shown = SYSUTCDATETIME()
                    WHEN NOT MATCHED THEN INSERT (user_id, tip, shown, last_shown) VALUES (s.user_id, s.tip, 1, SYSUTCDATETIME());
                    SELECT shown FROM dbo.inf_user_tip WHERE user_id = @u AND tip = @tip;
                    """);
                cmd.Parameters.Add("@u", SqlDbType.Int).Value = userId;
                cmd.Parameters.Add("@tip", SqlDbType.NVarChar, 40).Value = tip;
                var v = await cmd.ExecuteScalarAsync(inner).ConfigureAwait(false);
                return v is int n ? n : Convert.ToInt32(v);
            }, token), ct).ConfigureAwait(false);
    }
}
