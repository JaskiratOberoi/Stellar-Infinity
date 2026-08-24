using System.Data;
using Infinity.Api.Data;
using Infinity.Api.Reads;
using Microsoft.Data.SqlClient;

namespace Infinity.Api.Audit;

public sealed record AuditTrailRow(
    DateTimeOffset? At,
    /// <summary>infinity | telo — which platform recorded the event.</summary>
    string Origin,
    string Kind,
    int? ActorId,
    string? ActorName,
    string? Username,
    int? BillId,
    string? Sid,
    string? Ip,
    string? Details);

public sealed record AuditTrailPage(IReadOnlyList<AuditTrailRow> Rows, int Total);

/// <summary>
/// The unified audit feed — ONE trail over every source the lab has:
///
///   inf_audit_log     Infinity's business events (orders, billing, payments,
///                     reports, accessioning) — written by <see cref="AuditLog"/>.
///   inf_auth_audit    Infinity's sign-ins and account administration.
///   inf_result_audit  Infinity's field-level result changes.
///   telo_audit_log    Telo's whole trail, read-only.
///
/// Telo's viewer reads only its own table; this one shows the lab everything
/// both platforms did, in one feed, which is the point of building it at all.
/// The three non-generic sources are normalised into the generic shape in SQL:
/// their event vocabularies map onto the same dotted kinds Telo uses (a
/// login_failed row becomes login.failure), so the web viewer needs one label
/// table for all four sources.
///
/// Every filter is applied INSIDE each source before the union, so the sort
/// works over four already-small sets rather than one enormous one.
/// </summary>
public sealed class AuditTrailRepository(NobleConnectionFactory db, SqlRetry retry)
{
    public const int MaxPageSize = 100;

    /// <summary>Kind-prefix sets per category — mirrors Telo's categoryOf().</summary>
    private static readonly Dictionary<string, string[]> Categories = new(StringComparer.OrdinalIgnoreCase)
    {
        ["reports"] = ["report."],
        ["users"] = ["admin."],
        ["auth"] = ["login.", "session."],
        ["orders"] = ["order.", "bill.", "patient."],
        ["payments"] = ["payment.", "receipt.", "mcc."],
        ["samples"] = ["sample."],
        ["results"] = ["result."],
    };

