using System.Reflection;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace Infinity.Api.Reports;

public sealed record SmartCategory(string Id, string Title, string Tagline, string? About);

public sealed record TestInfo(
    string? Name,
    string CategoryId,
    string? What,
    string? High,
    string? Low,
    string? Advice,
    string? AdviceHigh,
    string? AdviceLow,
    string? AdviceOk);

public sealed record ResolvedMeta(TestInfo? Info, string CategoryId);

/// <summary>
/// The Smart Report knowledge base — body-system categories plus per-analyte
/// patient-friendly copy for ~90 analytes.
///
/// The content is NOT authored here. It is generated from Telo's
/// lib/report/smartMeta.ts by tools/smartmeta-export.mjs into an embedded
/// smart-meta.json, so the clinical copy has a single source of truth and can
/// be regenerated when Telo's file changes. Re-authoring it in C# would fork it
/// immediately and risk transcription errors in medical text.
/// </summary>
public sealed class SmartMeta
{
    private sealed record Payload(
        [property: JsonPropertyName("categories")] List<SmartCategory> Categories,
        [property: JsonPropertyName("categoryAdvice")] Dictionary<string, string> CategoryAdvice,
        [property: JsonPropertyName("categoryAdviceDirectional")] Dictionary<string, Directional> CategoryAdviceDir,
        [property: JsonPropertyName("categoryAdviceOk")] Dictionary<string, string> CategoryAdviceOk,
        [property: JsonPropertyName("departmentFallback")] List<DeptRule> DepartmentFallback,
        [property: JsonPropertyName("matchers")] List<MatcherDto> Matchers);

    private sealed record Directional(
        [property: JsonPropertyName("high")] string? High,
        [property: JsonPropertyName("low")] string? Low);

    private sealed record DeptRule(
        [property: JsonPropertyName("pattern")] string Pattern,
        [property: JsonPropertyName("flags")] string Flags,
        [property: JsonPropertyName("categoryId")] string CategoryId);

    private sealed record MatcherDto(
        [property: JsonPropertyName("pattern")] string Pattern,
        [property: JsonPropertyName("flags")] string Flags,
        [property: JsonPropertyName("codes")] List<string>? Codes,
        [property: JsonPropertyName("info")] TestInfo Info);

    private sealed record Matcher(Regex Name, HashSet<string>? Codes, TestInfo Info);

    private readonly List<Matcher> _matchers = [];
    private readonly List<(Regex Pattern, string CategoryId)> _deptFallback = [];
    private readonly Dictionary<string, SmartCategory> _categories = new(StringComparer.Ordinal);
    private readonly Dictionary<string, string> _advice;
    private readonly Dictionary<string, Directional> _adviceDir;
    private readonly Dictionary<string, string> _adviceOk;

    public IReadOnlyList<SmartCategory> Categories { get; }

    public SmartMeta()
    {
        var asm = Assembly.GetExecutingAssembly();
        var name = asm.GetManifestResourceNames().FirstOrDefault(n => n.EndsWith("smart-meta.json", StringComparison.Ordinal))
            ?? throw new InvalidOperationException(
                "smart-meta.json is not embedded. Run tools/smartmeta-export.mjs and rebuild.");

        using var stream = asm.GetManifestResourceStream(name)!;

        // Case-INSENSITIVE is required, not cosmetic: the generated JSON uses
        // camelCase keys while the records are PascalCase, and System.Text.Json
        // matches case-sensitively by default. Without this every nested record
        // deserialises with null members and the category dictionary throws on
        // a null key.
        var payload = JsonSerializer.Deserialize<Payload>(stream, new JsonSerializerOptions
        {
            PropertyNameCaseInsensitive = true,
        }) ?? throw new InvalidOperationException("smart-meta.json could not be parsed.");

        foreach (var c in payload.Categories)
        {
            if (string.IsNullOrWhiteSpace(c.Id))
                throw new InvalidOperationException("smart-meta.json has a category with no id — regenerate it.");
            _categories[c.Id] = c;
        }

        if (!_categories.ContainsKey("other"))
            throw new InvalidOperationException("smart-meta.json is missing the 'other' fallback category.");

        Categories = payload.Categories;

        _advice = payload.CategoryAdvice;
        _adviceDir = payload.CategoryAdviceDir;
        _adviceOk = payload.CategoryAdviceOk;

        foreach (var m in payload.Matchers)
        {
            _matchers.Add(new Matcher(
                ToRegex(m.Pattern, m.Flags),
                m.Codes is { Count: > 0 }
                    ? new HashSet<string>(m.Codes.Select(c => c.ToUpperInvariant()), StringComparer.Ordinal)
                    : null,
                m.Info));
        }

        foreach (var d in payload.DepartmentFallback)
            _deptFallback.Add((ToRegex(d.Pattern, d.Flags), d.CategoryId));
    }

