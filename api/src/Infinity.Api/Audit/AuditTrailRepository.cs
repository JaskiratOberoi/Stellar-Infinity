using System.Data;
using Infinity.Api.Data;
using Infinity.Api.Reads;
using Microsoft.Data.SqlClient;

namespace Infinity.Api.Audit;

public sealed record AuditTrailRow(
    DateTimeOffset? At,
    /// <summary>infinity | telo | lis — which platform recorded the event.</summary>
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
///   inf_audit_log              Infinity's business events — written by <see cref="AuditLog"/>.
///   inf_auth_audit             Infinity's sign-ins and account administration.
///   inf_result_audit           Infinity's field-level result changes.
///   telo_audit_log             Telo's whole trail, read-only.
///   TBL_MED_USER_ACTIVITY_LOG  the legacy LIS's own 16M-row activity log,
///                              read-only, folded in AS the LIS's (origin
///                              'lis') — never disguised as either platform's.
///
/// The non-generic sources are normalised into the generic shape in SQL: the
/// auth and result vocabularies map onto the same dotted kinds Telo uses, and
/// the LIS's free-text FUNCTION_PERFORMED rides in the payload under the one
/// kind 'lis.activity', which no category claims.
///
/// PERFORMANCE IS STRUCTURAL HERE, because of that fifth source. Three rules,
/// each learned by watching the naive version take 91 seconds:
///
///   • Every branch takes TOP (@lim = offset+page) in at-DESC order BEFORE
///     the union, so the final sort ranks a few hundred rows, not a window.
///   • The total is its own query, with the LIS's contribution capped at
///     <see cref="CountCap"/> — an exact count of a 16M-row log is a scan,
///     and "10,000+" answers the pager just as well.
///   • OPTION (RECOMPILE) on both, so the "@x IS NULL OR …" convenience
///     predicates collapse at plan time into real index seeks
///     (IX_user_activity_log_date exists for exactly this — see 129).
/// </summary>
public sealed class AuditTrailRepository(NobleConnectionFactory db, SqlRetry retry)
{
    public const int MaxPageSize = 100;

    /// <summary>Per-source ceiling on the counted total. See the class doc.</summary>
    public const int CountCap = 10_000;

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

    /// <summary>One source's SELECT body and the WHERE-fragment inputs that
    /// built it, kept so the count query can reuse the filter without the
    /// payload columns.</summary>
    private sealed record Source(string Body, string From, string WhereClause, string AtCol);

    public Task<AuditTrailPage> ListAsync(
        DateTime? from, DateTime? to, string? category, string? origin,
        int? actorId, string? q, int? billId, string? sid,
        int page, int pageSize, CancellationToken ct = default) =>
        retry.ExecuteAsync("audit.trail", token =>
            db.QueryAsync("audit.trail", async (conn, inner) =>
            {
                var size = Math.Clamp(pageSize, 1, MaxPageSize);
                var off = (Math.Max(1, page) - 1) * size;

                var prefixes = category is not null && Categories.TryGetValue(category, out var p) ? p : null;

                var wantInfinity = origin is null or "infinity";
                var wantTelo = origin is null or "telo";
                // The LIS bears one kind (lis.activity) that no category
                // prefix matches, so a category filter excludes it unqueried.
                var wantLis = (origin is null or "lis") && prefixes is null;

                string Where(string atCol, string kindExpr, string actorCol, string qCols, string? billCol, string? sidCol)
                {
                    var w = $" WHERE (@from IS NULL OR {atCol} >= @from) AND (@to IS NULL OR {atCol} < @to)"
                          + $" AND (@actor IS NULL OR {actorCol} = @actor)";
                    if (prefixes is not null)
                        w += " AND (" + string.Join(" OR ", prefixes.Select((_, i) => $"{kindExpr} LIKE @pfx{i}")) + ")";
                    w += $" AND (@q IS NULL OR {qCols})";
                    w += billCol is null
                        ? " AND (@bill IS NULL)"
                        : $" AND (@bill IS NULL OR {billCol} = @bill)";
                    w += sidCol is null
                        ? " AND (@sid IS NULL)"
                        : $" AND (@sid IS NULL OR {sidCol} = @sid)";
                    return w;
                }

                var sources = new List<Source>();

                if (wantInfinity)
                {
                    sources.Add(new Source(
                        """
                        at = a.at, origin = 'infinity', kind = a.kind,
                        actor_id = a.actor_id, username = a.username,
                        bill_id = a.bill_id, sid = a.sid, ip = a.ip, details = a.details
                        """,
                        "FROM dbo.inf_audit_log a",
                        Where("a.at", "a.kind", "a.actor_id",
                            "(a.kind LIKE @qlike OR a.details LIKE @qlike OR a.username LIKE @qlike OR a.sid LIKE @qlike OR CONVERT(VARCHAR(20), a.bill_id) = @q)",
                            "a.bill_id", "a.sid"),
                        "a.at"));

                    // Auth events, renamed into the shared vocabulary; detail
                    // and target ride as JSON so the chip renderer treats
                    // every source alike. Wall clock, not DATETIMEOFFSET —
                    // the union sorts by this column and the other sources
                    // are offsetless, so keeping the offset here would file
                    // every auth row 5h30 adrift.
                    sources.Add(new Source(
                        """
                        at = CONVERT(DATETIME2(3), u.occurred_at), origin = 'infinity',
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
                        actor_id = u.actor_user_id, username = u.actor_username,
                        bill_id = CONVERT(INT, NULL), sid = CONVERT(NVARCHAR(50), NULL),
                        ip = u.actor_ip,
                        details = CONCAT('{',
                            CASE WHEN u.target_username IS NOT NULL
                                 THEN CONCAT('"target":"', STRING_ESCAPE(u.target_username, 'json'), '",')
                                 WHEN u.target_user_id IS NOT NULL
                                 THEN CONCAT('"target":"#', u.target_user_id, '",')
                                 ELSE '' END,
                            CASE WHEN u.succeeded = 0 THEN '"failed":true,' ELSE '' END,
                            '"detail":"', STRING_ESCAPE(ISNULL(u.detail, ''), 'json'), '"}')
                        """,
                        "FROM dbo.inf_auth_audit u",
                        Where("CONVERT(DATETIME2(3), u.occurred_at)",
                            """
                            (CASE u.event WHEN 'login' THEN 'login.success' WHEN 'login_failed' THEN 'login.failure'
                             WHEN 'login_blocked' THEN 'login.rate_limited' WHEN 'logout' THEN 'session.logout'
                             WHEN 'token_revoked' THEN 'session.revoked' ELSE CONCAT('admin.', u.event) END)
                            """,
                            "u.actor_user_id",
                            "(u.event LIKE @qlike OR u.actor_username LIKE @qlike OR u.target_username LIKE @qlike OR u.detail LIKE @qlike)",
                            null, null),
                        "u.occurred_at"));

                    // Result changes — the trail Telo has no equivalent of.
                    sources.Add(new Source(
                        """
                        at = CONVERT(DATETIME2(3), r.occurred_at), origin = 'infinity',
                        kind = CONCAT('result.', r.action),
                        actor_id = r.actor_user_id, username = r.actor_username,
                        bill_id = CONVERT(INT, NULL), sid = r.vailid, ip = r.actor_ip,
                        details = CONCAT('{"test":"', STRING_ESCAPE(ISNULL(r.test_code, ''), 'json'),
                            '","field":"', STRING_ESCAPE(r.field, 'json'), '"',
                            CASE WHEN r.reason IS NOT NULL
                                 THEN CONCAT(',"reason":"', STRING_ESCAPE(r.reason, 'json'), '"') ELSE '' END,
                            CASE WHEN r.source <> 'ui'
                                 THEN CONCAT(',"source":"', STRING_ESCAPE(r.source, 'json'), '"') ELSE '' END, '}')
                        """,
                        "FROM dbo.inf_result_audit r",
                        Where("CONVERT(DATETIME2(3), r.occurred_at)", "CONCAT('result.', r.action)", "r.actor_user_id",
                            "(r.action LIKE @qlike OR r.vailid LIKE @qlike OR r.test_code LIKE @qlike OR r.actor_username LIKE @qlike)",
                            null, "r.vailid"),
                        "r.occurred_at"));
                }

                if (wantLis)
                {
                    // The legacy LIS's own trail: free-text prose folded in AS
                    // the LIS's — origin 'lis', one kind, the text carried in
                    // the payload for the viewer to print verbatim. Nothing
                    // here pretends to be an Infinity event; the badge is the
                    // distinction. Date-ranged via IX_user_activity_log_date.
                    sources.Add(new Source(
                        """
                        at = l.FUNCTION_DATE, origin = 'lis', kind = 'lis.activity',
                        actor_id = l.USERID, username = CONVERT(NVARCHAR(50), NULL),
                        bill_id = CONVERT(INT, NULL),
                        sid = CONVERT(NVARCHAR(50), NULLIF(NULLIF(LTRIM(RTRIM(l.SAMPLEID)), ''), '0')),
                        ip = NULLIF(LTRIM(RTRIM(l.IPADDRESS)), ''),
                        details = CONCAT('{"action":"',
                            STRING_ESCAPE(ISNULL(l.FUNCTION_PERFORMED, ''), 'json'), '"',
                            CASE WHEN NULLIF(NULLIF(LTRIM(RTRIM(l.PID)), ''), '0') IS NOT NULL
                                 THEN CONCAT(',"pid":"', STRING_ESCAPE(LTRIM(RTRIM(l.PID)), 'json'), '"')
                                 ELSE '' END,
                            CASE WHEN NULLIF(LTRIM(RTRIM(l.OTEHR_INFO)), '') IS NOT NULL
                                 THEN CONCAT(',"info":"', STRING_ESCAPE(LTRIM(RTRIM(l.OTEHR_INFO)), 'json'), '"')
                                 ELSE '' END, '}')
                        """,
                        "FROM dbo.TBL_MED_USER_ACTIVITY_LOG l",
                        Where("l.FUNCTION_DATE", "'lis.activity'", "l.USERID",
                            "(l.FUNCTION_PERFORMED LIKE @qlike OR l.PID LIKE @qlike OR l.SAMPLEID LIKE @qlike)",
                            null, "l.SAMPLEID"),
                        "l.FUNCTION_DATE"));
                }

                if (wantTelo)
                {
                    // Telo's own trail, read-only. It keeps billId inside the
                    // JSON, so the bill filter falls back to a JSON probe here
                    // — fine at this table's size, and only when asked.
                    sources.Add(new Source(
                        """
                        at = t.at, origin = 'telo', kind = t.kind,
                        actor_id = t.actor_id, username = t.username,
                        bill_id = CASE WHEN ISJSON(t.details) = 1
                                       THEN TRY_CONVERT(INT, JSON_VALUE(t.details, '$.billId')) END,
                        sid = CASE WHEN ISJSON(t.details) = 1
                                   THEN CONVERT(NVARCHAR(50), JSON_VALUE(t.details, '$.sid')) END,
                        ip = CONVERT(NVARCHAR(64), NULL), details = t.details
                        """,
                        "FROM dbo.telo_audit_log t",
                        Where("t.at", "t.kind", "t.actor_id",
                            "(t.kind LIKE @qlike OR t.details LIKE @qlike OR t.username LIKE @qlike)",
                            "CASE WHEN ISJSON(t.details) = 1 THEN TRY_CONVERT(INT, JSON_VALUE(t.details, '$.billId')) END",
                            "CASE WHEN ISJSON(t.details) = 1 THEN JSON_VALUE(t.details, '$.sid') END"),
                        "t.at"));
                }

                // Origin 'lis' plus a category filter admits no source at all —
                // an empty page is the true answer, and an empty UNION is not SQL.
                if (sources.Count == 0) return new AuditTrailPage([], 0);

                void BindShared(SqlCommand c)
                {
                    c.Parameters.Add("@from", SqlDbType.DateTime2).Value = (object?)from ?? DBNull.Value;
                    c.Parameters.Add("@to", SqlDbType.DateTime2).Value = (object?)to ?? DBNull.Value;
                    c.Parameters.Add("@actor", SqlDbType.Int).Value = (object?)actorId ?? DBNull.Value;
                    // Metacharacters stripped the same way the Bills search
                    // does, so a stray % cannot become match-everything.
                    var qSafe = string.IsNullOrWhiteSpace(q)
                        ? null
                        : System.Text.RegularExpressions.Regex.Replace(q.Trim(), @"[%_\[\]]", " ").Trim();
                    if (string.IsNullOrEmpty(qSafe)) qSafe = null;
                    c.Parameters.Add("@q", SqlDbType.NVarChar, 100).Value = (object?)qSafe ?? DBNull.Value;
                    c.Parameters.Add("@qlike", SqlDbType.NVarChar, 102).Value =
                        (object?)(qSafe is null ? null : $"%{qSafe}%") ?? DBNull.Value;
                    c.Parameters.Add("@bill", SqlDbType.Int).Value = (object?)billId ?? DBNull.Value;
                    c.Parameters.Add("@sid", SqlDbType.NVarChar, 50).Value =
                        (object?)(string.IsNullOrWhiteSpace(sid) ? null : sid.Trim()) ?? DBNull.Value;
                    if (prefixes is not null)
                        for (var i = 0; i < prefixes.Length; i++)
                            c.Parameters.Add($"@pfx{i}", SqlDbType.VarChar, 62).Value = prefixes[i] + "%";
                }

                // ---- the page ------------------------------------------------
                // Each branch pre-ranks itself: TOP (offset+size) newest-first
                // inside a derived table, so the union's sort sees at most
                // sources × (offset+size) rows however wide the window is.
                var branches = sources.Select((s, n) =>
                    $"SELECT * FROM (SELECT TOP (@lim) {s.Body} {s.From}{s.WhereClause} ORDER BY {s.AtCol} DESC) src{n}");
                var rowsSql = $"""
                    WITH feed AS (
                        {string.Join("\nUNION ALL\n", branches)}
                    )
                    SELECT f.at, f.origin, f.kind, f.actor_id, f.username,
                           f.bill_id, f.sid, f.ip, f.details,
                           actor_name = NULLIF(LTRIM(RTRIM(CONCAT(um.firstname, ' ', um.lastname))), '')
                    FROM feed f
                    LEFT JOIN dbo.tbl_med_user_master um ON um.id = f.actor_id
                    ORDER BY f.at DESC
                    OFFSET @off ROWS FETCH NEXT @size ROWS ONLY
                    OPTION (RECOMPILE);
                    """;

                var rows = new List<AuditTrailRow>();
                await using (var cmd = NobleConnectionFactory.CreateCommand(conn, rowsSql))
                {
                    cmd.CommandTimeout = 30;
                    BindShared(cmd);
                    cmd.Parameters.Add("@lim", SqlDbType.Int).Value = off + size;
                    cmd.Parameters.Add("@off", SqlDbType.Int).Value = off;
                    cmd.Parameters.Add("@size", SqlDbType.Int).Value = size;

                    await using var r = await cmd.ExecuteReaderAsync(CommandBehavior.SingleResult, inner).ConfigureAwait(false);
                    while (await r.ReadAsync(inner).ConfigureAwait(false))
                    {
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
                }

                // ---- the total -----------------------------------------------
                // Its own query, capped per source: the pager needs "is there
                // a next page", not the exact cardinality of a 16M-row log.
                var counts = sources.Select((s, n) =>
                    $"(SELECT COUNT(*) FROM (SELECT TOP (@cap) 1 AS x {s.From}{s.WhereClause}) c{n})");
                var countSql = $"SELECT total = {string.Join("\n + ", counts)} OPTION (RECOMPILE);";

                int total;
                await using (var cmd = NobleConnectionFactory.CreateCommand(conn, countSql))
                {
                    cmd.CommandTimeout = 30;
                    BindShared(cmd);
                    cmd.Parameters.Add("@cap", SqlDbType.Int).Value = CountCap;
                    total = Convert.ToInt32(await cmd.ExecuteScalarAsync(inner).ConfigureAwait(false));
                }

                return new AuditTrailPage(rows, total);
            }, token), ct);
}
