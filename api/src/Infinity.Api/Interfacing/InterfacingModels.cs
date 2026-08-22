namespace Infinity.Api.Interfacing;

/* ---- the wire contract: what a Synapse agent POSTs to /api/interfacing/report ---- */

/// <summary>
/// One status report from a remote lab's Stellar Synapse middleware.
///
/// Deliberately tolerant: every field the agent might omit is nullable, and
/// over-length strings are truncated to column width rather than rejected — a
/// monitoring channel that refuses a report because a lab typed a long address
/// into its config is a monitoring channel that goes dark exactly when someone
/// is fiddling with that config.
/// </summary>
public sealed record SiteReport
{
    public string? AgentVersion { get; init; }
    public DateTimeOffset? ReportedAt { get; init; }
    public string? LabName { get; init; }
    public string? LabLocation { get; init; }
    public IReadOnlyList<ReportedInstrument>? Instruments { get; init; }
}

public sealed record ReportedInstrument
{
    /// <summary>The agent's own stable id for the instrument. A row without one is skipped.</summary>
    public string? Key { get; init; }
    public string? Name { get; init; }
    public string? DriverId { get; init; }
    public string? Protocol { get; init; }
    /// <summary>tcp-client | tcp-server | serial</summary>
    public string? Transport { get; init; }
    public string? Address { get; init; }
    public bool Enabled { get; init; } = true;
    /// <summary>online | offline | listening | error | connecting</summary>
    public string? Status { get; init; }
    public DateTimeOffset? StatusSince { get; init; }
    public DateTimeOffset? LastMessageAt { get; init; }
    public int MessagesReceived { get; init; }
    public int ResultsProcessed { get; init; }
    public int ResultParamsProcessed { get; init; }
    public int Errors { get; init; }
    /// <summary>Per-day throughput slices, "yyyy-MM-dd" dates. At most 31 are stored.</summary>
    public IReadOnlyList<ReportedDay>? Days { get; init; }
}

public sealed record ReportedDay(string? Date, int Samples, int Results, int Errors);

/* ---- site registry ---- */

public sealed record LabSite(
    int Id,
    string Code,
    string Name,
    string? Location,
    int? BusinessUnitId,
    string? BusinessUnitName,
    string? ApiKeyHint,
    bool IsActive,
    string? AgentVersion,
    string? LabName,
    string? LabLocation,
    DateTimeOffset? CreatedAt,
    DateTimeOffset? LastSeenAt,
    int InstrumentCount);

public sealed record UpsertSiteRequest(
    int? Id,
    string Code,
    string Name,
    string? Location,
    int? BusinessUnitId,
    bool IsActive = true,
    /// <summary>Mint a fresh key for an EXISTING site. A new site always gets one.</summary>
    bool RotateKey = false);

/// <param name="ApiKey">
/// The plaintext key, present ONLY when one was just minted (create or rotate).
/// It is never stored and never shown again — only its hash survives.
/// </param>
public sealed record UpsertSiteOutcome(bool Ok, string? ErrorCode, string? Message, LabSite? Site, string? ApiKey);

public sealed record SiteBusinessUnit(int Id, string? Code, string? Name);

/* ---- overview ---- */

/// <summary>
/// kind: disconnected | stuck-connecting | stale.
/// since: when the condition started, where the agent told us.
/// </summary>
public sealed record InstrumentAlert(string Kind, DateTimeOffset? Since);

public sealed record SiteInstrument(
    string Key,
    string? Name,
    string? DriverId,
    string? Protocol,
    string? Transport,
    string? Address,
    bool Enabled,
    string Status,
    DateTimeOffset? StatusSince,
    DateTimeOffset? LastMessageAt,
    int MessagesReceived,
    int ResultsProcessed,
    int ResultParamsProcessed,
    int Errors,
    int TodaySamples,
    int TodayResults,
    int TodayErrors,
    DateTimeOffset? UpdatedAt,
    InstrumentAlert? Alert);

public sealed record SiteOverview(
    int Id,
    string Code,
    string Name,
    string? Location,
    int? BusinessUnitId,
    string? BusinessUnitName,
    bool IsActive,
    /// <summary>The agent reported within the freshness window and the site is active.</summary>
    bool Online,
    DateTimeOffset? LastSeenAt,
    string? AgentVersion,
    string? LabName,
    string? LabLocation,
    IReadOnlyList<SiteInstrument> Instruments);

/// <summary>One alert, flattened with its site for the banner strip.</summary>
public sealed record InterfacingAlert(
    int SiteId,
    string SiteCode,
    string SiteName,
    string InstrumentKey,
    string? InstrumentName,
    string Kind,
    DateTimeOffset? Since);

public sealed record InterfacingOverview(
    IReadOnlyList<SiteOverview> Sites,
    IReadOnlyList<InterfacingAlert> Alerts);

/* ---- daily throughput ---- */

public sealed record InterfacingDailyRow(
    int SiteId,
    string Code,
    string Name,
    string InstrumentKey,
    string? InstrumentName,
    /// <summary>yyyy-MM-dd</summary>
    string Day,
    int Samples,
    int Results,
    int Errors);

/* ---- interfaced vs manual, from the LIS result table ---- */

public sealed record ResultSourceRow(
    /// <summary>yyyy-MM-dd — the sample's registration day, see script 126.</summary>
    string Day,
    int? BusinessUnitId,
    string? BusinessUnitCode,
    string? BusinessUnitName,
    /// <summary>NULL for manual entries; 'IMPORT' or the machine name otherwise.</summary>
    string? MachineName,
    /// <summary>manual | interfaced</summary>
    string EntryMode,
    long ResultCount);
