namespace Stellar.Sync;

/// <summary>
/// The Noble → stellar value translations, in one place.
///
/// Every one of these exists because Noble encodes something as a magic number
/// or an ambiguous string, and the decode ring currently lives in application
/// code — reimplemented in Telo, in Infinity, in LISTEC, and in every report.
/// The whole point of the replica is that the translation happens ONCE, here,
/// on the way in.
/// </summary>
internal static class Conv
{
    /// <summary>Noble: 1 = male, 2 = female. Anything else is not a claim.</summary>
    public static string Sex(object? v) => ToInt(v) switch
    {
        1 => "male",
        2 => "female",
        _ => "unknown",
    };

    /// <summary>Noble: 1 = years, 2 = months, 3 = days.</summary>
    public static string? AgeUnit(object? v) => ToInt(v) switch
    {
        1 => "years",
        2 => "months",
        3 => "days",
        _ => null,
    };

    /// <summary>
    /// Noble's naive DATETIME columns are IST wall-clock with no offset. Read
    /// as Unspecified by the driver, so stamping them UTC would shift every
    /// timestamp back 5h30m — the same bug that once made the dashboard render
    /// yesterday. Attach +05:30 explicitly, then let Npgsql store UTC.
    /// </summary>
    private static readonly TimeSpan Ist = TimeSpan.FromMinutes(330);

    public static DateTimeOffset? Ts(object? v)
    {
        if (v is not DateTime dt) return null;
        // SQL Server's datetime low value is a placeholder for "unset" in this
        // schema, not a real 1900 event.
        if (dt.Year <= 1900) return null;

        // Interpret as IST, then hand over as UTC. Both halves matter:
        // attaching +05:30 is what stops the value shifting by 5h30m, and
        // Npgsql then REFUSES a non-zero offset outright ("only offset 0 (UTC)
        // is supported") because timestamptz has no notion of the offset it was
        // written with. Converting preserves the instant exactly and lets
        // Postgres store what it was always going to store.
        return new DateTimeOffset(DateTime.SpecifyKind(dt, DateTimeKind.Unspecified), Ist)
            .ToUniversalTime();
    }

    public static int? ToInt(object? v) => v switch
    {
        null => null,
        int i => i,
        short s => s,
        byte b => b,
        long l => (int)l,
        decimal d => (int)d,
        bool bo => bo ? 1 : 0,
        string s when int.TryParse(s, out var p) => p,
        _ => null,
    };

    public static decimal? Money(object? v) => v switch
    {
        null => null,
        decimal d => d,
        int i => i,
        long l => l,
        double db => (decimal)db,
        string s when decimal.TryParse(s, out var p) => p,
        _ => null,
    };

    public static bool Flag(object? v) => v switch
    {
        bool b => b,
        int i => i != 0,
        _ => false,
    };

    /// <summary>
    /// Trimmed, with empty collapsed to null.
    ///
    /// Noble is full of columns where '' and NULL both occur and mean the same
    /// thing. Preserving the distinction into the replica would mean every
    /// consumer keeps writing NULLIF(LTRIM(RTRIM(x)), '') forever.
    /// </summary>
    public static string? Text(object? v)
    {
        var s = v?.ToString()?.Trim();
        return string.IsNullOrEmpty(s) ? null : s;
    }

    /// <summary>
    /// Which system wrote a Noble row, from its addedby/updatedby marker.
    /// 'telo:&lt;uid&gt;' and 'inf:&lt;uid&gt;' are the convention Telo and
    /// Infinity stamp; anything else came from the legacy LIS.
    /// </summary>
    public static string Origin(object? addedBy)
    {
        var s = addedBy?.ToString();
        if (string.IsNullOrWhiteSpace(s)) return "listec";
        if (s.StartsWith("telo:", StringComparison.OrdinalIgnoreCase)) return "telo";
        if (s.StartsWith("inf:", StringComparison.OrdinalIgnoreCase)) return "infinity";
        if (s.StartsWith("inst:", StringComparison.OrdinalIgnoreCase)) return "instrument";
        return "listec";
    }
}
