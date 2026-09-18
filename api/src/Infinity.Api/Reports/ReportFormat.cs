namespace Infinity.Api.Reports;

/// <summary>
/// The report's FORMAT — its typography, not its paper. "v1" is the format
/// every report has been issued in; "v2" is the same layout in a serif face
/// with the tabular text in capitals, under test since 2026-09-12; "v3" is v2
/// set in Playfair Display, under test since 2026-09-19. The print page reads
/// <c>?format=</c>; the PDF routes carry it into the print URL and into the
/// cache key, since the formats are different documents. Anything
/// unrecognised is v1, so an old caller never gets a test format.
/// </summary>
public static class ReportFormat
{
    public const string V1 = "v1";
    public const string V2 = "v2";
    public const string V3 = "v3";

    public static string Normalise(string? format)
    {
        var f = format?.Trim();
        if (string.Equals(f, V2, StringComparison.OrdinalIgnoreCase)) return V2;
        if (string.Equals(f, V3, StringComparison.OrdinalIgnoreCase)) return V3;
        return V1;
    }

    /// <summary>The query fragment for the print route: nothing for v1.</summary>
    public static string Query(string format) => format == V1 ? string.Empty : $"&format={format}";
}
