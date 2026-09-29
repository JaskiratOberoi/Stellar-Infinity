using System.Data;
using Infinity.Api.Data;
using Infinity.Api.Reads;
using Microsoft.Data.SqlClient;

namespace Infinity.Api.Messaging;

public sealed record WaMessage(
    long Id, int? Pid, string? Sids, string? ClientCode, string? PatientName, string Phone,
    string Kind, string Trigger, string Status, int Attempts, string? Error, string? WaId,
    int? CreatedBy, DateTime CreatedAt, DateTime? SentAt, DateTime UpdatedAt)
{
    public IReadOnlyList<string> SidList =>
        (Sids ?? string.Empty).Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
}

/// <summary>A visit ready to go out automatically: every sample released, a usable mobile.</summary>
public sealed record WaCandidate(int Pid, string ClientCode, string? PatientName, string Phone, IReadOnlyList<string> Sids);

/// <summary>A visit's patient, for a manual send.</summary>
public sealed record WaPatient(int Pid, string? ClientCode, string? PatientName, string? Phone, IReadOnlyList<string> ReleasedSids);

/// <summary>The WhatsApp queue and log (inf_wa_message and friends, script 172).</summary>
public sealed class WhatsAppRepository(NobleConnectionFactory db, SqlRetry retry, WhatsAppOptions options)
{
    private string Instance => options.Instance ?? throw new InvalidOperationException("WhatsApp__Instance is not configured.");

    private const string Cols = """
        id, pid, sids, client_code, patient_name, phone, kind, [trigger], status, attempts, error, wa_id,
        created_by, created_at, sent_at, updated_at
        """;

    private static WaMessage Read(SqlDataReader r) => new(
        Convert.ToInt64(r["id"]),
        r["pid"] is DBNull ? null : Convert.ToInt32(r["pid"]),
        r.Str("sids"), r.Str("client_code"), r.Str("patient_name"), r.Str("phone") ?? "",
        r.Str("kind") ?? "report", r.Str("trigger") ?? "manual", r.Str("status") ?? "queued",
        Convert.ToInt32(r["attempts"]), r.Str("error"), r.Str("wa_id"),
        r["created_by"] is DBNull ? null : Convert.ToInt32(r["created_by"]),
        Convert.ToDateTime(r["created_at"]),
        r["sent_at"] is DBNull ? null : Convert.ToDateTime(r["sent_at"]),
        Convert.ToDateTime(r["updated_at"]));

    /// <summary>
    /// Queue one message. An automatic one is unique per visit: if the visit
    /// was already sent automatically, nothing is queued and null comes back.
    /// Not retried — a replayed insert would be a second message.
    /// </summary>
    public async Task<long?> EnqueueAsync(int? pid, IReadOnlyList<string> sids, string? clientCode, string? name,
                                          string phone, string kind, string trigger, int? actor, CancellationToken ct = default)
    {
        try
        {
            return await db.QueryAsync("wa.enqueue", async (conn, inner) =>
            {
                await using var cmd = NobleConnectionFactory.CreateCommand(conn, """
                    INSERT INTO dbo.inf_wa_message (instance, pid, sids, client_code, patient_name, phone, kind, [trigger], created_by)
                    VALUES (@i, @pid, @sids, @cc, @name, @phone, @kind, @trigger, @by);
                    SELECT CAST(SCOPE_IDENTITY() AS BIGINT);
                    """);
                cmd.Parameters.Add("@i", SqlDbType.VarChar, 12).Value = Instance;
                cmd.Parameters.Add("@pid", SqlDbType.Int).Value = (object?)pid ?? DBNull.Value;
                cmd.Parameters.Add("@sids", SqlDbType.NVarChar, 600).Value = sids.Count == 0 ? DBNull.Value : string.Join(",", sids);
                cmd.Parameters.Add("@cc", SqlDbType.NVarChar, 50).Value = (object?)clientCode ?? DBNull.Value;
                cmd.Parameters.Add("@name", SqlDbType.NVarChar, 150).Value = (object?)name ?? DBNull.Value;
                cmd.Parameters.Add("@phone", SqlDbType.VarChar, 15).Value = phone;
                cmd.Parameters.Add("@kind", SqlDbType.VarChar, 12).Value = kind;
                cmd.Parameters.Add("@trigger", SqlDbType.VarChar, 8).Value = trigger;
                cmd.Parameters.Add("@by", SqlDbType.Int).Value = (object?)actor ?? DBNull.Value;
                return (long?)Convert.ToInt64(await cmd.ExecuteScalarAsync(inner).ConfigureAwait(false));
            }, ct).ConfigureAwait(false);
        }
        catch (SqlException e) when (e.Number is 2601 or 2627)
        {
            return null;
        }
    }

