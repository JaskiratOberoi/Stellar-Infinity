namespace Infinity.Api.Instruments;

/// <summary>
/// One normalised reading, as a driver posts it.
///
/// Deliberately protocol-free. Analysers speak ASTM E1381/E1394 or HL7 v2 over
/// serial or MLLP; that framing belongs in a small worker per instrument, not
/// in the API. Keeping the boundary here means adding an analyser is a new
/// driver rather than an API change, and the API stays testable with a JSON
/// body instead of a serial port.
/// </summary>
public sealed record InstrumentReading
{
    public required string Sid { get; init; }
    public required string TestCode { get; init; }
    public required string Value { get; init; }
    public string? Unit { get; init; }
    /// <summary>Analyser flags verbatim (H/L/*, etc.) — recorded, never interpreted as authorisation.</summary>
    public string? Flags { get; init; }
    public DateTimeOffset? MeasuredAt { get; init; }
    /// <summary>Analyser's own run/sequence id, used for duplicate detection.</summary>
    public string? SequenceNo { get; init; }
}

public sealed record IngestOutcome(long InboxId, string MatchStatus, string? FailureReason, int? ResultId);

public sealed record IngestResponse(int Accepted, int Applied, int Unmatched, IReadOnlyList<IngestOutcome> Results);

public sealed record Instrument(
    int Id,
    string Code,
    string Name,
    int? DepartmentId,
    bool IsActive,
    string? ApiKeyHint,
    DateTimeOffset? CreatedAt,
    DateTimeOffset? LastSeenAt,
    int Pending,
    int Applied24H);

public sealed record InboxMessage(
    long Id,
    int InstrumentId,
    string? InstrumentCode,
    string? Sid,
    string? TestCode,
    string? Value,
    string? Unit,
    string? Flags,
    DateTimeOffset? MeasuredAt,
    string? SequenceNo,
    string ParseStatus,
    string MatchStatus,
    string? FailureReason,
    int? ResultId,
    DateTimeOffset ReceivedAt,
    DateTimeOffset? AppliedAt,
    int Attempts);

public sealed record InboxPage(IReadOnlyList<InboxMessage> Messages, int TotalCount);

/// <summary>
/// Outcome of registering or updating an instrument. A dedicated type rather
/// than the shared SpResult, whose <c>UserId</c> field would have to carry an
/// instrument id — correct at runtime, misleading to read.
/// </summary>
public sealed record UpsertInstrumentResult(bool Ok, string? ErrorCode, string? Message, int? InstrumentId);

public sealed record UpsertInstrumentRequest(
    string Code,
    string Name,
    int? DepartmentId,
    bool IsActive = true,
    /// <summary>Supply only to set or rotate the key; omit to leave it unchanged.</summary>
    string? ApiKey = null);
