using System.Data;
using Infinity.Api.Data;
using Infinity.Api.Reads;

namespace Infinity.Api.Reports;

/// <param name="Code">The centre's own code, as it appears on the order.</param>
public sealed record CollectionCentre(
    string Code, string? Name, string? Address, string? City, string? Phone, string? Email);

/// <param name="Accreditation">
/// Printed ahead of the Processed-at line, e.g. "MC-2547 NABL Accredited" for
/// Delhi. From inf_business_unit_footer; null for units with no accreditation.
/// </param>
public sealed record ProcessingUnit(
    int Id, string? Name, string? Address, string? City, string? Phone, string? Accreditation);

/// <param name="SignatureDataUrl">
/// The signature image, inlined as a data URI. Inlined rather than served from
/// a URL because the renderer photographs this page in a headless browser: a
/// second request for an image is a second thing that can be slow or fail
/// between "ready to print" and the shutter, and a report signed by nobody is
/// worse than a report that took another 40ms to assemble.
/// </param>
public sealed record ReportSigner(
    int Id, string? DoctorName, string? Designation, int DocType, string? SignatureDataUrl);

/// <summary>Everything a printed report carries that is not a result.</summary>
public sealed record ReportExtras(
    CollectionCentre? CollectedAt,
    ProcessingUnit? ProcessedAt,
    IReadOnlyList<ReportSigner> Signers,
    /// <summary>profile id → clinical significance, for the profiles on this report.</summary>
    IReadOnlyDictionary<int, string> ProfileInterpretations);

/// <summary>
/// The report's surroundings: where the sample was collected, which lab
/// processed it, who signs it, and the profile-level clinical text.
/// </summary>
/// <remarks>
/// One procedure and one round trip. Telo issues these as five separate awaited
/// reads from Node; here the renderer is waiting on the whole page before it
/// can photograph anything, so the latency is worth collapsing.
/// </remarks>
public sealed class ReportExtrasRepository(NobleConnectionFactory db, SqlRetry retry)
{
    /// <summary>
    /// Guards against a pathological row. Signatures are small scanned images —
    /// a few kilobytes — and something megabytes long in that column is bad
    /// data, not a signature. Inlining it would bloat every report render.
    /// </summary>
    private const int MaxSignatureBytes = 512 * 1024;

    public Task<ReportExtras> GetAsync(string sid, CancellationToken ct = default) =>
        retry.ExecuteAsync("reports.extras", token =>
            db.QueryAsync("reports.extras", async (conn, inner) =>
            {
                await using var cmd = db.CreateWriteCommand(conn, "dbo.usp_inf_report_extras");
                cmd.Parameters.Add("@sid", SqlDbType.NVarChar, 50).Value = sid;

                await using var r = await cmd.ExecuteReaderAsync(inner).ConfigureAwait(false);

                CollectionCentre? centre = null;
                if (await r.ReadAsync(inner).ConfigureAwait(false))
                {
                    centre = new CollectionCentre(
                        r.Str("code") ?? "", r.Str("name"), r.Str("address"),
                        r.Str("city"), r.Str("phone"), r.Str("email"));
                }

                ProcessingUnit? unit = null;
                if (await r.NextResultAsync(inner).ConfigureAwait(false)
                    && await r.ReadAsync(inner).ConfigureAwait(false))
                {
                    unit = new ProcessingUnit(
                        r.Int("id"), r.Str("name"), r.Str("address"), r.Str("city"), r.Str("phone"),
                        r.Str("accreditation"));
                }

                var signers = new List<ReportSigner>();
                if (await r.NextResultAsync(inner).ConfigureAwait(false))
                {
                    while (await r.ReadAsync(inner).ConfigureAwait(false))
                    {
                        var i = r.GetOrdinal("signature");
                        string? dataUrl = null;
                        if (!await r.IsDBNullAsync(i, inner).ConfigureAwait(false))
                        {
                            var bytes = (byte[])r.GetValue(i);
                            if (bytes.Length > 0 && bytes.Length <= MaxSignatureBytes)
                                dataUrl = $"data:{SniffMime(bytes)};base64,{Convert.ToBase64String(bytes)}";
                        }

                        signers.Add(new ReportSigner(
                            r.Int("id"), r.Str("doctor_name"), r.Str("designation"),
                            r.NullableInt("doc_type") ?? 99, dataUrl));
                    }
                }

                var interps = new Dictionary<int, string>();
                if (await r.NextResultAsync(inner).ConfigureAwait(false))
                {
                    while (await r.ReadAsync(inner).ConfigureAwait(false))
                    {
                        var id = r.NullableInt("profile_id");
                        var text = r.Str("interpretation");
                        if (id is > 0 && !string.IsNullOrWhiteSpace(text)) interps[id.Value] = text.Trim();
                    }
                }

                return new ReportExtras(centre, unit, signers, interps);
            }, token), ct);

    /// <summary>
    /// The image type, from the first bytes rather than from a column.
    /// </summary>
    /// <remarks>
    /// The LIS stores the signature as bare bytes with nothing recording what
    /// they are, and the ones in the table are a mix of JPEG and PNG. A guess
    /// of image/png over a JPEG renders as a broken image in Chromium, which on
    /// a report means an unsigned report — so the bytes are asked instead.
    /// </remarks>
    private static string SniffMime(byte[] b)
    {
        if (b.Length >= 3 && b[0] == 0xFF && b[1] == 0xD8 && b[2] == 0xFF) return "image/jpeg";
        if (b.Length >= 8 && b[0] == 0x89 && b[1] == 0x50 && b[2] == 0x4E && b[3] == 0x47) return "image/png";
        if (b.Length >= 6 && b[0] == 0x47 && b[1] == 0x49 && b[2] == 0x46) return "image/gif";
        // A bitmap is unusual but does appear in the older rows.
        if (b.Length >= 2 && b[0] == 0x42 && b[1] == 0x4D) return "image/bmp";
        return "application/octet-stream";
    }
}