    /// <summary>Take the oldest queued message of this instance and mark it sending.</summary>
    /// <param name="testsOnly">Sending is switched off: only an admin's test message may go.</param>
    /// <param name="noAuto">Quiet hours: automatic messages wait; one a person sent goes.</param>
    public Task<WaMessage?> ClaimNextAsync(bool testsOnly, bool noAuto, CancellationToken ct = default) =>
        db.QueryAsync("wa.claim", async (conn, inner) =>
        {
            await using var cmd = NobleConnectionFactory.CreateCommand(conn, $"""
                WITH q AS (
                    SELECT TOP (1) * FROM dbo.inf_wa_message WITH (UPDLOCK, READPAST, ROWLOCK)
                    WHERE instance = @i AND status = 'queued' AND (@tests = 0 OR kind = 'test')
                      AND (@noauto = 0 OR [trigger] <> 'auto') ORDER BY id)
                UPDATE q SET status = 'sending', attempts = attempts + 1, updated_at = SYSUTCDATETIME()
                OUTPUT {string.Join(", ", Cols.Split(',').Select(c => "inserted." + c.Trim()))};
                """);
            cmd.Parameters.Add("@i", SqlDbType.VarChar, 12).Value = Instance;
            cmd.Parameters.Add("@tests", SqlDbType.Bit).Value = testsOnly;
            cmd.Parameters.Add("@noauto", SqlDbType.Bit).Value = noAuto;
            await using var r = await cmd.ExecuteReaderAsync(inner).ConfigureAwait(false);
            return await r.ReadAsync(inner).ConfigureAwait(false) ? Read(r) : null;
        }, ct);

    /// <summary>The phone was not ready: that try does not count against the message.</summary>
    public Task RefundAttemptAsync(long id, CancellationToken ct = default) =>
        retry.ExecuteAsync("wa.refund", token => db.QueryAsync("wa.refund", async (conn, inner) =>
        {
            await using var cmd = NobleConnectionFactory.CreateCommand(conn,
                "UPDATE dbo.inf_wa_message SET attempts = attempts - 1 WHERE id = @id AND attempts > 0");
            cmd.Parameters.Add("@id", SqlDbType.BigInt).Value = id;
            return await cmd.ExecuteNonQueryAsync(inner).ConfigureAwait(false);
        }, token), ct);

    public Task MarkAsync(long id, string status, string? error = null, string? waId = null, bool sent = false,
                          CancellationToken ct = default) =>
        retry.ExecuteAsync("wa.mark", token => db.QueryAsync("wa.mark", async (conn, inner) =>
        {
            await using var cmd = NobleConnectionFactory.CreateCommand(conn, """
                UPDATE dbo.inf_wa_message SET status = @s, error = @e, wa_id = COALESCE(@w, wa_id),
                    sent_at = CASE WHEN @sent = 1 THEN SYSUTCDATETIME() ELSE sent_at END,
                    attempts = CASE WHEN @s = 'queued' AND @requeue = 1 THEN 0 ELSE attempts END,
                    updated_at = SYSUTCDATETIME()
                WHERE id = @id;
                """);
            cmd.Parameters.Add("@id", SqlDbType.BigInt).Value = id;
            cmd.Parameters.Add("@s", SqlDbType.VarChar, 12).Value = status;
            cmd.Parameters.Add("@e", SqlDbType.NVarChar, 400).Value = error is null ? DBNull.Value : (error.Length > 400 ? error[..400] : error);
            cmd.Parameters.Add("@w", SqlDbType.VarChar, 160).Value = (object?)waId ?? DBNull.Value;
            cmd.Parameters.Add("@sent", SqlDbType.Bit).Value = sent;
            cmd.Parameters.Add("@requeue", SqlDbType.Bit).Value = false;
            await cmd.ExecuteNonQueryAsync(inner).ConfigureAwait(false);
            return 0;
        }, token), ct);

