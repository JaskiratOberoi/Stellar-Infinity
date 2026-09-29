namespace Infinity.Api.Messaging;

/// <summary>
/// Deployment facts about WhatsApp sending, from configuration (compose). What
/// an admin can change lives in <see cref="WhatsAppSettings"/> instead.
/// </summary>
/// <remarks>
/// Staging and prod share one database, so these are what keep them apart:
/// <list type="bullet">
/// <item><c>WhatsApp__Instance</c> — 'prod' or 'staging'. It keys the queue
/// rows and the settings. Unset, the worker does nothing at all.</item>
/// <item><c>WhatsApp__AutoEnqueue</c> — only the instance with this true
/// looks for newly released visits. Prod only, so a visit is never queued by
/// two APIs.</item>
/// </list>
/// Any instance other than prod sends only to its allowlist (a setting), and
/// with an empty allowlist sends nothing: staging reads real patients.
/// </remarks>
public sealed class WhatsAppOptions(IConfiguration config)
{
    public string? Instance => config["WhatsApp:Instance"] is { Length: > 0 } s ? s.Trim().ToLowerInvariant() : null;

    public bool AutoEnqueue => string.Equals(config["WhatsApp:AutoEnqueue"], "true", StringComparison.OrdinalIgnoreCase);

    public bool IsProd => Instance == "prod";
}

/// <summary>Indian mobile numbers as WhatsApp wants them: 91 + ten digits.</summary>
public static class Phone
{
    /// <summary>
    /// 9812345678, 09812345678, +91 98123 45678, 919812345678 → 919812345678.
    /// Anything that is not an Indian mobile (starting 6–9) is null: a
    /// landline, a placeholder, a typo.
    /// </summary>
    public static string? Normalise(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return null;
        var d = new string(raw.Where(char.IsDigit).ToArray());
        if (d.Length == 12 && d.StartsWith("91", StringComparison.Ordinal)) d = d[2..];
        else if (d.Length == 11 && d[0] == '0') d = d[1..];
        if (d.Length != 10 || d[0] is < '6' or > '9') return null;
        // A run of one or two digits is a placeholder typed to get past the field.
        if (d.Distinct().Count() <= 2) return null;
        return "91" + d;
    }

    /// <summary>98xxxxxx78 — for lists and toasts, never the whole number.</summary>
    public static string Mask(string? phone)
    {
        if (string.IsNullOrEmpty(phone)) return string.Empty;
        var d = phone.Length == 12 ? phone[2..] : phone;
        return d.Length < 6 ? d : d[..2] + new string('x', d.Length - 4) + d[^2..];
    }
}
