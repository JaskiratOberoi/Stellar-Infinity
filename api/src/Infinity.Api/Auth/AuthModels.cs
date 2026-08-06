using System.ComponentModel.DataAnnotations;

namespace Infinity.Api.Auth;

/// <summary>
/// Login credentials. Never log an instance of this — Noble stores passwords in
/// plaintext, so a logged request body is a credential dump.
/// </summary>
public sealed record LoginRequest
{
    [Required, StringLength(50, MinimumLength = 1)]
    public string Username { get; init; } = "";

    [Required, StringLength(50, MinimumLength = 1)]
    public string Password { get; init; } = "";

    public override string ToString() => $"LoginRequest {{ Username = {Username}, Password = *** }}";
}

/// <summary>One row from dbo.usp_inf_authenticate.</summary>
public sealed record AuthRow(
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
    string? InfinityRole,
    bool IsInfinityManaged,
    bool IsTeloManaged,
    bool LisAccess,
    int SessionVersion);

/// <summary>What the caller gets back after a successful login.</summary>
/// <summary>
/// No access token: it is delivered as an httpOnly cookie the browser cannot
/// read. Only the expiry and the user are returned, so the SPA can show who is
/// signed in and when the session lapses.
/// </summary>
public sealed record LoginResponse(    DateTimeOffset ExpiresAt,
    AuthenticatedUser User);

public sealed record AuthenticatedUser(
    int UserId,
    string Username,
    string? DisplayName,
    string? Email,
    string Role,
    IReadOnlyCollection<string> Capabilities,
    int? UsertypeId,
    string? UsertypeName,
    /// <summary>Which system manages this account: infinity | telo | lis.</summary>
    string ManagedBy,
    /// <summary>Whether these same credentials also work on the legacy LIS.</summary>
    bool LisAccess);

/// <summary>Standard shape returned by every usp_inf_admin_* procedure.</summary>
public sealed record SpResult(bool Ok, string? ErrorCode, string? Message, int? UserId = null)
{
    public static SpResult Success(int? userId = null) => new(true, null, null, userId);
}
