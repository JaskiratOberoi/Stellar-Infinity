namespace Infinity.Api.Reads;

/// <summary>
/// Lightweight report header for one exact SID — who and what a sample is,
/// without pulling any result rows.
/// </summary>
/// <param name="Sid">The LIS vial id.</param>
/// <param name="Pid">Patient master id.</param>
/// <param name="SampleDrawn">IST-offset instant; see Domain.NobleTime.</param>
public sealed record SampleHeader(
    string Sid,
    long Pid,
    string? PatientName,
    string? Sex,
    int? Age,
    string? AgeUnit,
    string? ClientCode,
    string? BusinessUnit,
    DateTimeOffset? SampleDrawn,
    DateTimeOffset? RegisteredAt,
    DateTimeOffset? LastModifiedAt,
    string? Status,
    string? BillNumber,
    string? ClinicalHistory);
