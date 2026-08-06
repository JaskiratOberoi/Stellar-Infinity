using Microsoft.Extensions.Options;

namespace Infinity.Api.Worksheet;

/// <summary>
/// The unlock secret for auto-authorization, stored as a PBKDF2 hash.
///
/// The plaintext password is NOT in this repository and never was. What is
/// committed is a salted PBKDF2-HMAC-SHA256 digest, which cannot be reversed
/// into the password. Override it per environment with:
///
///     AutoAuth__UnlockHash=pbkdf2-sha256$&lt;iterations&gt;$&lt;b64 salt&gt;$&lt;b64 key&gt;
///
/// Rotate with the same helper that produced it:
///
///     dotnet run --project api/tools/HashPassword -- '&lt;new password&gt;'
///
/// This is deliberately NOT the pattern the legacy LIS uses. There, passwords
/// sit in cleartext in tbl_med_user_master.password, are echoed back into the
/// admin edit form, and are emailed to new users in the body of the welcome
/// message. Reproducing that for the one secret that governs releasing results
/// without human review would be indefensible.
/// </summary>
public sealed class AutoAuthOptions
{
    public const string SectionName = "AutoAuth";

    /// <summary>Encoded PBKDF2 digest. See the class remarks for the format.</summary>
    public string UnlockHash { get; set; } = "";

    /// <summary>
    /// Set false to disable the feature outright — every configuration change
    /// is refused regardless of password. A lab that never wants automatic
    /// release should turn this off rather than rely on every rule staying
    /// disabled.
    /// </summary>
    public bool Enabled { get; set; } = true;

    public IReadOnlyList<string> Validate()
    {
        var problems = new List<string>();

        if (string.IsNullOrWhiteSpace(UnlockHash))
        {
            problems.Add("AutoAuth__UnlockHash is not set.");
        }
        else if (!PasswordHash.IsWellFormed(UnlockHash))
        {
            problems.Add("AutoAuth__UnlockHash is not a valid pbkdf2-sha256 digest.");
        }

        return problems;
    }
}

/// <summary>
/// Gate in front of every auto-authorization configuration change.
///
/// Two independent checks must both pass: the caller holds autoauth:manage
/// (enforced as an endpoint filter, so it cannot be forgotten on a new route),
/// and they supply the unlock password. Neither alone is enough — the capability
/// says who may ask, the password says that this particular change was intended.
/// </summary>
public sealed class AutoAuthGate(
    IOptions<AutoAuthOptions> options,
    Infinity.Api.Caching.InfinityCache cache,
    ILogger<AutoAuthGate> logger)
{
    private readonly AutoAuthOptions _options = options.Value;

    /// <summary>
    /// How long a successful unlock is remembered. Generous because the
    /// session's own limits bite first — the SPA signs out after 45 minutes
    /// idle and the JWT expires at 8 hours — and because a grant that outlived
    /// its session would be harmless anyway: it is keyed to the session
    /// version, so revoking a user invalidates it.
    /// </summary>
    private static readonly TimeSpan GrantTtl = TimeSpan.FromHours(8);

    /// <summary>
    /// Keyed on session version as well as user, so an admin revoking a
    /// session (password reset, role change, deactivation) also drops any
    /// Jarvis grant that session had earned.
    /// </summary>
    private static string GrantKey(int userId, int sessionVersion) =>
        $"inf:jarvis:{userId}:{sessionVersion}";

    /// <summary>
    /// Record that this user has passed the password gate, so a page refresh
    /// does not ask again. The PASSWORD is never stored — only the fact that
    /// it was verified, server-side, where the client cannot forge it.
    /// </summary>
    public Task GrantAsync(int userId, int sessionVersion, CancellationToken ct = default) =>
        cache.SetAsync(GrantKey(userId, sessionVersion), "1", GrantTtl, ct);

    public async Task<bool> HasGrantAsync(int userId, int sessionVersion, CancellationToken ct = default)
    {
        if (!_options.Enabled) return false;
        return await cache.GetAsync(GrantKey(userId, sessionVersion), ct).ConfigureAwait(false) is not null;
    }

    /// <summary>Drop the grant — on sign-out, so the next sign-in re-locks.</summary>
    public Task RevokeAsync(int userId, int sessionVersion, CancellationToken ct = default) =>
        cache.RemoveAsync(GrantKey(userId, sessionVersion), ct);

    public bool FeatureEnabled => _options.Enabled;

    /// <summary>
    /// True when the supplied password matches. Never logs the attempt value,
    /// and never reports WHY it failed — a distinct "malformed" versus "wrong"
    /// response would tell a caller something about the stored secret.
    /// </summary>
    public bool Verify(string? password)
    {
        if (!_options.Enabled) return false;
        if (string.IsNullOrEmpty(password)) return false;

        if (!PasswordHash.IsWellFormed(_options.UnlockHash))
        {
            // Misconfiguration must fail CLOSED. Auto-authorization releasing
            // results without review is the one thing worse than an admin being
            // unable to change a setting.
            logger.LogError("autoauth.hash.malformed — refusing all unlock attempts");
            return false;
        }

        return PasswordHash.Verify(password, _options.UnlockHash);
    }
}
