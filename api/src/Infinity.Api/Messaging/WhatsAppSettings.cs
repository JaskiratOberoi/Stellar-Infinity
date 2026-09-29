using System.Data;
using System.Globalization;
using Infinity.Api.Data;
using Infinity.Api.Reads;

namespace Infinity.Api.Messaging;

/// <summary>
/// What an admin sets in Admin → WhatsApp, per instance (inf_wa_setting,
/// script 172). Everything starts OFF: nothing is sent until someone links a
/// number and switches sending on.
/// </summary>
public sealed record WhatsAppConfig(
    /// <summary>Master switch: nothing at all is sent while off, manual or automatic.</summary>
    bool Enabled,
    /// <summary>Send automatically when a visit is fully released (prod only; see WhatsAppOptions).</summary>
    bool Auto,
    /// <summary>Auto-send for every client's patients, not only the listed clients.</summary>
    bool AllClients,
    /// <summary>Only these numbers (91XXXXXXXXXX) receive anything. Required off prod.</summary>
    IReadOnlyList<string> Allowlist,
    /// <summary>The message that goes with the PDF. {name}, {pid} and {link} are filled in.</summary>
    string Caption,
    int MinGapSeconds,
    int MaxGapSeconds,
    int DailyCap,
    /// <summary>"21:00" — nothing sent from here…</summary>
    string QuietFrom,
    /// <summary>"08:00" — …to here (lab time). Queued messages wait.</summary>
    string QuietTo,
    /// <summary>When auto-send was last switched on (UTC): visits released before it are never auto-sent.</summary>
    DateTime? AutoSince)
{
    public const string DefaultCaption =
        "Hello {name} 👋\n\n"
        + "Greetings from *Noble Diagnostic Centre*! Your lab report is ready (PID {pid}). "
        + "The PDF is attached, and you can also view or download it anytime here:\n"
        + "{link}\n\n"
        + "Please share it with your doctor, who can interpret the results for you. Wishing you good health! 🌿\n\n"
        + "— Team Noble Diagnostics\n"
        + "_Reply STOP to stop receiving reports on WhatsApp._";

    public static readonly WhatsAppConfig Defaults = new(
        Enabled: false, Auto: false, AllClients: false, Allowlist: [], Caption: DefaultCaption,
        MinGapSeconds: 40, MaxGapSeconds: 120, DailyCap: 150, QuietFrom: "21:00", QuietTo: "08:00", AutoSince: null);

    /// <summary>Is <paramref name="nowLab"/> inside the quiet hours (which may run past midnight)?</summary>
    public bool IsQuiet(DateTime nowLab)
    {
        if (!TimeSpan.TryParse(QuietFrom, CultureInfo.InvariantCulture, out var from)
            || !TimeSpan.TryParse(QuietTo, CultureInfo.InvariantCulture, out var to) || from == to) return false;
        var t = nowLab.TimeOfDay;
        return from < to ? t >= from && t < to : t >= from || t < to;
    }
}

public sealed class WhatsAppSettings(NobleConnectionFactory db, SqlRetry retry, WhatsAppOptions options)
{
    private (DateTime At, WhatsAppConfig Config)? _cached;
    private static readonly TimeSpan Ttl = TimeSpan.FromSeconds(20);

    public async Task<WhatsAppConfig> GetAsync(CancellationToken ct = default)
    {
        if (_cached is { } c && DateTime.UtcNow - c.At < Ttl) return c.Config;
        var instance = options.Instance;
        if (instance is null) return WhatsAppConfig.Defaults;

        var map = await retry.ExecuteAsync("wa.settings.get", token =>
            db.QueryAsync("wa.settings.get", async (conn, inner) =>
            {
                await using var cmd = NobleConnectionFactory.CreateCommand(conn,
                    "SELECT [key], value FROM dbo.inf_wa_setting WHERE instance = @i");
                cmd.Parameters.Add("@i", SqlDbType.VarChar, 12).Value = instance;
                var m = new Dictionary<string, string>(StringComparer.Ordinal);
                await using var r = await cmd.ExecuteReaderAsync(inner).ConfigureAwait(false);
                while (await r.ReadAsync(inner).ConfigureAwait(false)) m[r.Str("key") ?? ""] = r.Str("value") ?? "";
                return m;
            }, token), ct).ConfigureAwait(false);

        var d = WhatsAppConfig.Defaults;
        bool B(string k, bool dflt) => map.TryGetValue(k, out var v) ? v == "1" : dflt;
        int I(string k, int dflt) => map.TryGetValue(k, out var v) && int.TryParse(v, CultureInfo.InvariantCulture, out var n) ? n : dflt;
        string S(string k, string dflt) => map.TryGetValue(k, out var v) && v.Length > 0 ? v : dflt;

        var config = new WhatsAppConfig(
            Enabled: B("enabled", d.Enabled),
            Auto: B("auto", d.Auto),
            AllClients: B("all_clients", d.AllClients),
            Allowlist: S("allowlist", "").Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries),
            Caption: S("caption", d.Caption),
            MinGapSeconds: I("min_gap_s", d.MinGapSeconds),
            MaxGapSeconds: I("max_gap_s", d.MaxGapSeconds),
            DailyCap: I("daily_cap", d.DailyCap),
            QuietFrom: S("quiet_from", d.QuietFrom),
            QuietTo: S("quiet_to", d.QuietTo),
            AutoSince: map.TryGetValue("auto_since", out var since)
                && DateTime.TryParse(since, CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out var s) ? s : null);
        _cached = (DateTime.UtcNow, config);
        return config;
    }

    /// <summary>Only these numbers may be messaged — and off prod, nothing at all without the list.</summary>
    public bool MaySendTo(WhatsAppConfig c, string phone) =>
        c.Allowlist.Count > 0 ? c.Allowlist.Contains(phone) : options.IsProd;

    public async Task SetAsync(IReadOnlyDictionary<string, string> values, int actor, CancellationToken ct = default)
    {
        var instance = options.Instance ?? throw new InvalidOperationException("WhatsApp__Instance is not configured.");
        await retry.ExecuteAsync("wa.settings.set", token =>
            db.QueryAsync("wa.settings.set", async (conn, inner) =>
            {
                foreach (var (k, v) in values)
                {
                    await using var cmd = NobleConnectionFactory.CreateCommand(conn, """
                        MERGE dbo.inf_wa_setting AS t USING (SELECT @i AS instance, @k AS [key]) AS s
                            ON t.instance = s.instance AND t.[key] = s.[key]
                        WHEN MATCHED THEN UPDATE SET value = @v, updated_by = @by, updated_at = SYSUTCDATETIME()
                        WHEN NOT MATCHED THEN INSERT (instance, [key], value, updated_by) VALUES (@i, @k, @v, @by);
                        """);
                    cmd.Parameters.Add("@i", SqlDbType.VarChar, 12).Value = instance;
                    cmd.Parameters.Add("@k", SqlDbType.NVarChar, 50).Value = k;
                    cmd.Parameters.Add("@v", SqlDbType.NVarChar, 2000).Value = v;
                    cmd.Parameters.Add("@by", SqlDbType.Int).Value = actor;
                    await cmd.ExecuteNonQueryAsync(inner).ConfigureAwait(false);
                }
                return 0;
            }, token), ct).ConfigureAwait(false);
        _cached = null;
    }
}
