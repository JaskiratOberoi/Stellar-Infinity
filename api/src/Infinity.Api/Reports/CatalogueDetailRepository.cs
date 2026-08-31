using System.Data;
using System.Text.RegularExpressions;
using Infinity.Api.Data;
using Infinity.Api.Reads;
using Microsoft.Data.SqlClient;

namespace Infinity.Api.Reports;

/// <summary>
/// The two things a printed result row needs from the catalogue that the
/// report procedure does not carry: the reference range narrowed to the
/// patient's age, and an interpretation stored as a picture rather than as
/// text.
/// </summary>
/// <remarks>
/// Both are keyed on <c>testid</c> and both are read for the handful of tests
/// on ONE sample, so they go out as a single batch with two result sets rather
/// than as a query per row.
///
/// Ported from Telo — <c>db/read/ageRange.ts</c> and the attachment fetch at
/// the end of <c>db/read/sampleReport.ts</c> — because the two products print
/// the same document and a range that differs between them is a different
/// clinical claim about the same number.
///
/// Read-only. Ranges come from existing LIS tables; the attachment read also
/// consults dbo.inf_test_attachment_override (136_inf_test_attachment_override.sql),
/// Infinity's own image per test, which wins over the shared LIS table.
/// </remarks>
public sealed partial class CatalogueDetailRepository(NobleConnectionFactory db, SqlRetry retry)
{
    /// <summary>
    /// A signature-sized ceiling on an inlined image. The interpretation
    /// graphs (HBV, HCV) are small PNGs; something megabytes long in that
    /// column is bad data, and inlining it would bloat every render.
    /// </summary>
    private const int MaxImageBytes = 1024 * 1024;