    public Task<AuditTrailPage> ListAsync(
        DateTime? from, DateTime? to, string? category, string? origin,
        int? actorId, string? q, int? billId, string? sid,
        int page, int pageSize, CancellationToken ct = default) =>
        retry.ExecuteAsync("audit.trail", token =>
            db.QueryAsync("audit.trail", async (conn, inner) =>
            {
                var size = Math.Clamp(pageSize, 1, MaxPageSize);
                var off = (Math.Max(1, page) - 1) * size;

                // Which kind prefixes the category admits. Unknown category =
                // no filter, same as "all".
                var prefixes = category is not null && Categories.TryGetValue(category, out var p) ? p : null;

                var wantInfinity = origin is null or "infinity";
                var wantTelo = origin is null or "telo";

                // One WHERE fragment per source, over that source's own column
                // names, all binding the same parameter set.
                string Where(string atCol, string kindExpr, string actorCol, string qCols, string? billCol, string? sidCol)
                {
                    var w = $" WHERE (@from IS NULL OR {atCol} >= @from) AND (@to IS NULL OR {atCol} < @to)"
                          + $" AND (@actor IS NULL OR {actorCol} = @actor)";
                    if (prefixes is not null)
                        w += " AND (" + string.Join(" OR ", prefixes.Select((_, i) => $"{kindExpr} LIKE @pfx{i}")) + ")";
                    // Free search covers the kind and the payload — a SID or
                    // bill number typed here finds its events, like Telo's box.
                    w += $" AND (@q IS NULL OR {qCols})";
                    w += billCol is null
                        ? " AND (@bill IS NULL)"
                        : $" AND (@bill IS NULL OR {billCol} = @bill)";
                    w += sidCol is null
                        ? " AND (@sid IS NULL)"
                        : $" AND (@sid IS NULL OR {sidCol} = @sid)";
                    return w;
                }

                var parts = new List<string>();

                if (wantInfinity)
                {
                    parts.Add("""
                        SELECT a.at, origin = 'infinity', kind = a.kind,
                               actor_id = a.actor_id, a.username,
                               bill_id = a.bill_id, sid = a.sid, ip = a.ip, details = a.details
                        FROM dbo.inf_audit_log a
                        """ + Where("a.at", "a.kind", "a.actor_id",
                                    "(a.kind LIKE @qlike OR a.details LIKE @qlike OR a.username LIKE @qlike OR a.sid LIKE @qlike OR CONVERT(VARCHAR(20), a.bill_id) = @q)",
                                    "a.bill_id", "a.sid"));

                    // Auth events, renamed into the shared vocabulary. detail
                    // and target ride as JSON so the viewer's chip renderer
                    // treats every source alike.
                    parts.Add("""
                        SELECT CONVERT(DATETIME2(3), u.occurred_at), 'infinity',
                               kind = CASE u.event
                                   WHEN 'login'             THEN 'login.success'
                                   WHEN 'login_failed'      THEN 'login.failure'
                                   WHEN 'login_blocked'     THEN 'login.rate_limited'
                                   WHEN 'logout'            THEN 'session.logout'
                                   WHEN 'token_revoked'     THEN 'session.revoked'
                                   WHEN 'password_change'   THEN 'admin.user.password'
                                   WHEN 'role_change'       THEN 'admin.user.role'
                                   WHEN 'active_change'     THEN 'admin.user.active'
                                   WHEN 'lis_access_change' THEN 'admin.user.lis_access'
                                   WHEN 'scope_change'      THEN 'admin.user.update'
                                   WHEN 'profile_change'    THEN 'admin.user.profile'
                                   WHEN 'user_created'      THEN 'admin.user.create'
                                   ELSE CONCAT('admin.', u.event) END,
                               u.actor_user_id, u.actor_username,
                               NULL, NULL, u.actor_ip,
                               details = CONCAT('{',
                                   CASE WHEN u.target_username IS NOT NULL
                                        THEN CONCAT('"target":"', STRING_ESCAPE(u.target_username, 'json'), '",')
                                        WHEN u.target_user_id IS NOT NULL
                                        THEN CONCAT('"target":"#', u.target_user_id, '",')
                                        ELSE '' END,
                                   CASE WHEN u.succeeded = 0 THEN '"failed":true,' ELSE '' END,
                                   '"detail":"', STRING_ESCAPE(ISNULL(u.detail, ''), 'json'), '"}')
                        FROM dbo.inf_auth_audit u
                        """ + Where("CONVERT(DATETIME2(3), u.occurred_at)",
                                    """
                                    (CASE u.event WHEN 'login' THEN 'login.success' WHEN 'login_failed' THEN 'login.failure'
                                     WHEN 'login_blocked' THEN 'login.rate_limited' WHEN 'logout' THEN 'session.logout'
                                     WHEN 'token_revoked' THEN 'session.revoked' ELSE CONCAT('admin.', u.event) END)
                                    """,
                                    "u.actor_user_id",
                                    "(u.event LIKE @qlike OR u.actor_username LIKE @qlike OR u.target_username LIKE @qlike OR u.detail LIKE @qlike)",
                                    null, null));

                    // Result changes — the trail Telo does not have at all.
                    parts.Add("""
                        SELECT CONVERT(DATETIME2(3), r.occurred_at), 'infinity',
                               kind = CONCAT('result.', r.action),
                               r.actor_user_id, r.actor_username,
                               NULL, r.vailid, r.actor_ip,
                               details = CONCAT('{"test":"', STRING_ESCAPE(ISNULL(r.test_code, ''), 'json'),
                                   '","field":"', STRING_ESCAPE(r.field, 'json'), '"',
                                   CASE WHEN r.reason IS NOT NULL
                                        THEN CONCAT(',"reason":"', STRING_ESCAPE(r.reason, 'json'), '"') ELSE '' END,
                                   CASE WHEN r.source <> 'ui'
                                        THEN CONCAT(',"source":"', STRING_ESCAPE(r.source, 'json'), '"') ELSE '' END, '}')
                        FROM dbo.inf_result_audit r
                        """ + Where("CONVERT(DATETIME2(3), r.occurred_at)", "CONCAT('result.', r.action)", "r.actor_user_id",
                                    "(r.action LIKE @qlike OR r.vailid LIKE @qlike OR r.test_code LIKE @qlike OR r.actor_username LIKE @qlike)",
                                    null, "r.vailid"));
                }

                if (wantTelo)
                {
                    // Telo's own trail, read-only. It keeps billId inside the
                    // JSON, so the bill filter falls back to a JSON probe here
                    // — fine at this table's size, and only when asked.
                    parts.Add("""
                        SELECT t.at, 'telo', t.kind, t.actor_id, t.username,
                               bill_id = CASE WHEN ISJSON(t.details) = 1
                                              THEN TRY_CONVERT(INT, JSON_VALUE(t.details, '$.billId')) END,
                               sid = CASE WHEN ISJSON(t.details) = 1
                                          THEN JSON_VALUE(t.details, '$.sid') END,
                               NULL, t.details
                        FROM dbo.telo_audit_log t
                        """ + Where("t.at", "t.kind", "t.actor_id",
                                    "(t.kind LIKE @qlike OR t.details LIKE @qlike OR t.username LIKE @qlike)",
                                    "CASE WHEN ISJSON(t.details) = 1 THEN TRY_CONVERT(INT, JSON_VALUE(t.details, '$.billId')) END",
                                    "CASE WHEN ISJSON(t.details) = 1 THEN JSON_VALUE(t.details, '$.sid') END"));
                }

                var union = string.Join("\nUNION ALL\n", parts);
                var sql = $"""
                    WITH feed (at, origin, kind, actor_id, username, bill_id, sid, ip, details) AS (
                        {union}
                    )
                    SELECT total = COUNT(*) OVER (),
                           f.at, f.origin, f.kind, f.actor_id, f.username,
                           f.bill_id, f.sid, f.ip, f.details,
                           actor_name = NULLIF(LTRIM(RTRIM(CONCAT(um.firstname, ' ', um.lastname))), '')
                    FROM feed f
                    LEFT JOIN dbo.tbl_med_user_master um ON um.id = f.actor_id
                    ORDER BY f.at DESC
                    OFFSET @off ROWS FETCH NEXT @size ROWS ONLY;
                    """;

                await using var cmd = NobleConnectionFactory.CreateCommand(conn, sql);
                cmd.CommandTimeout = 30;
                cmd.Parameters.Add("@from", SqlDbType.DateTime2).Value = (object?)from ?? DBNull.Value;
                cmd.Parameters.Add("@to", SqlDbType.DateTime2).Value = (object?)to ?? DBNull.Value;
                cmd.Parameters.Add("@actor", SqlDbType.Int).Value = (object?)actorId ?? DBNull.Value;
                // Metacharacters stripped the same way the Bills search does,
                // so a stray % cannot turn the probe into match-everything.
                var qSafe = string.IsNullOrWhiteSpace(q)
                    ? null
                    : System.Text.RegularExpressions.Regex.Replace(q.Trim(), @"[%_\[\]]", " ").Trim();
                if (string.IsNullOrEmpty(qSafe)) qSafe = null;
                cmd.Parameters.Add("@q", SqlDbType.NVarChar, 100).Value = (object?)qSafe ?? DBNull.Value;
                cmd.Parameters.Add("@qlike", SqlDbType.NVarChar, 102).Value =
                    (object?)(qSafe is null ? null : $"%{qSafe}%") ?? DBNull.Value;
                cmd.Parameters.Add("@bill", SqlDbType.Int).Value = (object?)billId ?? DBNull.Value;
                cmd.Parameters.Add("@sid", SqlDbType.NVarChar, 50).Value =
                    (object?)(string.IsNullOrWhiteSpace(sid) ? null : sid.Trim()) ?? DBNull.Value;
                if (prefixes is not null)
                    for (var i = 0; i < prefixes.Length; i++)
                        cmd.Parameters.Add($"@pfx{i}", SqlDbType.VarChar, 62).Value = prefixes[i] + "%";
                cmd.Parameters.Add("@off", SqlDbType.Int).Value = off;
                cmd.Parameters.Add("@size", SqlDbType.Int).Value = size;

                var rows = new List<AuditTrailRow>();
                var total = 0;
                await using var r = await cmd.ExecuteReaderAsync(CommandBehavior.SingleResult, inner).ConfigureAwait(false);
                while (await r.ReadAsync(inner).ConfigureAwait(false))
                {
                    if (rows.Count == 0) total = r.Int("total");
                    rows.Add(new AuditTrailRow(
                        Domain.NobleTime.ToIst(r.Date("at")),
                        r.Str("origin") ?? "infinity",
                        r.Str("kind") ?? "",
                        r.NullableInt("actor_id"),
                        r.Str("actor_name"),
                        r.Str("username"),
                        r.NullableInt("bill_id"),
                        r.Str("sid"),
                        r.Str("ip"),
                        r.Str("details")));
                }
                return new AuditTrailPage(rows, total);
            }, token), ct);
}
