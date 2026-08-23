namespace Infinity.Api.Orders;

/// <summary>
/// Manual-discount policy for B2C (walk-in) orders, ported from Telo's
/// lib/discountPolicy.ts and lib/gold-card.ts so the two counters enforce the
/// SAME contract. This copy is the authoritative gate; the SPA carries a
/// mirror (web/src/lib/discountPolicy.ts) so the operator sees the ceiling
/// while typing instead of at submit.
///
/// Default ceiling 20% of the bill. MDCARE / MEDICARE are contractually
/// capped at 10%, and for them a set of floor-priced tests takes no discount
/// at all: their line value drops out of the discountable base, so the cap is
/// a % of the OTHER lines only. Custom (external) lines stay discountable.
/// An order made up entirely of excluded tests allows no discount.
/// </summary>
public static class DiscountPolicy
{
    public const decimal DefaultCapPct = 0.20m;

    private static readonly Dictionary<string, decimal> ClientCapPct =
        new(StringComparer.OrdinalIgnoreCase)
        {
            ["MDCARE"] = 0.10m,
            ["MEDICARE"] = 0.10m,
        };

    private static readonly HashSet<string> NonDiscountableCodes =
        new(StringComparer.OrdinalIgnoreCase)
        {
            "HE011", // Complete Blood Count (CBC)
            "BI114", // Glucose - Fasting
            "BI116", // Glucose - Random
            "BI115", // Glucose - Post Prandial (PP)
            "HE017", // Erythrocyte Sedimentation Rate (ESR)
            "CP004", // Complete Urine Examination
            "BI221", // TSH
            "BI034", // Anti-Mullerian Hormone (AMH)
            "BI181", // PSA (Prostate Specific Antigen) Total
            "HE021", // Hemoglobin
            "HE006", // Blood Grouping and Typing (ABO and Rh)
            "BI089", // Creatinine
            "BI224", // Urea
            "BI227", // Uric acid
            "BI209", // Testosterone - Total
        };

    private static readonly HashSet<string> ExclusionClients =
        new(StringComparer.OrdinalIgnoreCase) { "MDCARE", "MEDICARE" };

    public static decimal CapPct(string? clientCode) =>
        clientCode is not null && ClientCapPct.TryGetValue(clientCode.Trim(), out var pct)
            ? pct
            : DefaultCapPct;

    /// <summary>Whole-number percent (10, 20) for messages.</summary>
    public static int CapLabel(string? clientCode) =>
        (int)Math.Round(CapPct(clientCode) * 100);

    public static bool HasExclusions(string? clientCode) =>
        clientCode is not null && ExclusionClients.Contains(clientCode.Trim());

    public static bool IsNonDiscountable(string? clientCode, string? testCode) =>
        HasExclusions(clientCode)
        && testCode is not null
        && NonDiscountableCodes.Contains(testCode.Trim());

    /// <summary>
    /// <paramref name="total"/> minus the value of any non-discountable lines
    /// for this client. Never negative.
    /// </summary>
    public static int DiscountableTotal(
        string? clientCode,
        IEnumerable<(string? Code, int Amount)> lines,
        int total)
    {
        if (!HasExclusions(clientCode)) return total;
        var excluded = 0;
        foreach (var (code, amount) in lines)
        {
            if (code is not null && NonDiscountableCodes.Contains(code.Trim()))
                excluded += amount;
        }
        return Math.Max(0, total - excluded);
    }

    // ── Gold Card details — same leniency as Telo's lib/gold-card.ts ───────
    // Lenient on format (the exact card scheme is not known here) but rejects
    // trivially-fake entries like "1" or "x", so the 50% benefit cannot be
    // claimed without a plausible card and name.

    public static bool IsValidGoldCardNumber(string? raw)
    {
        var v = (raw ?? "").Trim();
        return v.Length >= 4
            && System.Text.RegularExpressions.Regex.IsMatch(v, "^[A-Za-z0-9][A-Za-z0-9 -]*$");
    }

    public static bool IsValidGoldCardHolder(string? raw)
    {
        var v = (raw ?? "").Trim();
        return v.Length >= 3 && v.Any(char.IsLetter);
    }
}
