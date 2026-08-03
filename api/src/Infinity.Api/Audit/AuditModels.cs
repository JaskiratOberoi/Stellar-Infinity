namespace Infinity.Api.Audit;

/// <summary>What happened to a result. Mirrors CK_inf_result_audit_action.</summary>
public static class ResultAction
{
    public const string Enter = "enter";
    public const string Amend = "amend";
    public const string Authorize = "authorize";
    public const string Unauthorize = "unauthorize";
    public const string Reopen = "reopen";
    public const string Reject = "reject";
    public const string Import = "import";

    /// <summary>
    /// Actions that overwrite or reverse clinical sign-off, and therefore
    /// require a reason. The database enforces this too — this is the check
    /// that produces a useful error instead of a constraint violation.
    /// </summary>
    public static bool RequiresReason(string action) => action is Amend or Reopen;
}

/// <summary>Which field changed. Mirrors CK_inf_result_audit_field.</summary>
public static class ResultField
{
    public const string Value = "value";
    public const string Auth = "auth";
    public const string Abnormal = "abnormal";
    public const string Comments = "comments";
    public const string Status = "status";
}

public static class AuditSource
{
    public const string Ui = "ui";
    public const string Instrument = "instrument";
    public const string Import = "import";
    public const string Api = "api";
}

public static class AuthEvent
{
    public const string Login = "login";
    public const string LoginFailed = "login_failed";
    public const string LoginBlocked = "login_blocked";
    public const string Logout = "logout";
    public const string PasswordChange = "password_change";
    public const string TokenRevoked = "token_revoked";
    public const string RoleChange = "role_change";
    public const string LisAccessChange = "lis_access_change";
    public const string ActiveChange = "active_change";

    /// <summary>Client-code access granted or revoked — see procedure 60.</summary>
    public const string ScopeChange = "scope_change";
    public const string ProfileChange = "profile_change";
    public const string UserCreated = "user_created";
}

/// <summary>
/// One field-level change to a result. Both values are carried — a trail that
/// records only the new value cannot answer the question it exists for.
/// </summary>
public sealed record ResultAuditEntry
{
    public int? ResultId { get; init; }
    public string? Vailid { get; init; }
    public int? PatientId { get; init; }
    public string? TestCode { get; init; }
    public required string Action { get; init; }
    public required string Field { get; init; }
    public string? OldValue { get; init; }
    public string? NewValue { get; init; }
    public string? Reason { get; init; }
    public string Source { get; init; } = AuditSource.Ui;
    public string? InstrumentId { get; init; }
}

/// <summary>Who did it and from where — resolved server-side, never client-supplied.</summary>
public sealed record AuditActor(int? UserId, string? Username, string? Ip, string? UserAgent);

public sealed record AuthAuditEntry
{
    public required string Event { get; init; }
    public int? ActorUserId { get; init; }
    public string? ActorUsername { get; init; }
    public int? TargetUserId { get; init; }
    public string? TargetUsername { get; init; }
    public bool Succeeded { get; init; } = true;
    public string? Detail { get; init; }
}
