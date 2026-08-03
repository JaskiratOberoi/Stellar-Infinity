using System.Text.Json.Serialization;

namespace Infinity.Api.Worksheet;

/// <summary>
/// One analyte row on the result-entry grid.
///
/// Both range representations are carried, and they are not redundant:
///
///   <see cref="NormalRange"/> is the display string FROZEN onto the result row
///   when it was created (Noble's testnormal_range). It is what the report
///   prints, and it must not change if the lab later edits its master ranges —
///   a report reissued years later has to show the range that was in force.
///
///   <see cref="RangeLow"/>/<see cref="RangeHigh"/> are the LIVE numeric bounds
///   for this patient's age and sex, used to flag high/low as the user types.
///
/// The UI may compute a flag from the live bounds for immediate feedback, but
/// that flag is advisory only. usp_inf_result_save recomputes it server-side and
/// ignores anything the client sends.
/// </summary>
public sealed record WorksheetResultRow(
    int ResultId,
    int? TestId,
    int? ParamId,
    string? TestCode,
    string? TestName,
    /// <summary>Test | Param | Head | Profile. Head and Profile are display scaffolding.</summary>
    string? TestType,
    string? Value,
    string? Unit,
    string? NormalRange,
    decimal? RangeLow,
    decimal? RangeHigh,
    bool Abnormal,
    bool Authorized,
    string? Comments,
    int? ProfileId,
    int? MasterProfileId,
    string? MachineName,
    string? EnteredBy,
    DateTimeOffset? EnteredAt,
    string? UpdatedBy,
    DateTimeOffset? UpdatedAt,
    bool HasAttachment,
    string? DepartmentCode,
    string? DepartmentName,
    int? DepartmentId,
    /// <summary>
    /// Options for a coded result, when the LIS defines them. Noble stores this
    /// list in a column called mobile_number — a repurposed VARCHAR(12) that
    /// truncates anything longer, which is a legacy data defect surfaced rather
    /// than hidden.
    /// </summary>
    IReadOnlyList<string> CodedOptions,
    /// <summary>Whether numeric bounds exist. A narrative can never be auto-authorized.</summary>
    bool IsNumericRange,
    /// <summary>Whether a configured rule would auto-authorize this row if in range.</summary>
    bool AutoAuthEligible);

public sealed record WorksheetSampleHeader(
    string Sid,
    int Pid,
    string? PatientName,
    string? Sex,
    int? Age,
    string? AgeUnit,
    string? ClientCode,
    string? ShortName,
    string? OrderNumber,
    string? BillNumber,
    DateTimeOffset? SampleDrawn,
    DateTimeOffset? RegisteredAt,
    DateTimeOffset? LastModifiedAt,
    int? StatusCode,
    string? Status,
    string? SampleComments,
    string? SampleClinicalHistory,
    string? PatientClinicalHistory,
    string? RejectComments,
    int? AuthorisedBy,
    string? AuthorisedByUsername,
    int? SignatureId,
    string? SignatoryName,
    string? SignatoryDesignation,
    /// <summary>False when the sample is rejected, authorized or printed.</summary>
    bool IsEditable,
    /// <summary>True when only a reopen (result:reopen) can make it editable again.</summary>
    bool NeedsReopen,
    bool IsRejected);

/// <summary>A rule that will auto-authorize part of this sample, shown up front.</summary>
public sealed record AutoAuthRuleInForce(
    string ScopeType,
    string ScopeKey,
    string? ScopeLabel,
    bool RequireInRange,
    bool AllowOutOfRange,
    bool NumericOnly);

public sealed record WorksheetSample(
    WorksheetSampleHeader Header,
    IReadOnlyList<WorksheetResultRow> Rows,
    IReadOnlyList<AutoAuthRuleInForce> AutoAuthRules);

/// <summary>
/// One edit posted from the grid.
///
/// The null-versus-empty distinction is load-bearing and is preserved all the
/// way into the table type: <c>null</c> means "not touched", <c>""</c> means
/// "clear it". A grid save posts every visible row, so collapsing the two would
/// let an untouched row wipe a value someone else entered since the page loaded.
///
/// There is deliberately no Abnormal field. The flag is derived server-side.
/// </summary>
public sealed record ResultEdit(
    int ResultId,
    string? Value,
    string? Comments,
    bool? SetAuth,
    string? Reason);

public sealed record SaveResultsRequest(
    IReadOnlyList<ResultEdit> Edits,
    string? SampleComments,
    string? SampleClinicalHistory);

public sealed record SaveResultsOutcome(
    int Applied,
    int AutoAuthorized,
    int? StatusBefore,
    int? StatusAfter);

public sealed record ReopenRequest(string Reason);

public sealed record ResultAuditRow(
    long Id,
    int? ResultId,
    string? TestName,
    string? TestCode,
    string Action,
    string? Field,
    string? OldValue,
    string? NewValue,
    string? Reason,
    string? ActorUsername,
    string? ActorIp,
    string Source,
    DateTimeOffset OccurredAt);

/* ---- auto-authorization configuration ---- */

public sealed record AutoAuthScopeRow(
    string ScopeType,
    string ScopeKey,
    string? Label,
    string? DepartmentName,
    bool Enabled,
    bool RequireInRange,
    bool AllowOutOfRange,
    bool NumericOnly,
    DateTimeOffset? UpdatedAt,
    string? UpdatedByUsername);

/// <summary>
/// A request to change one auto-authorization rule.
///
/// <see cref="Password"/> is the shared unlock secret, verified against a PBKDF2
/// hash before anything is written. It is never logged, never sent to the
/// database, and never returned. It is a second factor on top of the
/// autoauth:manage capability, not a substitute for it.
/// </summary>
public sealed record SetAutoAuthRequest(
    string ScopeType,
    string ScopeKey,
    string? ScopeLabel,
    bool Enabled,
    bool RequireInRange,
    bool AllowOutOfRange,
    [property: JsonPropertyName("password")] string Password);

public sealed record AutoAuthAuditRow(
    long Id,
    string Action,
    string? ScopeType,
    string? ScopeKey,
    string? ScopeLabel,
    bool? OldEnabled,
    bool? NewEnabled,
    string? Detail,
    string? ActorUsername,
    string? ActorIp,
    DateTimeOffset OccurredAt);
