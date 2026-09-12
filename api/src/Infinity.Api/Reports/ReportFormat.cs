namespace Infinity.Api.Reports;

/// <summary>
/// The report's FORMAT — its typography, not its paper. "v1" is the format
/// every report has been issued in; "v2" is the same layout in a serif face
/// with the tabular text in capitals, under test since 2026-09-12. The print
/// page reads <c>?format=</c>; the PDF routes carry it into the print URL and
/// into the cache key, since the two formats are different documents.
/// Anything unrecognised is v1, so an old caller never gets the test format.
/// </summary>
public static class ReportFormat
{
    public const string V1 = "v1";
    public const string V2 = "v2";

    public static string Normalise(string? format) =>
        string.Equals(format?.Trim(), V2, StringComparison.OrdinalIgnoreCase) ? V2 : V1;

    /// <summary>The query fragment for the print route: nothing for v1.</summary>
    public static string Query(string format) => format == V2 ? "&format=v2" : string.Empty;
}
