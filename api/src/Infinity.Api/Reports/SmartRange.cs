using System.Globalization;
using System.Text.RegularExpressions;

namespace Infinity.Api.Reports;

public sealed record ParsedRange(double? Low, double? High);

/// <summary>Gauge geometry. <c>Pos</c> is 0..1 along the track.</summary>
public sealed record Gauge(string Kind, double? Low, double? High, double Value, double Pos, string Zone);

/// <summary>
/// Reference-range parsing for the Smart Report gauges, ported from Telo's
/// lib/report/smartRange.ts.
///
/// The LIS stores ranges as validated free text — "0.35 - 5.50", "&lt; 200",
/// "Up to 40", sex-split "M: 13 - 17 F: 12 - 15", and multi-line banded text.
/// When a range cannot be understood the report shows the value and the range
/// text with NO gauge. That is the important behaviour: no picture is always
/// better than a wrong picture on a medical result.
/// </summary>
public static partial class SmartRange
{
    private const string Num = @"-?\d+(?:\.\d+)?";

    [GeneratedRegex(Num)] private static partial Regex FirstNumber();

    [GeneratedRegex($@"({Num})\s*(?:-|–|—|to)\s*({Num})", RegexOptions.IgnoreCase)]
    private static partial Regex Between();

    [GeneratedRegex($@"(?:<\s*=?|≤|up\s*to|upto|below|less\s+than)\s*({Num})", RegexOptions.IgnoreCase)]
    private static partial Regex AtMost();

    [GeneratedRegex($@"(?:>\s*=?|≥|above|more\s+than)\s*({Num})", RegexOptions.IgnoreCase)]
    private static partial Regex AtLeast();

    /// <summary>
    /// Labels marking the healthy band inside a banded multi-line range.
    ///
    /// The <c>(?&lt;!in)sufficien</c> guard is load-bearing: it matches
    /// "Sufficiency" (the healthy Vitamin-D band) but NOT "Insufficiency",
    /// which contains the same substring and would otherwise be picked as the
    /// healthy band — putting a deficient patient in the green.
    /// </summary>
    [GeneratedRegex(@"(desirable|normal|optimal|(?<!in)sufficien|adequate|euthyroid|non[-\s]?diabetic|negative|low\s*risk)",
        RegexOptions.IgnoreCase)]
    private static partial Regex NormalBand();

    [GeneratedRegex(@"\b(?:males?|m)\s*[:=-]\s*([^\n;]*)", RegexOptions.IgnoreCase)]
    private static partial Regex MaleSegment();

    [GeneratedRegex(@"\b(?:females?|f)\s*[:=-]\s*([^\n;]*)", RegexOptions.IgnoreCase)]
    private static partial Regex FemaleSegment();

    [GeneratedRegex(@"\s+")] private static partial Regex Whitespace();

    /// <summary>First numeric token in a string: "12.3", "1,234", "&lt;0.01" → 0.01.</summary>
    public static double? ParseNumericValue(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return null;
        var m = FirstNumber().Match(raw.Replace(",", " "));
        return m.Success && double.TryParse(m.Value, NumberStyles.Float, CultureInfo.InvariantCulture, out var n)
            ? n
            : null;
    }

    private static ParsedRange? ParseSegment(string segment)
    {
        var s = Whitespace().Replace(segment.Replace(",", ""), " ").Trim();
        if (s.Length == 0) return null;

        var m = Between().Match(s);
        if (m.Success
            && double.TryParse(m.Groups[1].Value, NumberStyles.Float, CultureInfo.InvariantCulture, out var lo)
            && double.TryParse(m.Groups[2].Value, NumberStyles.Float, CultureInfo.InvariantCulture, out var hi)
            && lo < hi)
        {
            return new ParsedRange(lo, hi);
        }

        m = AtMost().Match(s);
        if (m.Success && double.TryParse(m.Groups[1].Value, NumberStyles.Float, CultureInfo.InvariantCulture, out var high))
            return new ParsedRange(null, high);

        m = AtLeast().Match(s);
        if (m.Success && double.TryParse(m.Groups[1].Value, NumberStyles.Float, CultureInfo.InvariantCulture, out var low))
            return new ParsedRange(low, null);

        return null;
    }

