using System.Data;
using Infinity.Api.Data;
using Microsoft.Data.SqlClient;

namespace Infinity.Api.Reports;

/// <summary>
/// LIS graph attachments — read only.
/// </summary>
/// <remarks>
/// <para>
/// Some tests (Double/Quadruple Marker, allergy panels, cytogenetics) carry a
/// graph PDF uploaded against the result in the legacy LIS, and the LIS staples
/// it to the printed report. Infinity has to staple the same file or its PDF is
/// a different document from the one the lab has always issued.
/// </para>
/// <para>
/// Source: <c>dbo.tbl_med_mcc_patient_test_result_attachment</c>, keyed by
/// <c>vail_id</c> (the SID). Almost every SID has one attachment; a handful
/// have two, which is why this returns a list and the caller staples all of
/// them in id order.
/// </para>
/// <para>
/// The mime type is sniffed from the file's own magic bytes rather than trusted
/// from <c>file_type</c>: the column is free text written by the legacy upload
/// form, and a PDF saved as ".jpg" would otherwise be embedded as an image and
/// fail. In practice the data is all PDF; the image branch is defensive.
/// </para>
/// </remarks>
public sealed class GraphRepository(NobleConnectionFactory db, SqlRetry retry)
{
    public sealed record GraphMeta(int Id, string FileType, string? TestName);
    public sealed record GraphFile(byte[] Bytes, string Mime);

    /// <summary>
    /// Metadata only — no bytes. Cheap enough to call for a button's visibility,
    /// which is exactly what it is for: a "Download graph" control that is shown
    /// when there is nothing behind it is worse than no control.
    /// </summary>
    public async Task<IReadOnlyList<GraphMeta>> ListAsync(string sid, CancellationToken ct = default)
    {
        var target = (sid ?? string.Empty).Trim();
        if (target.Length == 0) return [];

        return await retry.ExecuteAsync("reports.graph.list", token =>
            db.QueryAsync("reports.graph.list", async (conn, inner) =>
            {
                await using var cmd = NobleConnectionFactory.CreateCommand(conn,
                    """
                    SELECT a.id, a.file_type, r.testname
                    FROM dbo.tbl_med_mcc_patient_test_result_attachment a
                    LEFT JOIN dbo.tbl_med_mcc_patient_test_result r ON r.id = a.result_id
                    WHERE a.vail_id = @sid AND a.attachment IS NOT NULL
                    ORDER BY a.id;
                    """);
                cmd.Parameters.Add("@sid", SqlDbType.NVarChar, 50).Value = target;

                var list = new List<GraphMeta>();
                await using var r = await cmd.ExecuteReaderAsync(inner).ConfigureAwait(false);
                while (await r.ReadAsync(inner).ConfigureAwait(false))
                {
                    list.Add(new GraphMeta(
                        r.GetInt32(0),
                        r.IsDBNull(1) ? string.Empty : r.GetString(1).Trim(),
                        r.IsDBNull(2) ? null : r.GetString(2).Trim() is { Length: > 0 } n ? n : null));
                }
                return (IReadOnlyList<GraphMeta>)list;
            }, token), ct).ConfigureAwait(false);
    }

    /// <summary>Every attachment on a SID, in id order, with its sniffed mime.</summary>
    public async Task<IReadOnlyList<GraphFile>> GetFilesAsync(string sid, CancellationToken ct = default)
    {
        var target = (sid ?? string.Empty).Trim();
        if (target.Length == 0) return [];

        return await retry.ExecuteAsync("reports.graph.files", token =>
            db.QueryAsync("reports.graph.files", async (conn, inner) =>
            {
                await using var cmd = NobleConnectionFactory.CreateCommand(conn,
                    """
                    SELECT a.attachment, a.file_type
                    FROM dbo.tbl_med_mcc_patient_test_result_attachment a
                    WHERE a.vail_id = @sid AND a.attachment IS NOT NULL
                    ORDER BY a.id;
                    """);
                cmd.Parameters.Add("@sid", SqlDbType.NVarChar, 50).Value = target;

                var files = new List<GraphFile>();
                await using var r = await cmd.ExecuteReaderAsync(inner).ConfigureAwait(false);
                while (await r.ReadAsync(inner).ConfigureAwait(false))
                {
                    var bytes = (byte[])r[0];
                    var ext = r.IsDBNull(1) ? string.Empty : r.GetString(1);
                    files.Add(new GraphFile(bytes, SniffMime(bytes, ext)));
                }
                return (IReadOnlyList<GraphFile>)files;
            }, token), ct).ConfigureAwait(false);
    }

    /// <summary>
    /// Content type from the file's own leading bytes, falling back to the
    /// stored extension only when the magic is unrecognised.
    /// </summary>
    private static string SniffMime(byte[] b, string fileType)
    {
        if (b.Length >= 4 && b[0] == 0x25 && b[1] == 0x50 && b[2] == 0x44 && b[3] == 0x46) return "application/pdf";
        if (b.Length >= 4 && b[0] == 0x89 && b[1] == 0x50) return "image/png";
        if (b.Length >= 3 && b[0] == 0xFF && b[1] == 0xD8 && b[2] == 0xFF) return "image/jpeg";

        var ext = (fileType ?? string.Empty).ToLowerInvariant();
        if (ext.Contains("png")) return "image/png";
        if (ext.Contains("jpg") || ext.Contains("jpeg")) return "image/jpeg";
        return "application/pdf";
    }
}