    /// <summary>Back into the queue by hand (a failed or skipped message): attempts start again.</summary>
    public Task<int> RequeueAsync(long id, CancellationToken ct = default) =>
        db.QueryAsync("wa.requeue", async (conn, inner) =>
        {
            await using var cmd = NobleConnectionFactory.CreateCommand(conn, """
                UPDATE dbo.inf_wa_message SET status = 'queued', attempts = 0, error = NULL, updated_at = SYSUTCDATETIME()
                WHERE id = @id AND instance = @i AND status IN ('failed', 'skipped');
                """);
            cmd.Parameters.Add("@id", SqlDbType.BigInt).Value = id;
            cmd.Parameters.Add("@i", SqlDbType.VarChar, 12).Value = Instance;
            return await cmd.ExecuteNonQueryAsync(inner).ConfigureAwait(false);
        }, ct);

    /// <summary>A message stuck in 'sending' (the API restarted mid-send) goes back to the queue.</summary>
    public Task<int> RecoverStuckAsync(CancellationToken ct = default) =>
        db.QueryAsync("wa.recover", async (conn, inner) =>
        {
            await using var cmd = NobleConnectionFactory.CreateCommand(conn, """
                UPDATE dbo.inf_wa_message SET status = CASE WHEN attempts >= 3 THEN 'failed' ELSE 'queued' END,
                    error = CASE WHEN attempts >= 3 THEN N'Interrupted while sending.' ELSE error END, updated_at = SYSUTCDATETIME()
                WHERE instance = @i AND status = 'sending' AND updated_at < DATEADD(MINUTE, -10, SYSUTCDATETIME());
                """);
            cmd.Parameters.Add("@i", SqlDbType.VarChar, 12).Value = Instance;
            return await cmd.ExecuteNonQueryAsync(inner).ConfigureAwait(false);
        }, ct);

    /// <summary>A delivery tick: 2 delivered, 3+ read. Status only ever moves forward.</summary>
    public Task AckAsync(string waId, int ack, CancellationToken ct = default) =>
        retry.ExecuteAsync("wa.ack", token => db.QueryAsync("wa.ack", async (conn, inner) =>
        {
            var status = ack >= 3 ? "read" : ack == 2 ? "delivered" : null;
            if (status is null) return 0;
            await using var cmd = NobleConnectionFactory.CreateCommand(conn, """
                UPDATE dbo.inf_wa_message SET status = @s, updated_at = SYSUTCDATETIME()
                WHERE wa_id = @w AND (status = 'sent' OR (status = 'delivered' AND @s = 'read'));
                """);
            cmd.Parameters.Add("@w", SqlDbType.VarChar, 160).Value = waId;
            cmd.Parameters.Add("@s", SqlDbType.VarChar, 12).Value = status;
            return await cmd.ExecuteNonQueryAsync(inner).ConfigureAwait(false);
        }, token), ct);

    /// <summary>Messages sent by this instance since midnight, lab time.</summary>
    public Task<int> SentSinceAsync(DateTime sinceUtc, CancellationToken ct = default) =>
        retry.ExecuteAsync("wa.sentToday", token => db.QueryAsync("wa.sentToday", async (conn, inner) =>
        {
            await using var cmd = NobleConnectionFactory.CreateCommand(conn, """
                SELECT COUNT(*) FROM dbo.inf_wa_message WHERE instance = @i AND sent_at >= @since;
                """);
            cmd.Parameters.Add("@i", SqlDbType.VarChar, 12).Value = Instance;
            cmd.Parameters.Add("@since", SqlDbType.DateTime2).Value = sinceUtc;
            return Convert.ToInt32(await cmd.ExecuteScalarAsync(inner).ConfigureAwait(false));
        }, token), ct);

