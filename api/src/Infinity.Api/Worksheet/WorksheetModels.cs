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
    bool IsRejected,
    // The four fields Listec's worksheet header carries that this one did not.
    // Defaulted so the positional constructor keeps compiling for any caller
    // that builds a header without them.
    /// <summary>Salutation (Mr/Mrs/…), stored apart from the name.</summary>
    string? Title = null,
    /// <summary>Master row's name, or the free-text fallback when unmatched.</summary>
    string? ReferringDoctor = null,
    /// <summary>Master row's name, or the free-text fallback when unmatched.</summary>
    string? ReferringCustomer = null,
    /// <summary>Specimen, e.g. "WB - EDTA".</summary>
    string? SampleType = null);

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
/// <see cref="Abnormal"/> is the one deliberate exception to "the flag is
/// derived server-side": it is the operator's manual mark for results the
/// derivation cannot judge — a qualitative value, or a test with no resolved
/// numeric range. The procedure honours it ONLY there; for a range-checkable
/// result the arithmetic stays authoritative and this field is ignored.
/// </summary>
public sealed record ResultEdit(
    int ResultId,
    string? Value,
    string? Comments,
    bool? SetAuth,
    string? Reason,
    bool? Abnormal = null);

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

/// <summary>
/// The worksheet's "Edit patient info" form.
///
/// Null means "leave alone" and empty string means "clear it", all the way down
/// to the procedure — see PatientInfoEdit. Name is the one field that may not
/// be cleared, and the endpoint rejects a blank one rather than letting the
/// convention erase it.
/// </summary>
public sealed record UpdatePatientRequest(
    string? Title,
    string? Name,
    int? Age,
    int? AgeType,
    int? Gender,
    int? RefDoctor,
    string? RefDoctorOther,
    int? RefCustomer,
    string? RefCustomerOther,
    string? Mobile,
    string? Email,
    DateTime? SampleTime,
    string? ClinicalHistory);

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
    /// <summary>Context only — the department is a property of the test, not a scope.</summary>
    string? DepartmentName,
    /// <summary>Which lab this rule governs. NULL means every unit.</summary>
    int? BusinessUnitId,
    string? BusinessUnitName,
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
    /// <summary>
    /// The lab this rule applies to. NULL is the blanket "every unit" rule; a
    /// unit-specific rule overrides it for that unit only, so a test can be
    /// automatic at the main lab and manual at a satellite.
    /// </summary>
    int? BusinessUnitId,
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
    int? BusinessUnitId,
    string? BusinessUnitName,
    bool? OldEnabled,
    bool? NewEnabled,
    string? Detail,
    string? ActorUsername,
    string? ActorIp,
    DateTimeOffset OccurredAt);

/// <summary>A lab an auto-authorisation rule can be scoped to.</summary>
public sealed record BusinessUnitRow(int Id, string? Code, string? Name);

/// <summary>
/// A bare password check, used to unlock the settings screen before any rule
/// is shown. Separate from <see cref="SetAutoAuthRequest"/> because the gate
/// runs before the operator has chosen anything to change.
/// </summary>
public sealed record AutoAuthUnlockRequest(
    [property: JsonPropertyName("password")] string Password);
