using System.Net;
using System.Text.RegularExpressions;

namespace Infinity.Api.Worksheet;

/// <summary>
/// The shape a result value is stored in: plain lines.
/// </summary>
/// <remarks>
/// The result column is shared with the legacy LIS, which enters descriptive
/// values through a multi-line textbox and stores them as text with line
/// breaks, and whose worksheet preview shows the stored value literally. A
/// value saved as markup — the form's editor wrote <c>&lt;div&gt;</c>
/// paragraphs until 2026-09-23 — came out on that screen tags and all. The
/// form now writes lines; this is the same rule at the API, so no client,
/// old bundle or replayed request can put markup into the column again.
/// A value with no tag or entity in it passes through untouched.
/// </remarks>
public static partial class ResultText
{
    [GeneratedRegex(@"<\s*(?:br|/p|/div|/li|/h[1-6]|/tr)\s*/?\s*>", RegexOptions.IgnoreCase)]
    private static partial Regex LineBreakTags();

    // A tag starts with a letter or a slash: "<0.5 and >10" is two
    // comparators in a result, not markup, and must pass through untouched.
    [GeneratedRegex(@"</?[a-zA-Z][^>]*>")]
    private static partial Regex AnyTag();

    [GeneratedRegex(@"&(?:[a-zA-Z]+|#\d+|#x[0-9a-fA-F]+);")]
    private static partial Regex Entity();

    [GeneratedRegex(@"[ \t]+(?=\r?\n)")]
    private static partial Regex TrailingSpace();

    [GeneratedRegex(@"(\r?\n){3,}")]
    private static partial Regex BlankRuns();

    /// <summary>The value as plain lines; null and empty stay as they are.</summary>
    public static string? Lines(string? value)
    {
        if (string.IsNullOrEmpty(value)) return value;
        if (!AnyTag().IsMatch(value) && !Entity().IsMatch(value)) return value;

        var s = value.Replace("\r\n", "\n");
        // A paragraph or line boundary is a line break; every other tag is
        // presentation and goes. Decoding comes last so a literal "&lt;" in
        // the text is not mistaken for a tag.
        s = LineBreakTags().Replace(s, "\n");
        s = AnyTag().Replace(s, string.Empty);
        s = WebUtility.HtmlDecode(s).Replace(' ', ' ');
        s = TrailingSpace().Replace(s, string.Empty);
        s = BlankRuns().Replace(s, "\n\n");
        s = s.Trim('\n', ' ', '\t');
        return s.Length == 0 ? string.Empty : s;
    }
}
