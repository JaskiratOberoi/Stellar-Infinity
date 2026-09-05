using Infinity.Api.Domain;
using Infinity.Api.Reads;

namespace Infinity.Api.Reports;

/// <summary>
/// The name a downloaded report is saved under:
/// <c>FullNameWithTitle_age_id_date.pdf</c> — e.g. <c>MrsANJALI_32Y_9632862_20260905.pdf</c>.
/// </summary>
/// <remarks>
/// The id is the SID for a single report and the PID for a complete patient
/// report, so the file says which it is. The name is the salutation and the
/// name run together with no spaces, the way the legacy LIS named its files
/// (<c>MRSSUDHA_65Y_…</c>); the salutation is already part of
/// <see cref="WorksheetRow.PatientName"/>, joined by the report procedure.
/// Anything that is not a letter, digit, hyphen or underscore is dropped, so
/// the name is safe on every filesystem and in a Content-Disposition header.
/// The date is the lab's own calendar day, not UTC.
/// </remarks>
public static class ReportFileName
{
    public static string For(WorksheetRow row, string id)
    {
        var who = Clean((row.PatientName ?? string.Empty).Replace(" ", string.Empty));
        var age = row.Age is int a ? $"{a}{UnitInitial(row.AgeUnit)}" : null;
        var date = NobleTime.NowForNoble().ToString("yyyyMMdd");
        var parts = new[] { who, age, Clean(id), date }.Where(p => !string.IsNullOrEmpty(p));
        return string.Join("_", parts) + ".pdf";
    }

    /// <summary>"Year(s)" → Y, "Month(s)" → M, "Day(s)" → D; years when unsaid.</summary>
    private static string UnitInitial(string? unit)
    {
        var u = (unit ?? string.Empty).Trim();
        return u.Length == 0 ? "Y" : char.ToUpperInvariant(u[0]).ToString();
    }

    private static string Clean(string s) =>
        new(s.Where(c => char.IsLetterOrDigit(c) || c is '-' or '_').ToArray());
}