    public Task<IReadOnlyDictionary<string, int>> CountsAsync(DateTime sinceUtc, CancellationToken ct = default) =>
        retry.ExecuteAsync("wa.counts", token => db.QueryAsync("wa.counts", async (conn, inner) =>
        {
            await using var cmd = NobleConnectionFactory.CreateCommand(conn, """
                SELECT status, COUNT(*) n FROM dbo.inf_wa_message
                WHERE instance = @i AND (created_at >= @since OR status IN ('queued', 'sending'))
                GROUP BY status;
                """);
            cmd.Parameters.Add("@i", SqlDbType.VarChar, 12).Value = Instance;
            cmd.Parameters.Add("@since", SqlDbType.DateTime2).Value = sinceUtc;
            var m = new Dictionary<string, int>(StringComparer.Ordinal);
            await using var r = await cmd.ExecuteReaderAsync(inner).ConfigureAwait(false);
            while (await r.ReadAsync(inner).ConfigureAwait(false)) m[r.Str("status") ?? ""] = Convert.ToInt32(r["n"]);
            return (IReadOnlyDictionary<string, int>)m;
        }, token), ct);

    /// <summary>The log, newest first. Every row, paged — never a truncated list.</summary>
    public Task<(IReadOnlyList<WaMessage> Rows, int Total)> ListAsync(string? status, string? q, int page, int size,
                                                                     CancellationToken ct = default) =>
        retry.ExecuteAsync("wa.list", token => db.QueryAsync("wa.list", async (conn, inner) =>
        {
            const string where = """
                WHERE instance = @i AND (@s IS NULL OR status = @s)
                  AND (@q IS NULL OR phone LIKE @ql OR patient_name LIKE @ql OR client_code LIKE @ql
                       OR sids LIKE @ql OR CAST(pid AS VARCHAR(12)) = @q)
                """;
            await using var cmd = NobleConnectionFactory.CreateCommand(conn, $"""
                SELECT COUNT(*) FROM dbo.inf_wa_message {where};
                SELECT {Cols} FROM dbo.inf_wa_message {where}
                ORDER BY id DESC OFFSET @off ROWS FETCH NEXT @size ROWS ONLY;
                """);
            cmd.Parameters.Add("@i", SqlDbType.VarChar, 12).Value = Instance;
            cmd.Parameters.Add("@s", SqlDbType.VarChar, 12).Value = (object?)status ?? DBNull.Value;
            cmd.Parameters.Add("@q", SqlDbType.NVarChar, 60).Value = (object?)q ?? DBNull.Value;
            cmd.Parameters.Add("@ql", SqlDbType.NVarChar, 64).Value = q is null ? DBNull.Value : "%" + q + "%";
            cmd.Parameters.Add("@off", SqlDbType.Int).Value = Math.Max(0, page - 1) * size;
            cmd.Parameters.Add("@size", SqlDbType.Int).Value = size;
            await using var r = await cmd.ExecuteReaderAsync(inner).ConfigureAwait(false);
            await r.ReadAsync(inner).ConfigureAwait(false);
            var total = r.GetInt32(0);
            await r.NextResultAsync(inner).ConfigureAwait(false);
            var rows = new List<WaMessage>();
            while (await r.ReadAsync(inner).ConfigureAwait(false)) rows.Add(Read(r));
            return ((IReadOnlyList<WaMessage>)rows, total);
        }, token), ct);