    private static Regex ToRegex(string pattern, string flags)
    {
        var opts = RegexOptions.CultureInvariant;
        if (flags.Contains('i')) opts |= RegexOptions.IgnoreCase;
        if (flags.Contains('s')) opts |= RegexOptions.Singleline;
        if (flags.Contains('m')) opts |= RegexOptions.Multiline;
        return new Regex(pattern, opts);
    }

    public SmartCategory Category(string id) =>
        _categories.TryGetValue(id, out var c) ? c : _categories["other"];

    /// <summary>
    /// Resolve an analyte to its knowledge entry and body-system category.
    ///
    /// Match order — exact test code, then test-name regex, then LIS department,
    /// then "other". A category is ALWAYS returned, so an unrecognised analyte
    /// still appears on the report rather than being silently dropped. That
    /// property matters: a patient's result vanishing is worse than it appearing
    /// without an explanation.
    /// </summary>
    public ResolvedMeta Resolve(string? code, string? name, string? departmentName)
    {
        var upperCode = (code ?? "").Trim().ToUpperInvariant();
        var nm = (name ?? "").Trim();

        if (upperCode.Length > 0)
        {
            foreach (var m in _matchers)
            {
                if (m.Codes is not null && m.Codes.Contains(upperCode))
                    return new ResolvedMeta(m.Info, m.Info.CategoryId);
            }
        }

        if (nm.Length > 0)
        {
            foreach (var m in _matchers)
            {
                if (m.Name.IsMatch(nm)) return new ResolvedMeta(m.Info, m.Info.CategoryId);
            }
        }

        var dept = departmentName ?? "";
        foreach (var (pattern, categoryId) in _deptFallback)
        {
            if (pattern.IsMatch(dept) && _categories.ContainsKey(categoryId))
                return new ResolvedMeta(null, categoryId);
        }

        return new ResolvedMeta(null, "other");
    }

    /// <summary>
    /// "What you can do" for an out-of-range result: the most specific guidance
    /// available — per-test directional, per-test generic, then the category's
    /// directional or generic default.
    /// </summary>
    public string? ComposeAdvice(TestInfo? info, string categoryId, string zone)
    {
        if (info is not null)
        {
            if (zone == "high" && !string.IsNullOrWhiteSpace(info.AdviceHigh)) return info.AdviceHigh;
            if (zone == "low" && !string.IsNullOrWhiteSpace(info.AdviceLow)) return info.AdviceLow;
            if (!string.IsNullOrWhiteSpace(info.Advice)) return info.Advice;
        }

        if (_adviceDir.TryGetValue(categoryId, out var dir))
        {
            if (zone == "high" && !string.IsNullOrWhiteSpace(dir.High)) return dir.High;
            if (zone == "low" && !string.IsNullOrWhiteSpace(dir.Low)) return dir.Low;
        }

        return _advice.GetValueOrDefault(categoryId);
    }

    /// <summary>Affirming note for an in-range result.</summary>
    public string? HealthyNote(TestInfo? info, string categoryId) =>
        !string.IsNullOrWhiteSpace(info?.AdviceOk) ? info!.AdviceOk : _adviceOk.GetValueOrDefault(categoryId);
}
