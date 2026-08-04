namespace Infinity.Api.Instruments;

public sealed record ImportCell(int RowNumber, string Sid, string TestCode, string Value);

public sealed record ParsedImport(
    IReadOnlyList<string> TestCodes,
    IReadOnlyList<ImportCell> Cells,
    IReadOnlyList<string> Warnings,
    int DataRows);

/// <summary>
/// Parses a WIDE-format result file: one row per sample, one column per
/// analyte, the header row carrying test codes.
///
///     SID,GLU,UREA,CREA
///     895608909737,5.4,4.2,78
///
/// This is the shape analysers and lab spreadsheets actually export, and per
/// docs/worksheet-lis-analysis.md it is what labs are almost certainly doing by
/// hand today. Every cell becomes one reading, fed through the SAME inbox and
/// matcher as an instrument result — so an unmatched imported value is as
/// visible and replayable as an unmatched analyser one.
///
/// CSV and TSV only. Not .xlsx: that needs a spreadsheet library, and a binary
/// format silently mis-parsing a clinical value is worse than declining to read
/// it. Labs can export CSV from anything.
/// </summary>
public static class WideFormatParser
{
    /// <summary>Header names accepted for the sample-identifier column.</summary>
    private static readonly HashSet<string> SidHeaders = new(StringComparer.OrdinalIgnoreCase)
    {
        "sid", "vailid", "vial", "vial id", "barcode", "sample", "sample id", "sampleid", "accession",
    };

    /// <summary>Columns that are context, not results, and must not become readings.</summary>
    private static readonly HashSet<string> IgnoredHeaders = new(StringComparer.OrdinalIgnoreCase)
    {
        "patient", "patient name", "name", "age", "sex", "gender", "date", "time",
        "collected", "received", "pid", "bill", "bill no", "client", "client code", "remarks", "comment", "comments",
    };

    public static ParsedImport Parse(string content, int maxRows = 5000)
    {
        var warnings = new List<string>();
        var lines = SplitLines(content);

        if (lines.Count == 0)
            return new ParsedImport([], [], ["The file is empty."], 0);

        var delimiter = DetectDelimiter(lines[0]);
        var header = SplitRow(lines[0], delimiter);

        var sidIndex = header.FindIndex(h => SidHeaders.Contains(h.Trim()));
        if (sidIndex < 0)
        {
            // Fall back to the first column, but say so — guessing silently is
            // how a whole file lands against the wrong identifier.
            sidIndex = 0;
            warnings.Add($"No recognised SID column header; using the first column ('{header.ElementAtOrDefault(0)}'). "
                       + "Rename it to SID to be explicit.");
        }

        var testColumns = new List<(int Index, string Code)>();
        for (var i = 0; i < header.Count; i++)
        {
            if (i == sidIndex) continue;
            var name = header[i].Trim();
            if (name.Length == 0) continue;
            if (IgnoredHeaders.Contains(name)) continue;
            testColumns.Add((i, name.ToUpperInvariant()));
        }

        if (testColumns.Count == 0)
            return new ParsedImport([], [], [..warnings, "No result columns found in the header row."], 0);

        var duplicates = testColumns.GroupBy(c => c.Code).Where(g => g.Count() > 1).Select(g => g.Key).ToList();
        if (duplicates.Count > 0)
            warnings.Add($"Duplicate test columns will each be imported separately: {string.Join(", ", duplicates)}.");

        var cells = new List<ImportCell>();
        var dataRows = 0;
        var blankSids = 0;

        for (var r = 1; r < lines.Count; r++)
        {
            if (lines[r].Trim().Length == 0) continue;

            if (dataRows >= maxRows)
            {
                warnings.Add($"Stopped after {maxRows} rows; the rest of the file was not read.");
                break;
            }

            var row = SplitRow(lines[r], delimiter);
            dataRows++;

            var sid = row.ElementAtOrDefault(sidIndex)?.Trim() ?? "";
            if (sid.Length == 0) { blankSids++; continue; }

            foreach (var (index, code) in testColumns)
            {
                var raw = row.ElementAtOrDefault(index)?.Trim();
                // A blank cell means "not measured", not "measured as empty" —
                // importing it would blank an existing result.
                if (string.IsNullOrWhiteSpace(raw)) continue;

                cells.Add(new ImportCell(r + 1, sid, code, raw));
            }
        }

        if (blankSids > 0)
            warnings.Add($"{blankSids} row(s) had no SID and were skipped.");

        return new ParsedImport(
            testColumns.Select(c => c.Code).Distinct(StringComparer.Ordinal).ToArray(),
            cells, warnings, dataRows);
    }

    private static List<string> SplitLines(string content) =>
        content.Replace("\r\n", "\n").Replace('\r', '\n')
               .Split('\n')
               .ToList();

    /// <summary>
    /// Tab beats comma when both appear: a TSV row containing a decimal comma
    /// ("5,4") would otherwise be split into two columns.
    /// </summary>
    private static char DetectDelimiter(string headerLine) =>
        headerLine.Contains('\t') ? '\t'
        : headerLine.Contains(';') && !headerLine.Contains(',') ? ';'
        : ',';

    /// <summary>
    /// RFC 4180-style split: quoted fields may contain the delimiter, and a
    /// doubled quote inside a quoted field is a literal quote.
    /// </summary>
    private static List<string> SplitRow(string line, char delimiter)
    {
        var fields = new List<string>();
        var current = new System.Text.StringBuilder();
        var inQuotes = false;

        for (var i = 0; i < line.Length; i++)
        {
            var c = line[i];

            if (inQuotes)
            {
                if (c == '"')
                {
                    if (i + 1 < line.Length && line[i + 1] == '"') { current.Append('"'); i++; }
                    else inQuotes = false;
                }
                else current.Append(c);
            }
            else if (c == '"') inQuotes = true;
            else if (c == delimiter) { fields.Add(current.ToString()); current.Clear(); }
            else current.Append(c);
        }

        fields.Add(current.ToString());
        return fields;
    }
}