    /// <summary>The newest message per visit, for the Reporting list's tick.</summary>
    public Task<IReadOnlyDictionary<int, WaMessage>> LatestForPidsAsync(IReadOnlyCollection<int> pids, CancellationToken ct = default)
    {
        if (pids.Count == 0) return Task.FromResult((IReadOnlyDictionary<int, WaMessage>)new Dictionary<int, WaMessage>());
        return retry.ExecuteAsync("wa.latest", token => db.QueryAsync("wa.latest", async (conn, inner) =>
        {
            var names = pids.Select((_, i) => "@p" + i.ToString(System.Globalization.CultureInfo.InvariantCulture)).ToArray();
            await using var cmd = NobleConnectionFactory.CreateCommand(conn, $"""
                SELECT {Cols} FROM (
                    SELECT *, ROW_NUMBER() OVER (PARTITION BY pid ORDER BY id DESC) rn
                    FROM dbo.inf_wa_message WHERE instance = @i AND kind = 'report' AND pid IN ({string.Join(",", names)})
                ) x WHERE rn = 1;
                """);
            cmd.Parameters.Add("@i", SqlDbType.VarChar, 12).Value = Instance;
            var k = 0;
            foreach (var p in pids) cmd.Parameters.Add(names[k++], SqlDbType.Int).Value = p;
            var m = new Dictionary<int, WaMessage>();
            await using var r = await cmd.ExecuteReaderAsync(inner).ConfigureAwait(false);
            while (await r.ReadAsync(inner).ConfigureAwait(false)) { var w = Read(r); if (w.Pid is int pid) m[pid] = w; }
            return (IReadOnlyDictionary<int, WaMessage>)m;
        }, token), ct);
    }

    /* ---- opt-outs ------------------------------------------------------- */

    public Task<bool> IsOptedOutAsync(string phone, CancellationToken ct = default) =>
        retry.ExecuteAsync("wa.optout.check", token => db.QueryAsync("wa.optout.check", async (conn, inner) =>
        {
            await using var cmd = NobleConnectionFactory.CreateCommand(conn, "SELECT COUNT(*) FROM dbo.inf_wa_optout WHERE phone = @p");
            cmd.Parameters.Add("@p", SqlDbType.VarChar, 15).Value = phone;
            return Convert.ToInt32(await cmd.ExecuteScalarAsync(inner).ConfigureAwait(false)) > 0;
        }, token), ct);

    public Task OptOutAsync(string phone, string source, CancellationToken ct = default) =>
        retry.ExecuteAsync("wa.optout", token => db.QueryAsync("wa.optout", async (conn, inner) =>
        {
            await using var cmd = NobleConnectionFactory.CreateCommand(conn, """
                IF NOT EXISTS (SELECT 1 FROM dbo.inf_wa_optout WHERE phone = @p)
                    INSERT INTO dbo.inf_wa_optout (phone, source) VALUES (@p, @s);
                """);
            cmd.Parameters.Add("@p", SqlDbType.VarChar, 15).Value = phone;
            cmd.Parameters.Add("@s", SqlDbType.VarChar, 12).Value = source;
            return await cmd.ExecuteNonQueryAsync(inner).ConfigureAwait(false);
        }, token), ct);

    public Task<int> OptInAsync(string phone, CancellationToken ct = default) =>
        db.QueryAsync("wa.optin", async (conn, inner) =>
        {
            await using var cmd = NobleConnectionFactory.CreateCommand(conn, "DELETE FROM dbo.inf_wa_optout WHERE phone = @p");
            cmd.Parameters.Add("@p", SqlDbType.VarChar, 15).Value = phone;
            return await cmd.ExecuteNonQueryAsync(inner).ConfigureAwait(false);
        }, ct);

    /* ---- clients on auto-send ------------------------------------------- */

    public Task<IReadOnlyList<string>> ClientsAsync(CancellationToken ct = default) =>
        retry.ExecuteAsync("wa.clients", token => db.QueryAsync("wa.clients", async (conn, inner) =>
        {
            await using var cmd = NobleConnectionFactory.CreateCommand(conn, "SELECT client_code FROM dbo.inf_wa_client ORDER BY client_code");
            var list = new List<string>();
            await using var r = await cmd.ExecuteReaderAsync(inner).ConfigureAwait(false);
            while (await r.ReadAsync(inner).ConfigureAwait(false)) list.Add(r.Str("client_code") ?? "");
            return (IReadOnlyList<string>)list;
        }, token), ct);

