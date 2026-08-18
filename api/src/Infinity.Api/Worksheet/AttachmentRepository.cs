using System.Data;
using Infinity.Api.Audit;
using Infinity.Api.Data;
using Infinity.Api.Reads;
using Microsoft.Data.SqlClient;

namespace Infinity.Api.Worksheet;

public sealed record AttachmentRow(
    int Id,
    int? ResultId,
    string? TestName,
    string? TestCode,
    string? FileType,
    long SizeBytes,
    string? UploadedBy,
    DateTimeOffset? UploadedAt);

/// <summary>The bytes plus the sample they belong to, so the caller can scope-check.</summary>
public sealed record AttachmentContent(int Id, string? Vailid, string? FileType, byte[] Content);

/// <summary>
/// Worksheet attachments, stored in the LIS's own
/// tbl_med_mcc_patient_test_result_attachment so the legacy screens and Crystal
/// reports keep seeing them.
///
/// Attachments are SAMPLE-scoped. The legacy per-test gate (Has_graph) covers
/// only 357 of 1,457 active tests, which is why most samples had no way to
/// attach anything — and the stored data shows the gate was wrong in principle
/// too: 6,724 attachments across 6,710 vials is one document per sample, not
/// per analyte.
/// </summary>
public sealed class AttachmentRepository(
    NobleConnectionFactory db, SqlRetry retry, ILogger<AttachmentRepository> logger)
{
    /// <summary>
    /// Hard ceiling on one upload. Generous for a scanned trace or an analyser
    /// PDF, small enough that a mistaken 500 MB file is refused before it is
    /// buffered into memory and written to a shared production database.
    /// </summary>
    public const int MaxBytes = 10 * 1024 * 1024;

    /// <summary>
    /// What may be attached, by extension AND by leading bytes.
    ///
    /// Extension alone is what the legacy upload checks, and an extension is
    /// just a claim the uploader makes. The signature check below is what makes
    /// "this is a PDF" a fact rather than a filename.
    /// </summary>
    private static readonly Dictionary<string, byte[][]> AllowedSignatures = new(StringComparer.OrdinalIgnoreCase)
    {
        [".pdf"] = [[0x25, 0x50, 0x44, 0x46]],                      // %PDF
        [".png"] = [[0x89, 0x50, 0x4E, 0x47]],                      // \x89PNG
        [".jpg"] = [[0xFF, 0xD8, 0xFF]],
        [".jpeg"] = [[0xFF, 0xD8, 0xFF]],
    };

    public static bool IsAllowed(string extension, ReadOnlySpan<byte> content, out string? problem)
    {
        problem = null;

        if (!AllowedSignatures.TryGetValue(extension, out var signatures))
        {
            problem = "Only PDF, PNG and JPEG files can be attached.";
            return false;
        }

        foreach (var sig in signatures)
        {
            if (content.Length >= sig.Length && content[..sig.Length].SequenceEqual(sig)) return true;
        }

        // The extension said one thing and the bytes said another. Refusing is
        // the only safe reading: a file renamed to .pdf is the oldest trick for
        // getting something else past an upload filter.
        problem = $"That file does not look like a {extension.TrimStart('.').ToUpperInvariant()}.";
        return false;
    }

    public Task<IReadOnlyList<AttachmentRow>> ListAsync(string sid, CancellationToken ct = default) =>
        retry.ExecuteAsync("attachment.list", token =>
            db.QueryAsync("attachment.list", async (conn, inner) =>
            {
                await using var cmd = db.CreateWriteCommand(conn, "dbo.usp_inf_attachment_list");
                cmd.Parameters.Add("@sid", SqlDbType.NVarChar, 50).Value = sid.Trim();

                await using var reader = await cmd.ExecuteReaderAsync(CommandBehavior.SingleResult, inner)
                    .ConfigureAwait(false);

                var list = new List<AttachmentRow>();
                while (await reader.ReadAsync(inner).ConfigureAwait(false))
                {
                    list.Add(new AttachmentRow(
                        Id: reader.Int("id"),
                        ResultId: reader.NullableInt("result_id"),
                        TestName: reader.Str("test_name"),
                        TestCode: reader.Str("test_code"),
                        FileType: reader.Str("file_type"),
                        SizeBytes: reader.Long("size_bytes"),
                        UploadedBy: reader.Str("uploaded_by"),
                        UploadedAt: reader.Offset("uploaded_at")));
                }
                return (IReadOnlyList<AttachmentRow>)list;
            }, token), ct);

    public Task<AttachmentContent?> GetAsync(int id, CancellationToken ct = default) =>
        retry.ExecuteAsync("attachment.get", token =>
            db.QueryAsync("attachment.get", async (conn, inner) =>
            {
                await using var cmd = db.CreateWriteCommand(conn, "dbo.usp_inf_attachment_get");
                cmd.Parameters.Add("@id", SqlDbType.Int).Value = id;

                await using var reader = await cmd.ExecuteReaderAsync(
                    CommandBehavior.SingleResult | CommandBehavior.SequentialAccess, inner).ConfigureAwait(false);

                if (!await reader.ReadAsync(inner).ConfigureAwait(false)) return null;

                var rid = reader.Int("id");
                var vail = reader.Str("vail_id");
                var type = reader.Str("file_type");
                var ordinal = reader.GetOrdinal("attachment");
                var bytes = await reader.IsDBNullAsync(ordinal, inner).ConfigureAwait(false)
                    ? []
                    : (byte[])reader.GetValue(ordinal);

                return new AttachmentContent(rid, vail, type, bytes);
            }, token), ct);

    /// <summary>
    /// Not retried: a non-idempotent write. A replay after an ambiguous timeout
    /// would store the same document twice.
    /// </summary>
    public async Task<int> AddAsync(
        string sid, int? resultId, string fileType, byte[] content,
        string? fileName, AuditActor actor, CancellationToken ct = default)
    {
        if (actor.UserId is not int userId)
        {
            throw new WorksheetRefusedException("The acting user could not be identified.", isPermission: true);
        }

        return await db.QueryAsync("attachment.add", async (conn, inner) =>
        {
            await using var cmd = db.CreateWriteCommand(conn, "dbo.usp_inf_attachment_add");
            cmd.Parameters.Add("@sid", SqlDbType.NVarChar, 50).Value = sid.Trim();
            cmd.Parameters.Add("@result_id", SqlDbType.Int).Value = (object?)resultId ?? DBNull.Value;
            cmd.Parameters.Add("@file_type", SqlDbType.VarChar, 50).Value = fileType;
            cmd.Parameters.Add("@content", SqlDbType.VarBinary, -1).Value = content;
            cmd.Parameters.Add("@actor_user_id", SqlDbType.Int).Value = userId;
            cmd.Parameters.Add("@actor_ip", SqlDbType.VarChar, 64).Value = (object?)actor.Ip ?? DBNull.Value;
            cmd.Parameters.Add("@file_name", SqlDbType.NVarChar, 200).Value = (object?)fileName ?? DBNull.Value;

            try
            {
                var result = await cmd.ExecuteScalarAsync(inner).ConfigureAwait(false);
                var id = Convert.ToInt32(result);
                logger.LogInformation("attachment.added sid={Sid} id={Id} bytes={Bytes} userId={UserId}",
                    sid, id, content.Length, userId);
                return id;
            }
            catch (SqlException ex) when (ex.Class == 16)
            {
                throw new WorksheetRefusedException(
                    ex.Errors.Count > 0 ? ex.Errors[0].Message : ex.Message, isPermission: false);
            }
        }, ct).ConfigureAwait(false);
    }

    public async Task DeleteAsync(int id, string sid, AuditActor actor, CancellationToken ct = default)
    {
        if (actor.UserId is not int userId)
        {
            throw new WorksheetRefusedException("The acting user could not be identified.", isPermission: true);
        }

        await db.QueryAsync("attachment.delete", async (conn, inner) =>
        {
            await using var cmd = db.CreateWriteCommand(conn, "dbo.usp_inf_attachment_delete");
            cmd.Parameters.Add("@id", SqlDbType.Int).Value = id;
            cmd.Parameters.Add("@sid", SqlDbType.NVarChar, 50).Value = sid.Trim();
            cmd.Parameters.Add("@actor_user_id", SqlDbType.Int).Value = userId;
            cmd.Parameters.Add("@actor_ip", SqlDbType.VarChar, 64).Value = (object?)actor.Ip ?? DBNull.Value;

            try
            {
                await cmd.ExecuteNonQueryAsync(inner).ConfigureAwait(false);
                logger.LogWarning("attachment.deleted sid={Sid} id={Id} userId={UserId}", sid, id, userId);
            }
            catch (SqlException ex) when (ex.Class == 16)
            {
                throw new WorksheetRefusedException(
                    ex.Errors.Count > 0 ? ex.Errors[0].Message : ex.Message, isPermission: false);
            }
            return 0;
        }, ct).ConfigureAwait(false);
    }
}