    /// <summary>
    /// Parse the LIS free-text range. <paramref name="sex"/> narrows a sex-split
    /// range to the patient's own band when both are present.
    /// </summary>
    public static ParsedRange? Parse(string? raw, string? sex)
    {
        if (string.IsNullOrWhiteSpace(raw)) return null;
        var text = raw.Replace("\r\n", "\n").Replace("\r", "\n").Trim();
        if (text.Length == 0) return null;

        var s = (sex ?? "").Trim();
        var male = s.StartsWith('m') || s.StartsWith('M');
        var female = s.StartsWith('f') || s.StartsWith('F');

        if (male || female)
        {
            var mSeg = MaleSegment().Match(text);
            var fSeg = FemaleSegment().Match(text);
            if (mSeg.Success && fSeg.Success)
            {
                var own = male ? mSeg.Groups[1].Value : fSeg.Groups[1].Value;
                var parsed = ParseSegment(own);
                if (parsed is not null) return parsed;
            }
        }

        var lines = text.Split('\n').Select(l => l.Trim()).Where(l => l.Length > 0).ToArray();
        if (lines.Length == 0) return null;
        if (lines.Length == 1) return ParseSegment(lines[0]);

        // Banded range: prefer the line labelled as the healthy band.
        var normalLine = lines.FirstOrDefault(l => NormalBand().IsMatch(l));
        if (normalLine is not null)
        {
            var parsed = ParseSegment(normalLine);
            if (parsed is not null) return parsed;
        }

        return lines.Select(ParseSegment).FirstOrDefault(p => p is not null);
    }

    /// <summary>
    /// Gauge geometry for a value against its band. The normal band occupies the
    /// middle 50% of a two-sided track; out-of-range values compress into the
    /// alert zones so an extreme result never falls off the end.
    /// </summary>
    public static Gauge? Build(string? valueRaw, string? rangeRaw, string? sex)
    {
        var value = ParseNumericValue(valueRaw);
        var range = Parse(rangeRaw, sex);
        if (value is not double v || range is null) return null;

        static double Clamp(double x, double lo, double hi) => Math.Min(hi, Math.Max(lo, x));

        if (range.Low is double low && range.High is double high)
        {
            var span = high - low;
            if (span <= 0) return null;

            double pos;
            string zone;
            if (v < low) { pos = Clamp(0.25 - (low - v) / span * 0.23, 0.02, 0.25); zone = "low"; }
            else if (v > high) { pos = Clamp(0.75 + (v - high) / span * 0.23, 0.75, 0.98); zone = "high"; }
            else { pos = 0.25 + (v - low) / span * 0.5; zone = "normal"; }

            return new Gauge("both", low, high, v, pos, zone);
        }

        if (range.High is double onlyHigh)
        {
            var scale = Math.Abs(onlyHigh) > 0 ? Math.Abs(onlyHigh) : 1;
            var pos = v <= onlyHigh
                ? Clamp(v / (onlyHigh == 0 ? 1 : onlyHigh) * 0.6, 0.02, 0.6)
                : Clamp(0.6 + (v - onlyHigh) / scale * 0.36, 0.6, 0.98);
            return new Gauge("max", null, onlyHigh, v, pos, v <= onlyHigh ? "normal" : "high");
        }

        if (range.Low is double onlyLow)
        {
            var scale = Math.Abs(onlyLow) > 0 ? Math.Abs(onlyLow) : 1;
            var pos = v >= onlyLow
                ? Clamp(0.4 + (v - onlyLow) / scale * 0.3, 0.4, 0.98)
                : Clamp(0.4 - (onlyLow - v) / scale * 0.38, 0.02, 0.4);
            return new Gauge("min", onlyLow, null, v, pos, v >= onlyLow ? "normal" : "low");
        }

        return null;
    }
}
