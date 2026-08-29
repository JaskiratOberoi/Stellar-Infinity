namespace Infinity.Api.Admin;

/// <summary>A client code the user can reach through an explicit mapping.</summary>
public sealed record MappedClientCode(
    int MccId,
    string? ClientCode,
    string? ClientName,
    string? AddedBy,
    DateTimeOffset? AddedAt,
    /// <summary>False for mappings the legacy LIS created — worth a warning before removal.</summary>
    bool AddedByInfinity);

/// <summary>
/// A centre the user reaches implicitly through their own PCC_Id / sub_pcc_id,
/// with no mapping row. Shown separately so an admin does not mistake an empty
/// mapping list for "no access" and add a redundant grant.
/// </summary>
public sealed record OwnCentre(int MccId, string? ClientCode, string? ClientName, string Source);

public sealed record AdminUserDetail(
    int UserId,
    string Username,
    string? FirstName,
    string? LastName,
    string? Email,
    int? UsertypeId,
    string? UsertypeName,
    int? PccId,
    int? SubPccId,
    int? BusinessUnitId,
    bool LisIsActive,
    string ManagedBy,
    bool? InfinityActive,
    bool? InfinityLisAccess,
    string? InfinityRole,
    string EffectiveRole,
    IReadOnlyCollection<string> EffectiveCapabilities,
    int SessionVersion,
    /// <summary>Legacy per-usertype bits from the LIS, read-only context for the admin.</summary>
    LisSecurityBits LisSecurity,
    /// <summary>
    /// Capabilities granted to THIS USER individually, on top of their role.
    ///
    /// Separate from EffectiveCapabilities on purpose: that set cannot answer
    /// "is the walk-in toggle on", because an admin holds order:b2c from their
    /// role and a client only ever holds it as a grant. The panel needs the
    /// grant, not the effect.
    /// </summary>
    IReadOnlyList<string> CapabilityGrants,
    IReadOnlyList<MappedClientCode> ClientCodes,
    IReadOnlyList<OwnCentre> OwnCentres);

public sealed record LisSecurityBits(bool Auth, bool ResultEntry, bool EditPatientTests, bool Discount);

/// <summary>
/// A centre's balance-lock posture, for the settings panel: whether it is
/// permanently unlocked, on a live temporary unlock (and until when), and where
/// its wallet sits against its credit floor. Read alongside the user's own
/// centres so an admin can grant relief without leaving the account they are on.
/// </summary>
public sealed record CentreLockState(
    int MccId,
    string? Code,
    string? Name,
    bool Permanent,
    int? CreditLimit,
    decimal? CurrentBalance,
    DateTimeOffset? TempExpire);

public sealed record ClientCodeOption(int MccId, string ClientCode, string? ClientName, bool AlreadyMapped);

public sealed record SetClientCodesResult(bool Ok, string? ErrorCode, string? Message, int Added, int Removed)
{
    public IReadOnlyList<ClientCodeChange> Changes { get; init; } = [];
}

public sealed record ClientCodeChange(string Change, int MccId, string? ClientCode, string? PriorOwner);

public sealed record UpdateProfileRequest(string FirstName, string? LastName, string? Email);
