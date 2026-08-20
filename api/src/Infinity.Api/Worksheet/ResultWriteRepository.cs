using System.Data;
using Infinity.Api.Audit;
using Infinity.Api.Data;
using Infinity.Api.Reads;
using Microsoft.Data.SqlClient;

namespace Infinity.Api.Worksheet;

/// <summary>
/// A refusal that carries a message safe to show the operator. The procedures
/// raise these deliberately (severity 16) for the cases a technologist can act
/// on: no permission, a missing reason, a sample that needs reopening.
/// </summary>
public sealed class WorksheetRefusedException(string message, bool isPermission)
    : Exception(message)
{
    /// <summary>403 when the refusal is about rights, 400 when it is about the request.</summary>
    public bool IsPermission { get; } = isPermission;
}

/// <summary>
/// Writes for the worksheet.
///
/// NOTHING HERE IS RETRIED. <see cref="SqlRetry"/> is safe for reads and for
/// writes that fail atomically before commit, but a batch save that times out
/// ambiguously may already have committed — replaying it would write a second
/// set of audit rows describing changes that happened once. An operator seeing
/// an error and pressing Save again is a decision; a silent retry is not.
///
/// Every write goes through a stored procedure that does its own auditing in
/// the SAME transaction as the data change. That placement is deliberate: an
/// audit written from application code after the update can be lost to a crash
/// between the two, leaving a changed clinical result with no record of the
/// change — precisely the gap this whole layer exists to close.
/// </summary>
public sealed class ResultWriteRepository(NobleConnectionFactory db, ILogger<ResultWriteRepository> logger)
{
    /// <summary>Noble's nvarchar(500) free-text columns.</summary>
    private const int SampleTextMax = 500;

    public async Task<SaveResultsOutcome> SaveAsync(
        string sid,
        SaveResultsRequest request,
        AuditActor actor,
        bool canEnter,
        bool canAmend,
        bool canAuthorize,
        CancellationToken ct = default)
    {
        if (actor.UserId is not int userId)
        {
            throw new WorksheetRefusedException("The acting user could not be identified.", isPermission: true);
        }

        return await db.QueryAsync("worksheet.save", async (conn, inner) =>
        {
            await using var cmd = db.CreateWriteCommand(conn, "dbo.usp_inf_result_save");
            cmd.Parameters.Add("@sid", SqlDbType.NVarChar, 50).Value = sid.Trim();
            cmd.Parameters.Add("@edits", SqlDbType.Structured).Value = BuildEditTable(request.Edits);
            cmd.Parameters["@edits"].TypeName = "dbo.InfResultEdit";

            cmd.Parameters.Add("@actor_user_id", SqlDbType.Int).Value = userId;
            cmd.Parameters.Add("@actor_ip", SqlDbType.VarChar, 64).Value = (object?)actor.Ip ?? DBNull.Value;
            cmd.Parameters.Add("@actor_agent", SqlDbType.NVarChar, 256).Value = Truncate(actor.UserAgent, 256);

            cmd.Parameters.Add("@can_enter", SqlDbType.Bit).Value = canEnter;
            cmd.Parameters.Add("@can_amend", SqlDbType.Bit).Value = canAmend;
            cmd.Parameters.Add("@can_authorize", SqlDbType.Bit).Value = canAuthorize;

            // TextOrClear, not Truncate: for these two an empty string is the
            // operator CLEARING the box, and clearing the comment is how a
            // held (Pending) sample is released — folding '' into NULL here
            // would make every hold permanent.
            cmd.Parameters.Add("@sample_comments", SqlDbType.VarChar, SampleTextMax).Value =
                TextOrClear(request.SampleComments, SampleTextMax);
            cmd.Parameters.Add("@sample_clinical_history", SqlDbType.VarChar, SampleTextMax).Value =
                TextOrClear(request.SampleClinicalHistory, SampleTextMax);

            try
            {
                await using var reader = await cmd.ExecuteReaderAsync(CommandBehavior.SingleResult, inner)
                    .ConfigureAwait(false);

                if (!await reader.ReadAsync(inner).ConfigureAwait(false))
                {
                    return new SaveResultsOutcome(0, 0, null, null);
                }

                return new SaveResultsOutcome(
                    Applied: reader.Int("applied"),
                    AutoAuthorized: reader.Int("auto_authorized"),
                    StatusBefore: reader.NullableInt("status_before"),
                    StatusAfter: reader.NullableInt("status_after"));
            }
            catch (SqlException ex) when (IsOperatorError(ex))
            {
                throw Refusal(ex);
            }
        }, ct).ConfigureAwait(false);
    }