    /// <summary>Replace the auto-send list. Codes that are not LIS client codes come back, unwritten.</summary>
    public Task<IReadOnlyList<string>> SetClientsAsync(IReadOnlyCollection<string> codes, int actor, CancellationToken ct = default) =>
        db.QueryAsync("wa.clients.set", async (conn, inner) =>
        {
            await using var tx = (SqlTransaction)await conn.BeginTransactionAsync(inner).ConfigureAwait(false);
            var known = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            if (codes.Count > 0)
            {
                var names = codes.Select((_, i) => "@c" + i.ToString(System.Globalization.CultureInfo.InvariantCulture)).ToArray();
                await using var q = NobleConnectionFactory.CreateCommand(conn,
                    $"SELECT LTRIM(RTRIM(MCCUnitCode)) AS code FROM dbo.tbl_med_mcc_unit_master WHERE LTRIM(RTRIM(MCCUnitCode)) IN ({string.Join(",", names)})");
                q.Transaction = tx;
                var i = 0;
                foreach (var c in codes) q.Parameters.Add(names[i++], SqlDbType.NVarChar, 50).Value = c;
                await using (var r = await q.ExecuteReaderAsync(inner).ConfigureAwait(false))
                    while (await r.ReadAsync(inner).ConfigureAwait(false)) known.Add(r.Str("code") ?? "");
            }
            await using (var del = NobleConnectionFactory.CreateCommand(conn, "DELETE FROM dbo.inf_wa_client"))
            {
                del.Transaction = tx;
                await del.ExecuteNonQueryAsync(inner).ConfigureAwait(false);
            }
            foreach (var c in known)
            {
                await using var ins = NobleConnectionFactory.CreateCommand(conn,
                    "INSERT INTO dbo.inf_wa_client (client_code, updated_by) VALUES (@c, @by)");
                ins.Transaction = tx;
                ins.Parameters.Add("@c", SqlDbType.NVarChar, 50).Value = c;
                ins.Parameters.Add("@by", SqlDbType.Int).Value = actor;
                await ins.ExecuteNonQueryAsync(inner).ConfigureAwait(false);
            }
            await tx.CommitAsync(inner).ConfigureAwait(false);
            return (IReadOnlyList<string>)codes.Where(c => !known.Contains(c)).ToList();
        }, ct);

    /* ---- the patients ---------------------------------------------------- */

    // The visit's mobile: the patient record's, else the walk-in bill's (the
    // bill links to the visit by medid = MRNID). Normalised in C#, not here.
    private const string PhoneSql = """
        COALESCE(NULLIF(LTRIM(RTRIM(p.mobile_number)), ''),
                 (SELECT TOP (1) NULLIF(LTRIM(RTRIM(b.mobile_number)), '') FROM dbo.tbl_billing_patient_detail b
                  WHERE b.medid = p.MRNID ORDER BY b.id DESC))
        """;

