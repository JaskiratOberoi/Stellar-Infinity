using System.Data;
using Infinity.Api.Audit;
using Infinity.Api.Data;
using Infinity.Api.Reads;
using Microsoft.Data.SqlClient;

namespace Infinity.Api.Worksheet;

/// <summary>
/// Reads and writes the auto-authorization rules.
///
/// The unlock password never reaches this class. It is verified by
/// <see cref="AutoAuthGate"/> at the endpoint, and only a verified request gets
/// here — so there is no path by which the secret can be logged from a
/// parameter dump or an exception message.
/// </summary>
public sealed class AutoAuthRepository(NobleConnectionFactory db, SqlRetry retry, ILogger<AutoAuthRepository> logger)
{
    public Task<IReadOnlyList<AutoAuthScopeRow>> ListAsync(
        string? search, bool onlyEnabled, int top, CancellationToken ct = default) =>
        retry.ExecuteAsync("autoauth.list", token =>
            db.QueryAsync("autoauth.list", async (conn, inner) =>
            {
                await using var cmd = db.CreateWriteCommand(conn, "dbo.usp_inf_auto_auth_list");
                cmd.Parameters.Add("@search", SqlDbType.NVarChar, 100).Value =
                    string.IsNullOrWhiteSpace(search) ? DBNull.Value : search.Trim();
                cmd.Parameters.Add("@only_enabled", SqlDbType.Bit).Value = onlyEnabled;
                cmd.Parameters.Add("@top", SqlDbType.Int).Value = Math.Clamp(top, 1, 1000);

                await using var reader = await cmd.ExecuteReaderAsync(CommandBehavior.SingleResult, inner)
                    .ConfigureAwait(false);

                var list = new List<AutoAuthScopeRow>();
                while (await reader.ReadAsync(inner).ConfigureAwait(false))
                {
                    list.Add(new AutoAuthScopeRow(
                        ScopeType: reader.Str("scope_type") ?? "",
                        ScopeKey: reader.Str("scope_key") ?? "",
                        Label: reader.Str("label"),
                        DepartmentName: reader.Str("department_name"),
                        Enabled: reader.Bit("enabled"),
                        RequireInRange: reader.Bit("require_in_range"),
                        AllowOutOfRange: reader.Bit("allow_out_of_range"),
                        NumericOnly: reader.Bit("numeric_only"),
                        UpdatedAt: reader.Offset("updated_at"),
                        UpdatedByUsername: reader.Str("updated_by_username")));
                }

                return (IReadOnlyList<AutoAuthScopeRow>)list;
            }, token), ct);

    /// <summary>
    /// Apply one rule change. Not retried — it is a non-idempotent write that
    /// appends an audit row, and a replay would overstate what happened.
    /// </summary>
    public async Task SetAsync(SetAutoAuthRequest request, AuditActor actor, CancellationToken ct = default)
    {
        if (actor.UserId is not int userId)
        {
            throw new WorksheetRefusedException("The acting user could not be identified.", isPermission: true);
        }

        await db.QueryAsync("autoauth.set", async (conn, inner) =>
        {
            await using var cmd = db.CreateWriteCommand(conn, "dbo.usp_inf_auto_auth_set");
            cmd.Parameters.Add("@scope_type", SqlDbType.VarChar, 12).Value = request.ScopeType;
            cmd.Parameters.Add("@scope_key", SqlDbType.NVarChar, 50).Value = request.ScopeKey;
            cmd.Parameters.Add("@scope_label", SqlDbType.NVarChar, 200).Value =
                (object?)request.ScopeLabel ?? DBNull.Value;
            cmd.Parameters.Add("@enabled", SqlDbType.Bit).Value = request.Enabled;
            cmd.Parameters.Add("@require_in_range", SqlDbType.Bit).Value = request.RequireInRange;
            cmd.Parameters.Add("@allow_out_of_range", SqlDbType.Bit).Value = request.AllowOutOfRange;
            cmd.Parameters.Add("@actor_user_id", SqlDbType.Int).Value = userId;
            cmd.Parameters.Add("@actor_ip", SqlDbType.VarChar, 64).Value = (object?)actor.Ip ?? DBNull.Value;

            try
            {
                await cmd.ExecuteNonQueryAsync(inner).ConfigureAwait(false);
            }
            catch (SqlException ex) when (ex.Class == 16)
            {
                throw new WorksheetRefusedException(
                    ex.Errors.Count > 0 ? ex.Errors[0].Message : ex.Message, isPermission: false);
            }

            // Logged at Warning even on success. Switching a test to automatic
            // release is rare, consequential, and worth finding in the
            // application log without querying the database.
            logger.LogWarning(
                "autoauth.set scope={ScopeType}:{ScopeKey} enabled={Enabled} userId={UserId}",
                request.ScopeType, request.ScopeKey, request.Enabled, userId);

            return 0;
        }, ct).ConfigureAwait(false);
    }