    public async Task<(int Before, int After)> ReopenAsync(
        string sid, string reason, AuditActor actor, CancellationToken ct = default)
    {
        if (actor.UserId is not int userId)
        {
            throw new WorksheetRefusedException("The acting user could not be identified.", isPermission: true);
        }

        return await db.QueryAsync("worksheet.reopen", async (conn, inner) =>
        {
            await using var cmd = db.CreateWriteCommand(conn, "dbo.usp_inf_result_reopen");
            cmd.Parameters.Add("@sid", SqlDbType.NVarChar, 50).Value = sid.Trim();
            cmd.Parameters.Add("@reason", SqlDbType.NVarChar, 500).Value = Truncate(reason, 500);
            cmd.Parameters.Add("@actor_user_id", SqlDbType.Int).Value = userId;
            cmd.Parameters.Add("@actor_ip", SqlDbType.VarChar, 64).Value = (object?)actor.Ip ?? DBNull.Value;
            cmd.Parameters.Add("@actor_agent", SqlDbType.NVarChar, 256).Value = Truncate(actor.UserAgent, 256);

            try
            {
                await using var reader = await cmd.ExecuteReaderAsync(CommandBehavior.SingleResult, inner)
                    .ConfigureAwait(false);

                if (!await reader.ReadAsync(inner).ConfigureAwait(false)) return (0, 0);

                logger.LogWarning(
                    "worksheet.reopen sid={Sid} userId={UserId} — an authorised sample was unlocked",
                    sid, userId);

                return (reader.Int("status_before"), reader.Int("status_after"));
            }
            catch (SqlException ex) when (IsOperatorError(ex))
            {
                throw Refusal(ex);
            }
        }, ct).ConfigureAwait(false);
    }

    /// <summary>
    /// The TVP. Null and empty string are kept distinct all the way down — see
    /// <see cref="ResultEdit"/>. AddWithValue on a null string would send NULL
    /// for both, so empty strings are passed explicitly.
    /// </summary>
    private static DataTable BuildEditTable(IReadOnlyList<ResultEdit> edits)
    {
        var t = new DataTable();
        t.Columns.Add("result_id", typeof(int));
        t.Columns.Add("value", typeof(string));
        t.Columns.Add("comments", typeof(string));
        t.Columns.Add("set_auth", typeof(bool));
        t.Columns.Add("reason", typeof(string));

        // The table type has a primary key on result_id, so a duplicated row id
        // would fail inside SQL Server with an opaque message. De-duplicate
        // here, keeping the last edit for each row.
        foreach (var e in edits.GroupBy(e => e.ResultId).Select(g => g.Last()))
        {
            t.Rows.Add(
                e.ResultId,
                (object?)e.Value ?? DBNull.Value,
                (object?)e.Comments ?? DBNull.Value,
                (object?)e.SetAuth ?? DBNull.Value,
                (object?)Trim(e.Reason, 500) ?? DBNull.Value);
        }

        return t;
    }

    /// <summary>
    /// Severity 16 is what the procedures use for conditions the caller can fix.
    /// Anything else — a deadlock, a timeout, a constraint violation — is a real
    /// fault and must surface as a 500 with the detail in the log, not as a
    /// tidy message implying the operator did something wrong.
    /// </summary>
    private static bool IsOperatorError(SqlException ex) => ex.Class == 16;

    private static WorksheetRefusedException Refusal(SqlException ex)
    {
        var message = ex.Errors.Count > 0 ? ex.Errors[0].Message : ex.Message;
        var isPermission = message.Contains("permission", StringComparison.OrdinalIgnoreCase);
        return new WorksheetRefusedException(message, isPermission);
    }

    private static object Truncate(string? s, int max) =>
        string.IsNullOrWhiteSpace(s) ? DBNull.Value : s.Length <= max ? s : s[..max];

    /// <summary>
    /// NULL means "not touched this save"; anything else is the new content,
    /// where whitespace-only is a deliberate clear and becomes ''. The SP's
    /// COALESCE keeps the old value only for DBNull.
    /// </summary>
    private static object TextOrClear(string? s, int max) =>
        s is null ? DBNull.Value
        : string.IsNullOrWhiteSpace(s) ? string.Empty
        : s.Length <= max ? s : s[..max];

    private static string? Trim(string? s, int max) =>
        string.IsNullOrWhiteSpace(s) ? null : s.Length <= max ? s : s[..max];
}