    /// <summary>
    /// Visits released since <paramref name="sinceUtc"/> (lab clock in the LIS,
    /// see the caller) whose every sample is authorised or printed — none
    /// pending, none partial; rejected ones aside — for the listed clients (or
    /// all), not yet sent automatically by this instance.
    /// </summary>
    public Task<IReadOnlyList<WaCandidate>> CandidatesAsync(DateTime sinceLab, bool allClients, int max, CancellationToken ct = default) =>
        retry.ExecuteAsync("wa.candidates", token => db.QueryAsync("wa.candidates", async (conn, inner) =>
        {
            await using var cmd = NobleConnectionFactory.CreateCommand(conn, $"""
                SELECT TOP (@max) p.id AS pid, LTRIM(RTRIM(u.MCCUnitCode)) AS client_code,
                       LTRIM(RTRIM(ISNULL(p.initial, '') + ' ' + ISNULL(p.name, ''))) AS patient_name,
                       {PhoneSql} AS phone,
                       sids = (SELECT STRING_AGG(LTRIM(RTRIM(s3.vailid)), ',') FROM dbo.tbl_med_mcc_patient_samples s3
                               WHERE s3.patient_id = p.id AND s3.sample_status IN (7, 9))
                FROM dbo.tbl_med_mcc_patient_master p
                JOIN dbo.tbl_med_mcc_unit_master u ON u.id = p.mcc_code
                WHERE p.id IN (SELECT s.patient_id FROM dbo.tbl_med_mcc_patient_samples s
                               WHERE s.modifieddate >= @since AND s.sample_status IN (7, 9))
                  AND NOT EXISTS (SELECT 1 FROM dbo.tbl_med_mcc_patient_samples s2
                                  WHERE s2.patient_id = p.id AND s2.sample_status NOT IN (3, 7, 9))
                  AND (@all = 1 OR EXISTS (SELECT 1 FROM dbo.inf_wa_client c WHERE c.client_code = LTRIM(RTRIM(u.MCCUnitCode))))
                  AND NOT EXISTS (SELECT 1 FROM dbo.inf_wa_message m WHERE m.instance = @i AND m.pid = p.id AND m.[trigger] = 'auto')
                  AND {PhoneSql} IS NOT NULL
                ORDER BY p.id;
                """);
            cmd.CommandTimeout = 60;
            cmd.Parameters.Add("@max", SqlDbType.Int).Value = max;
            cmd.Parameters.Add("@since", SqlDbType.DateTime).Value = sinceLab;
            cmd.Parameters.Add("@all", SqlDbType.Bit).Value = allClients;
            cmd.Parameters.Add("@i", SqlDbType.VarChar, 12).Value = Instance;
            var list = new List<WaCandidate>();
            await using var r = await cmd.ExecuteReaderAsync(inner).ConfigureAwait(false);
            while (await r.ReadAsync(inner).ConfigureAwait(false))
            {
                var phone = Phone.Normalise(r.Str("phone"));
                var sids = (r.Str("sids") ?? "").Split(',', StringSplitOptions.RemoveEmptyEntries);
                if (phone is null || sids.Length == 0) continue;
                list.Add(new WaCandidate(Convert.ToInt32(r["pid"]), r.Str("client_code") ?? "", r.Str("patient_name"), phone, sids));
            }
            return (IReadOnlyList<WaCandidate>)list;
        }, token), ct);

    /// <summary>A visit's name, client, mobile and released samples, for a manual send.</summary>
    public Task<WaPatient?> PatientAsync(int pid, CancellationToken ct = default) =>
        retry.ExecuteAsync("wa.patient", token => db.QueryAsync("wa.patient", async (conn, inner) =>
        {
            await using var cmd = NobleConnectionFactory.CreateCommand(conn, $"""
                SELECT p.id AS pid, LTRIM(RTRIM(u.MCCUnitCode)) AS client_code,
                       LTRIM(RTRIM(ISNULL(p.initial, '') + ' ' + ISNULL(p.name, ''))) AS patient_name,
                       {PhoneSql} AS phone,
                       sids = (SELECT STRING_AGG(LTRIM(RTRIM(s.vailid)), ',') FROM dbo.tbl_med_mcc_patient_samples s
                               WHERE s.patient_id = p.id AND s.sample_status IN (6, 7, 8, 9))
                FROM dbo.tbl_med_mcc_patient_master p
                LEFT JOIN dbo.tbl_med_mcc_unit_master u ON u.id = p.mcc_code
                WHERE p.id = @pid;
                """);
            cmd.Parameters.Add("@pid", SqlDbType.Int).Value = pid;
            await using var r = await cmd.ExecuteReaderAsync(inner).ConfigureAwait(false);
            if (!await r.ReadAsync(inner).ConfigureAwait(false)) return null;
            return new WaPatient(pid, r.Str("client_code"), r.Str("patient_name"), Phone.Normalise(r.Str("phone")),
                (r.Str("sids") ?? "").Split(',', StringSplitOptions.RemoveEmptyEntries));
        }, token), ct);
}
