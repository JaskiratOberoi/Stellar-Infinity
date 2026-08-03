using System.Data;
using Infinity.Api.Data;
using Infinity.Api.Domain;
using Microsoft.Data.SqlClient;

namespace Infinity.Api.Audit;

/// <summary>
/// Writes the two append-only audit trails.
///
/// The two halves behave DIFFERENTLY on failure, deliberately:
///
///  • Result audit is <b>transactional</b>. <see cref="WriteResultAuditAsync"/>
///    takes the caller's transaction and throws on failure, so a value change
///    whose audit row cannot be written is rolled back with it. An unaudited
///    change to a clinical result is worse than a failed save.
///
///  • Auth audit is <b>best-effort</b>. <see cref="WriteAuthEventAsync"/>
///    swallows and logs. Failing a clinician's login because the audit insert
///    timed out would turn a logging fault into an outage.
///
/// Neither is retried. These are non-idempotent inserts; a retry after an
/// ambiguous timeout would duplicate the record and make the trail lie about
/// how many times something happened.
/// </summary>
public sealed class AuditRepository(NobleConnectionFactory db, ILogger<AuditRepository> logger)
{
    private const string InsertResult = """
        INSERT INTO dbo.inf_result_audit
            (result_id, vailid, patient_id, test_code, action, field,
             old_value, new_value, reason,
             actor_user_id, actor_username, actor_ip, actor_user_agent,
             source, instrument_id, origin)
        VALUES
            (@result_id, @vailid, @patient_id, @test_code, @action, @field,
             @old_value, @new_value, @reason,
             @actor_user_id, @actor_username, @actor_ip, @actor_user_agent,
             @source, @instrument_id, @origin);
        """;

    /// <summary>
    /// Append result-audit rows inside an EXISTING transaction. Throws on
    /// failure so the caller's transaction rolls back with it.
    /// </summary>
    public async Task WriteResultAuditAsync(
        SqlConnection conn,
        SqlTransaction tx,
        IReadOnlyCollection<ResultAuditEntry> entries,
        AuditActor actor,
        CancellationToken ct = default)
    {
        if (entries.Count == 0) return;

        foreach (var e in entries)
        {
            // Checked here as well as by the DB constraint so the caller gets a
            // named error rather than an opaque constraint violation.
            if (ResultAction.RequiresReason(e.Action) && string.IsNullOrWhiteSpace(e.Reason))
            {
                throw new InvalidOperationException(
                    $"A reason is required to {e.Action} a result (test {e.TestCode ?? "?"} on {e.Vailid ?? "?"}).");
            }

            await using var cmd = new SqlCommand(InsertResult, conn, tx);
            cmd.Parameters.Add("@result_id", SqlDbType.Int).Value = (object?)e.ResultId ?? DBNull.Value;
            cmd.Parameters.Add("@vailid", SqlDbType.NVarChar, 50).Value = (object?)e.Vailid ?? DBNull.Value;
            cmd.Parameters.Add("@patient_id", SqlDbType.Int).Value = (object?)e.PatientId ?? DBNull.Value;
            cmd.Parameters.Add("@test_code", SqlDbType.NVarChar, 50).Value = (object?)e.TestCode ?? DBNull.Value;
            cmd.Parameters.Add("@action", SqlDbType.VarChar, 20).Value = e.Action;
            cmd.Parameters.Add("@field", SqlDbType.VarChar, 20).Value = e.Field;
            cmd.Parameters.Add("@old_value", SqlDbType.NVarChar, -1).Value = (object?)e.OldValue ?? DBNull.Value;
            cmd.Parameters.Add("@new_value", SqlDbType.NVarChar, -1).Value = (object?)e.NewValue ?? DBNull.Value;
            cmd.Parameters.Add("@reason", SqlDbType.NVarChar, 500).Value = (object?)e.Reason ?? DBNull.Value;
            cmd.Parameters.Add("@actor_user_id", SqlDbType.Int).Value = (object?)actor.UserId ?? DBNull.Value;
            cmd.Parameters.Add("@actor_username", SqlDbType.NVarChar, 100).Value = (object?)actor.Username ?? DBNull.Value;
            cmd.Parameters.Add("@actor_ip", SqlDbType.NVarChar, 64).Value = (object?)actor.Ip ?? DBNull.Value;
            cmd.Parameters.Add("@actor_user_agent", SqlDbType.NVarChar, 400).Value = Truncate(actor.UserAgent, 400);
            cmd.Parameters.Add("@source", SqlDbType.VarChar, 20).Value = e.Source;
            cmd.Parameters.Add("@instrument_id", SqlDbType.NVarChar, 50).Value = (object?)e.InstrumentId ?? DBNull.Value;
            cmd.Parameters.Add("@origin", SqlDbType.NVarChar, 50).Value =
                actor.UserId is int uid ? Origin.For(uid) : DBNull.Value;

            await cmd.ExecuteNonQueryAsync(ct).ConfigureAwait(false);
        }
    }

