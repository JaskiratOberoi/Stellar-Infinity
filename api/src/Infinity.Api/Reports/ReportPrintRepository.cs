using System.Data;
using Infinity.Api.Audit;
using Infinity.Api.Data;

namespace Infinity.Api.Reports;

/// <summary>
/// Marks a sample Printed when its report is downloaded — the legacy LIS's
/// <c>ChangeSampleStatus</c> (6→8, 7→9, nothing else moves), ported as an
/// audited transition. See procedure 143 for the legacy behaviour verified
/// against its source and for what was changed on purpose.
/// </summary>
/// <remarks>
/// <para>
/// Called AFTER the PDF bytes exist — rendered or served from cache — never
/// before, so a failed render leaves the status alone. The legacy marks first
/// and exports second, which is how a sample gets to Printed with no report
/// ever leaving the building.
/// </para>
/// <para>
/// Best-effort by design: the bytes are already in hand when this runs, and a
/// download that succeeded must not be turned into a failure because the
/// status write did not. A failure is loud in the log (report.mark_printed
/// .failed) and the download itself is still on the audit trail as
/// report.pdf, so nothing is silently lost — only the status flip, which the
/// next download repeats.
/// </para>
/// </remarks>
public sealed class ReportPrintRepository(NobleConnectionFactory db, ILogger<ReportPrintRepository> logger)
{
    /// <summary>The transition that happened, if any. Before == After means the status was left as it was.</summary>
    public sealed record Mark(int Before, int After)
    {
        public bool Changed => Before != After;
    }

    /// <param name="channel">
    /// 'pdf' for the single-report route, 'bulk' for a merged or PID bundle —
    /// carried into the audit row's reason so the history reads as prose.
    /// </param>
    public async Task<Mark?> MarkPrintedAsync(string sid, AuditActor actor, string channel, CancellationToken ct = default)
    {
        if (actor.UserId is not int userId) return null;
        var target = (sid ?? string.Empty).Trim();
        if (target.Length == 0) return null;

        try
        {
            return await db.QueryAsync("report.markPrinted", async (conn, inner) =>
            {
                await using var cmd = db.CreateWriteCommand(conn, "dbo.usp_inf_report_mark_printed");
                cmd.Parameters.Add("@sid", SqlDbType.NVarChar, 50).Value = target;
                cmd.Parameters.Add("@actor_user_id", SqlDbType.Int).Value = userId;
                cmd.Parameters.Add("@actor_username", SqlDbType.NVarChar, 100).Value =
                    (object?)Truncate(actor.Username, 100) ?? DBNull.Value;
                cmd.Parameters.Add("@actor_ip", SqlDbType.NVarChar, 64).Value =
                    (object?)Truncate(actor.Ip, 64) ?? DBNull.Value;
                cmd.Parameters.Add("@actor_agent", SqlDbType.NVarChar, 400).Value =
                    (object?)Truncate(actor.UserAgent, 400) ?? DBNull.Value;
                cmd.Parameters.Add("@channel", SqlDbType.VarChar, 20).Value = channel;

                await using var reader = await cmd.ExecuteReaderAsync(CommandBehavior.SingleResult, inner)
                    .ConfigureAwait(false);
                if (!await reader.ReadAsync(inner).ConfigureAwait(false)) return null;
                if (reader.IsDBNull(0)) return null;

                var mark = new Mark(reader.GetInt32(0), reader.GetInt32(1));
                if (mark.Changed)
                {
                    logger.LogInformation("report.marked_printed sid={Sid} userId={UserId} {Before}->{After} via={Channel}",
                        target, userId, mark.Before, mark.After, channel);
                }
                return mark;
            }, ct).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "report.mark_printed.failed sid={Sid} userId={UserId} via={Channel}", target, userId, channel);
            return null;
        }
    }

    private static string? Truncate(string? s, int max) =>
        s is null ? null : s.Length <= max ? s : s[..max];
}