    /// <summary>
    /// Record a rejected unlock attempt. Best-effort: a logging failure must not
    /// turn a wrong password into a 500, which would tell the caller something
    /// about the system they did not otherwise know.
    /// </summary>
    public async Task RecordFailedUnlockAsync(
        string? scopeType, string? scopeKey, AuditActor actor, CancellationToken ct = default)
    {
        if (actor.UserId is not int userId) return;

        try
        {
            await db.QueryAsync("autoauth.unlockFailed", async (conn, inner) =>
            {
                await using var cmd = db.CreateWriteCommand(conn, "dbo.usp_inf_auto_auth_unlock_failed");
                cmd.Parameters.Add("@scope_type", SqlDbType.VarChar, 12).Value = (object?)scopeType ?? DBNull.Value;
                cmd.Parameters.Add("@scope_key", SqlDbType.NVarChar, 50).Value = (object?)scopeKey ?? DBNull.Value;
                cmd.Parameters.Add("@actor_user_id", SqlDbType.Int).Value = userId;
                cmd.Parameters.Add("@actor_ip", SqlDbType.VarChar, 64).Value = (object?)actor.Ip ?? DBNull.Value;
                await cmd.ExecuteNonQueryAsync(inner).ConfigureAwait(false);
                return 0;
            }, ct).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "autoauth.unlockFailed.notRecorded userId={UserId}", userId);
        }

        logger.LogWarning(
            "autoauth.unlock.rejected userId={UserId} ip={Ip} scope={ScopeType}:{ScopeKey}",
            userId, actor.Ip, scopeType, scopeKey);
    }

    public Task<IReadOnlyList<AutoAuthAuditRow>> GetAuditAsync(int top, CancellationToken ct = default) =>
        retry.ExecuteAsync("autoauth.audit", token =>
            db.QueryAsync("autoauth.audit", async (conn, inner) =>
            {
                await using var cmd = db.CreateWriteCommand(conn, "dbo.usp_inf_auto_auth_audit_read");
                cmd.Parameters.Add("@top", SqlDbType.Int).Value = Math.Clamp(top, 1, 500);

                await using var reader = await cmd.ExecuteReaderAsync(CommandBehavior.SingleResult, inner)
                    .ConfigureAwait(false);

                var list = new List<AutoAuthAuditRow>();
                while (await reader.ReadAsync(inner).ConfigureAwait(false))
                {
                    list.Add(new AutoAuthAuditRow(
                        Id: reader.Long("id"),
                        Action: reader.Str("action") ?? "",
                        ScopeType: reader.Str("scope_type"),
                        ScopeKey: reader.Str("scope_key"),
                        ScopeLabel: reader.Str("scope_label"),
                        OldEnabled: reader.NullableBit("old_enabled"),
                        NewEnabled: reader.NullableBit("new_enabled"),
                        Detail: reader.Str("detail"),
                        ActorUsername: reader.Str("actor_username"),
                        ActorIp: reader.Str("actor_ip"),
                        OccurredAt: reader.Offset("occurred_at") ?? default));
                }

                return (IReadOnlyList<AutoAuthAuditRow>)list;
            }, token), ct);
}

internal static class AutoAuthReaderExtensions
{
    public static bool? NullableBit(this SqlDataReader r, string column)
    {
        var i = r.GetOrdinal(column);
        return r.IsDBNull(i) ? null : Convert.ToBoolean(r.GetValue(i));
    }
}
