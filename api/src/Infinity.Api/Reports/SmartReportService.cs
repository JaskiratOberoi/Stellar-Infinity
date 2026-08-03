using Infinity.Api.Reads;

namespace Infinity.Api.Reports;

public sealed record SmartAnalyte(
    string? TestCode,
    /// <summary>The LIS name — always shown, so the report matches the clinical one.</summary>
    string LisName,
    /// <summary>Patient-friendly name when we recognise the analyte.</summary>
    string? FriendlyName,
    string? Value,
    string? Unit,
    string? RangeText,
    bool Abnormal,
    string Zone,
    Gauge? Gauge,
    string? What,
    string? Meaning,
    string? Advice,
    string? Comments);

public sealed record SmartSection(
    string CategoryId,
    string Title,
    string Tagline,
    string? About,
    IReadOnlyList<SmartAnalyte> Analytes,
    int AbnormalCount);

public sealed record SmartReport(
    string Sid,
    string? PatientName,
    string? Sex,
    int? Age,
    string? AgeUnit,
    string? ClientCode,
    DateTimeOffset? SampleDrawn,
    DateTimeOffset? ReportedAt,
    int TotalAnalytes,
    int AbnormalCount,
    /// <summary>Results withheld because the lab has not authorised them yet.</summary>
    int WithheldCount,
    bool FullyAuthorised,
    IReadOnlyList<SmartSection> Sections);

/// <summary>
/// Builds the patient-facing Smart Report: results grouped into body-system
/// sections with plain-English explanations and visual gauges.
///
/// Source data is the LIS worksheet feed, which already carries value, unit,
/// reference range, the lab's own abnormal flag, department and authorisation
/// state per analyte. The Smart Report groups by BODY SYSTEM rather than by LIS
/// panel, so it does not need the clinical report's panel tree.
/// </summary>
public sealed class SmartReportService(SmartMeta meta)
{
    /// <summary>
    /// Assemble the report for one worksheet row.
    ///
    /// ── UNAUTHORISED RESULTS ARE EXCLUDED ──────────────────────────────────
    /// Telo's sampleReport.ts carries a standing TODO noting that its report
    /// query returns every result row regardless of authorisation, so a
    /// partially-authorised sample would render — and release — tests the lab
    /// has not signed off. That is a patient-safety problem, not a cosmetic
    /// one, so Infinity does not reproduce it: unauthorised analytes are
    /// dropped here and counted in <see cref="SmartReport.WithheldCount"/> so
    /// the UI can say the report is provisional rather than silently showing a
    /// short report.
    ///
    /// This is the "simpler, zero-leak" option Telo's own comment recommends.
    /// </summary>
    public SmartReport Build(WorksheetRow row)
    {
        var authorised = row.Results.Where(r => r.Authorized).ToList();
        var withheld = row.Results.Count - authorised.Count;

        var sections = new List<SmartSection>();
        var grouped = new Dictionary<string, List<SmartAnalyte>>(StringComparer.Ordinal);
        var order = new List<string>();

        foreach (var r in authorised)
        {
            // A header/title row with no value is structural, not a result.
            if (string.IsNullOrWhiteSpace(r.Value) && string.IsNullOrWhiteSpace(r.Unit)) continue;

            var resolved = meta.Resolve(r.TestCode, r.TestName, r.DepartmentName);
            var gauge = SmartRange.Build(r.Value, r.NormalRange, row.Sex);

            // Trust the LIS's abnormal flag first — it is the lab's own
            // determination and may account for rules our text parsing cannot
            // see. Fall back to the gauge only when the flag is absent/false.
            var zone = r.Abnormal
                ? gauge?.Zone is "low" or "high" ? gauge.Zone : "high"
                : gauge?.Zone ?? "normal";
            var abnormal = r.Abnormal || zone is "low" or "high";

            var info = resolved.Info;
            var meaning = zone switch
            {
                "high" => info?.High,
                "low" => info?.Low,
                _ => null,
            };

            var analyte = new SmartAnalyte(
                TestCode: r.TestCode,
                LisName: r.TestName ?? r.TestCode ?? "Result",
                FriendlyName: info?.Name,
                Value: r.Value,
                Unit: r.Unit,
                RangeText: r.NormalRange,
                Abnormal: abnormal,
                Zone: zone,
                Gauge: gauge,
                What: info?.What,
                Meaning: meaning,
                Advice: abnormal
                    ? meta.ComposeAdvice(info, resolved.CategoryId, zone)
                    : meta.HealthyNote(info, resolved.CategoryId),
                Comments: r.Comments);

            if (!grouped.TryGetValue(resolved.CategoryId, out var list))
            {
                list = [];
                grouped[resolved.CategoryId] = list;
                order.Add(resolved.CategoryId);
            }
            list.Add(analyte);
        }

        // Sections in the order the analytes first appeared, which follows the
        // LIS's own ordering rather than imposing an arbitrary one — except
        // "other", which always sinks to the end.
        foreach (var id in order.OrderBy(id => id == "other" ? 1 : 0))
        {
            var cat = meta.Category(id);
            var analytes = grouped[id];
            sections.Add(new SmartSection(
                id, cat.Title, cat.Tagline, cat.About,
                analytes, analytes.Count(a => a.Abnormal)));
        }

        var total = sections.Sum(s => s.Analytes.Count);

        return new SmartReport(
            Sid: row.Sid,
            PatientName: row.PatientName,
            Sex: row.Sex,
            Age: row.Age,
            AgeUnit: row.AgeUnit,
            ClientCode: row.ClientCode,
            SampleDrawn: row.SampleDrawn,
            ReportedAt: row.LastModifiedAt,
            TotalAnalytes: total,
            AbnormalCount: sections.Sum(s => s.AbnormalCount),
            WithheldCount: withheld,
            FullyAuthorised: withheld == 0,
            Sections: sections);
    }
}
