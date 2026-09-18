namespace Infinity.Api.Orders;

/// <summary>
/// The filters on the accessioning queue — the legacy Accession page's own
/// (dates on the registration date, SID contains, patient name or mobile
/// contains) plus origin and the client's business unit. Every one optional:
/// the legacy forces a date window and that is precisely what hid a tube
/// registered a fortnight earlier from the technician holding it.
/// </summary>
public sealed record RegistrationFilter(
    DateOnly? From = null,
    DateOnly? To = null,
    string? Sid = null,
    string? Patient = null,
    /// <summary>lis | telo | infinity, or null for all.</summary>
    string? Origin = null,
    int? BusinessUnit = null);

/// <summary>What Register did with one SID: registered, or skipped (already
/// accessioned, rejected, or not found).</summary>
public sealed record AccessionDetail(string Vailid, string Outcome, int ResultRows);

public sealed record RejectDetail(string Vailid, string Outcome);

public sealed record RejectResult(
    bool Ok, string? ErrorCode, string? Message, int Rejected, int Skipped,
    IReadOnlyList<RejectDetail> Details);

public sealed record RejectReason(int Id, string Reason);
