using System.Security.Cryptography;

namespace Infinity.Api.Auth;

public sealed class AuthCookieOptions
{
    public const string SectionName = "AuthCookie";

    /// <summary>Holds the JWT. httpOnly — script can never read it.</summary>
    public string TokenCookieName { get; set; } = "inf_session";

    /// <summary>
    /// The double-submit CSRF token. Deliberately NOT httpOnly: the SPA has to
    /// read it to echo it back in a header, and that is the whole mechanism —
    /// a cross-site attacker can cause the browser to SEND our cookies, but
    /// cannot read them to copy the value into a header.
    /// </summary>
    public string CsrfCookieName { get; set; } = "inf_csrf";

    /// <summary>The header the SPA echoes the CSRF token in.</summary>
    public const string CsrfHeaderName = "X-CSRF-Token";

    /// <summary>
    /// A marker the SPA can read to know a session probably exists, so it can
    /// show its restoring state rather than flashing the login screen. Carries
    /// no authority whatsoever — forging it gets you a failed /me call.
    /// </summary>
    public string PresenceCookieName { get; set; } = "inf_present";

    /// <summary>
    /// Secure attribute. MUST be true wherever TLS terminates in front of this.
    /// Configurable only because the compose stack currently serves plain HTTP
    /// on a loopback port, and a Secure cookie is silently dropped there —
    /// which would lock everyone out rather than degrade.
    /// </summary>
    public bool Secure { get; set; } = true;

    /// <summary>
    /// Strict is right for this app: there is no cross-site flow that needs to
    /// arrive already authenticated — no OAuth callback, no third-party embed,
    /// no email deep link that must land signed in. Lax would permit top-level
    /// GET navigations to carry the cookie; Strict declines even that.
    /// </summary>
    public string SameSite { get; set; } = "Strict";

    public SameSiteMode SameSiteMode() => SameSite.ToLowerInvariant() switch
    {
        "lax" => Microsoft.AspNetCore.Http.SameSiteMode.Lax,
        "none" => Microsoft.AspNetCore.Http.SameSiteMode.None,
        _ => Microsoft.AspNetCore.Http.SameSiteMode.Strict,
    };
}

/// <summary>
/// Writes and clears the session cookies.
///
/// WHY THE TOKEN MOVED OUT OF localStorage. A bearer token in web storage is
/// readable by any script that runs on the page, so a single XSS defect hands
/// an attacker a working session for its full lifetime. An httpOnly cookie is
/// not reachable from script at all: the same XSS can still ACT as the user
/// while the page is open, but it cannot exfiltrate the credential and use it
/// later from somewhere else. For an application holding patient results, that
/// difference is worth the CSRF machinery it costs.
///
/// The cost is real and is paid here: cookies ride along automatically on
/// cross-site requests, so every state-changing call now has to prove it came
/// from our own page. See <see cref="CsrfProtection"/>.
/// </summary>
public static class AuthCookies
{
    public static string NewCsrfToken() =>
        Convert.ToHexString(RandomNumberGenerator.GetBytes(32));

    public static void Issue(
        HttpResponse response,
        AuthCookieOptions options,
        string token,
        string csrfToken,
        DateTimeOffset expiresAt)
    {
        var sameSite = options.SameSiteMode();

        // Session cookies (no Expires) on purpose: the browser drops them when
        // it closes, which reinforces the SPA's own last-tab rule rather than
        // leaving a credential on disk for a shared workstation's next user.
        response.Cookies.Append(options.TokenCookieName, token, new CookieOptions
        {
            HttpOnly = true,
            Secure = options.Secure,
            SameSite = sameSite,
            Path = "/",
            IsEssential = true,
        });

        response.Cookies.Append(options.CsrfCookieName, csrfToken, new CookieOptions
        {
            HttpOnly = false,        // the SPA must read this one — see the docs above
            Secure = options.Secure,
            SameSite = sameSite,
            Path = "/",
            IsEssential = true,
        });

        response.Cookies.Append(options.PresenceCookieName, expiresAt.ToUnixTimeSeconds().ToString(), new CookieOptions
        {
            HttpOnly = false,
            Secure = options.Secure,
            SameSite = sameSite,
            Path = "/",
            IsEssential = true,
        });
    }

    public static void Clear(HttpResponse response, AuthCookieOptions options)
    {
        // Deletion attributes must match the ones the cookie was SET with —
        // path, domain, secure and same-site all take part in identifying it.
        // Mismatch and the browser keeps the original and the user stays signed
        // in. CookieOptions is a plain class, not a record, so each variant is
        // built explicitly rather than with `with`.
        CookieOptions Opts(bool httpOnly) => new()
        {
            HttpOnly = httpOnly,
            Secure = options.Secure,
            SameSite = options.SameSiteMode(),
            Path = "/",
        };

        response.Cookies.Delete(options.TokenCookieName, Opts(true));
        response.Cookies.Delete(options.CsrfCookieName, Opts(false));
        response.Cookies.Delete(options.PresenceCookieName, Opts(false));
    }
}