    /// <summary>
    /// Record an authentication or account event. Never throws — a logging
    /// fault must not become a login failure.
    /// </summary>
    public async Task WriteAuthEventAsync(AuthAuditEntry entry, AuditActor actor, CancellationToken ct = default)
    {
        try
        {
            await using var conn = await db.OpenAsync(ct).ConfigureAwait(false);
            await using var cmd = NobleConnectionFactory.CreateCommand(conn, """
                INSERT INTO dbo.inf_auth_audit
                    (event, actor_user_id, actor_username, target_user_id, target_username,
                     succeeded, detail, actor_ip, actor_user_agent, origin)
                VALUES
                    (@event, @actor_user_id, @actor_username, @target_user_id, @target_username,
                     @succeeded, @detail, @actor_ip, @actor_user_agent, @origin);
                """);
            cmd.CommandTimeout = 10;

            cmd.Parameters.Add("@event", SqlDbType.VarChar, 30).Value = entry.Event;
            cmd.Parameters.Add("@actor_user_id", SqlDbType.Int).Value = (object?)entry.ActorUserId ?? DBNull.Value;
            cmd.Parameters.Add("@actor_username", SqlDbType.NVarChar, 100).Value =
                (object?)(entry.ActorUsername ?? actor.Username) ?? DBNull.Value;
            cmd.Parameters.Add("@target_user_id", SqlDbType.Int).Value = (object?)entry.TargetUserId ?? DBNull.Value;
            cmd.Parameters.Add("@target_username", SqlDbType.NVarChar, 100).Value = (object?)entry.TargetUsername ?? DBNull.Value;
            cmd.Parameters.Add("@succeeded", SqlDbType.Bit).Value = entry.Succeeded;
            cmd.Parameters.Add("@detail", SqlDbType.NVarChar, 500).Value = Truncate(entry.Detail, 500);
            cmd.Parameters.Add("@actor_ip", SqlDbType.NVarChar, 64).Value = (object?)actor.Ip ?? DBNull.Value;
            cmd.Parameters.Add("@actor_user_agent", SqlDbType.NVarChar, 400).Value = Truncate(actor.UserAgent, 400);
            cmd.Parameters.Add("@origin", SqlDbType.NVarChar, 50).Value =
                (entry.ActorUserId ?? actor.UserId) is int uid ? Origin.For(uid) : DBNull.Value;

            await cmd.ExecuteNonQueryAsync(ct).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            // Loud in the log, invisible to the user.
            logger.LogError(ex, "audit.auth.failed event={Event} user={Username}",
                entry.Event, entry.ActorUsername ?? actor.Username);
        }
    }

    /// <summary>Recent result history for a sample, newest first.</summary>
    public Task<IReadOnlyList<ResultAuditRow>> GetSampleHistoryAsync(
        string vailid, int limit, CancellationToken ct = default) =>
        db.QueryAsync("audit.sampleHistory", async (conn, inner) =>
        {
            await using var cmd = NobleConnectionFactory.CreateCommand(conn, """
                SELECT TOP (@lim)
                    a.id, a.result_id, a.test_code, a.action, a.field,
                    a.old_value, a.new_value, a.reason,
                    a.actor_username, a.source, a.occurred_at
                FROM dbo.inf_result_audit a
                WHERE a.vailid = @sid
                ORDER BY a.occurred_at DESC, a.id DESC
                """);
            cmd.Parameters.Add("@sid", SqlDbType.NVarChar, 50).Value = vailid;
            cmd.Parameters.Add("@lim", SqlDbType.Int).Value = Math.Clamp(limit, 1, 500);

            await using var r = await cmd.ExecuteReaderAsync(CommandBehavior.SingleResult, inner).ConfigureAwait(false);
            var rows = new List<ResultAuditRow>();
            while (await r.ReadAsync(inner).ConfigureAwait(false))
            {
                rows.Add(new ResultAuditRow(
                    r.GetInt64(0),
                    r.IsDBNull(1) ? null : r.GetInt32(1),
                    r.IsDBNull(2) ? null : r.GetString(2),
                    r.GetString(3),
                    r.GetString(4),
                    r.IsDBNull(5) ? null : r.GetString(5),
                    r.IsDBNull(6) ? null : r.GetString(6),
                    r.IsDBNull(7) ? null : r.GetString(7),
                    r.IsDBNull(8) ? null : r.GetString(8),
                    r.GetString(9),
                    r.GetDateTimeOffset(10)));
            }
            return (IReadOnlyList<ResultAuditRow>)rows;
        }, ct);

    private static object Truncate(string? s, int max) =>
        string.IsNullOrEmpty(s) ? DBNull.Value : s.Length <= max ? s : s[..max];
}

public sealed record ResultAuditRow(
    long Id,
    int? ResultId,
    string? TestCode,
    string Action,
    string Field,
    string? OldValue,
    string? NewValue,
    string? Reason,
    string? ActorUsername,
    string Source,
    DateTimeOffset OccurredAt);