    /// <summary>
    /// Only a range that DUMPS its age bands is worth narrowing. A descriptive
    /// range (Desirable / Borderline / Optimal) and a gendered one carry
    /// information the numeric band does not, so they keep their stored text.
    /// Same test as Telo's AGE_BANDED.
    /// </summary>
    [GeneratedRegex(@"\b(adult|paediatric|pediatric|newborn|year|month|week|trimester)\b",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex AgeBanded();

    /// <summary>Digits, dot, space, hyphen or en-dash — nothing else.</summary>
    [GeneratedRegex(@"^[\d.\s–-]+$", RegexOptions.CultureInvariant)]
    private static partial Regex Numeric();

    public sealed record Details(
        IReadOnlyDictionary<int, string> AgeRanges,
        IReadOnlyDictionary<int, string> InterpretationImages);

    private static readonly Details Empty =
        new(new Dictionary<int, string>(), new Dictionary<int, string>());

    /// <summary>
    /// <c>tbl_med_test_normalranges.agetype</c>: 1 years, 2 months, 3 days.
    /// </summary>
    private static string AgeTypeFor(string? unit)
    {
        var u = (unit ?? string.Empty).ToLowerInvariant();
        if (u.Contains("month", StringComparison.Ordinal)) return "2";
        if (u.Contains("day", StringComparison.Ordinal)) return "3";
        return "1";
    }

    /// <summary>Does this stored range want narrowing to the patient's age?</summary>
    public static bool WantsAgeRange(string? storedRange) =>
        !string.IsNullOrWhiteSpace(storedRange) && AgeBanded().IsMatch(storedRange);

    public async Task<Details> GetAsync(
        IReadOnlyCollection<int> testIds,
        int? age,
        string? ageUnit,
        bool wantAgeRanges,
        CancellationToken ct = default)
    {
        var ids = testIds.Where(id => id > 0).Distinct().OrderBy(id => id).ToArray();
        if (ids.Length == 0) return Empty;

        var ageType = AgeTypeFor(ageUnit);
        var resolveAges = wantAgeRanges && age is int a && a >= 0;

        return await retry.ExecuteAsync("reports.catalogue", token =>
                db.QueryAsync("reports.catalogue", async (conn, inner) =>
                {
                    var list = string.Join(",", ids.Select((_, i) => "@t" + i.ToString(System.Globalization.CultureInfo.InvariantCulture)));

                    // One batch, two result sets. The age-range half is skipped
                    // outright when there is no age to narrow to, rather than
                    // running a query whose WHERE clause can never match.
                    var sql = (resolveAges
                        ? $"""
                           SELECT testid, fnormal, tnormal, fage, tage
                           FROM dbo.tbl_med_test_normalranges
                           WHERE testid IN ({list})
                             AND ISNULL(IsActive, 1) = 1
                             AND agetype = @agetype
                             AND fage <= @age AND tage >= @age
                             AND fnormal IS NOT NULL AND tnormal IS NOT NULL
                             AND fnormal NOT LIKE '%[A-Za-z]%'
                             AND tnormal NOT LIKE '%[A-Za-z]%';
                           """
                        : "SELECT TOP 0 CONVERT(int, NULL) AS testid, CONVERT(nvarchar(100), NULL) AS fnormal, CONVERT(nvarchar(100), NULL) AS tnormal, CONVERT(int, NULL) AS fage, CONVERT(int, NULL) AS tage;")
                        + $"""

                           -- Infinity's own image wins over the shared table.
                           -- The modern HCV/HBV panels live ONLY in the
                           -- override (136_inf_test_attachment_override.sql):
                           -- the legacy LIS prints straight from the shared
                           -- table and mangles them, so that keeps its
                           -- original images while Infinity shows the new.
                           SELECT a.testid,
                                  attachment = COALESCE(o.attachment, a.attachment)
                           FROM dbo.tbl_med_test_master_attachment a
                           LEFT JOIN dbo.inf_test_attachment_override o
                             ON o.testid = a.testid
                           WHERE a.testid IN ({list});
                           """;

                    await using var cmd = NobleConnectionFactory.CreateCommand(conn, sql);
                    for (var i = 0; i < ids.Length; i++)
                        cmd.Parameters.Add("@t" + i.ToString(System.Globalization.CultureInfo.InvariantCulture), SqlDbType.Int).Value = ids[i];
                    if (resolveAges)
                    {
                        cmd.Parameters.Add("@agetype", SqlDbType.NVarChar, 10).Value = ageType;
                        cmd.Parameters.Add("@age", SqlDbType.Int).Value = age!.Value;
                    }

                    await using var r = await cmd.ExecuteReaderAsync(inner).ConfigureAwait(false);

                    // testid → every band that contains this age.
                    var bands = new Dictionary<int, List<(string Lo, string Hi, int Width)>>();
                    while (await r.ReadAsync(inner).ConfigureAwait(false))
                    {
                        var testId = r.NullableInt("testid");
                        if (testId is not int tid) continue;
                        var lo = (r.Str("fnormal") ?? string.Empty).Trim();
                        var hi = (r.Str("tnormal") ?? string.Empty).Trim();
                        if (!Numeric().IsMatch(lo) || !Numeric().IsMatch(hi)) continue;
                        var width = (r.NullableInt("tage") ?? 0) - (r.NullableInt("fage") ?? 0);
                        if (!bands.TryGetValue(tid, out var l)) bands[tid] = l = new List<(string Lo, string Hi, int Width)>();
                        l.Add((lo, hi, width));
                    }

                    var ranges = new Dictionary<int, string>();
                    foreach (var (tid, candidates) in bands)
                    {
                        if (candidates.Count == 0) continue;
                        // Narrowest band wins; if the narrowest disagree with
                        // each other the difference is gendered and we do not
                        // know which one this patient is — so print nothing
                        // rather than guess, and let the stored text stand.
                        var minWidth = candidates.Min(c => c.Width);
                        var narrowest = candidates.Where(c => c.Width == minWidth).ToArray();
                        var distinct = narrowest.Select(c => c.Lo + "|" + c.Hi).Distinct(StringComparer.Ordinal).Count();
                        if (distinct != 1) continue;
                        ranges[tid] = $"{narrowest[0].Lo} - {narrowest[0].Hi}";
                    }

                    var images = new Dictionary<int, string>();
                    if (await r.NextResultAsync(inner).ConfigureAwait(false))
                    {
                        while (await r.ReadAsync(inner).ConfigureAwait(false))
                        {
                            var testId = r.NullableInt("testid");
                            if (testId is not int tid) continue;
                            var col = r.GetOrdinal("attachment");
                            if (await r.IsDBNullAsync(col, inner).ConfigureAwait(false)) continue;
                            var bytes = (byte[])r.GetValue(col);
                            if (bytes.Length == 0 || bytes.Length > MaxImageBytes) continue;
                            // The LIS stores these as PNG, occasionally JPEG.
                            var jpeg = bytes.Length >= 3 && bytes[0] == 0xFF && bytes[1] == 0xD8 && bytes[2] == 0xFF;
                            images[tid] = $"data:{(jpeg ? "image/jpeg" : "image/png")};base64,{Convert.ToBase64String(bytes)}";
                        }
                    }

                    return new Details(ranges, images);
                }, token), ct).ConfigureAwait(false);
    }
}
