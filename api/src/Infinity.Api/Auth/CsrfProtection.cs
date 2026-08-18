using System.Security.Cryptography;
using System.Text;
using Microsoft.Extensions.Options;

namespace Infinity.Api.Auth;

/// <summary>
/// Double-submit CSRF check for cookie-authenticated writes.
///
/// THE PROBLEM COOKIES CREATE. A bearer token in a header is only ever sent by
/// code that deliberately attaches it. A cookie is sent by the browser on every
/// request to this origin, including one triggered by a form on someone else's
/// site. Moving the JWT into a cookie therefore buys XSS resistance and hands
/// back CSRF exposure, and that trade is only worth making if the second half
/// is actually closed.
///
/// THE CHECK. On login the API sets two cookies: the httpOnly session, and a
/// random CSRF token that IS readable by script. The SPA reads the second and
/// echoes it in a header. An attacker's page can make the browser send our
/// cookies, but the same-origin policy stops it reading them — so it cannot
/// produce the header, and the values will not match.
///
/// SameSite=Strict already blocks the classic cases; this is the second layer,
/// for the ones it does not (a same-site subdomain compromise, a browser that
/// mishandles the attribute, a future need to relax it).
///
/// WHAT IS EXEMPT, AND WHY:
///   • Safe methods (GET/HEAD/OPTIONS) — they must not change state anyway.
///   • Login — there is no session to forge yet, and it issues the token pair.
///   • Requests authenticated by a BEARER header — an attacker's page cannot
///     set that header cross-origin, so it carries its own proof of intent.
///     This is what keeps instrument drivers and scripts working unchanged.
/// </summary>
public sealed class CsrfProtection(RequestDelegate next, IOptions<AuthCookieOptions> options)
{
    private readonly AuthCookieOptions _options = options.Value;

    private static readonly HashSet<string> SafeMethods =
        new(StringComparer.OrdinalIgnoreCase) { "GET", "HEAD", "OPTIONS", "TRACE" };

    public async Task InvokeAsync(HttpContext context)
    {
        if (!RequiresCheck(context))
        {
            await next(context);
            return;
        }

        var cookie = context.Request.Cookies[_options.CsrfCookieName];
        var header = context.Request.Headers[AuthCookieOptions.CsrfHeaderName].ToString();

        if (string.IsNullOrEmpty(cookie) || string.IsNullOrEmpty(header) || !FixedTimeEquals(cookie, header))
        {
            context.Response.StatusCode = StatusCodes.Status403Forbidden;
            context.Response.ContentType = "application/problem+json";
            await context.Response.WriteAsync(
                """{"title":"Forbidden","status":403,"detail":"Missing or invalid CSRF token. Reload the page and try again."}""");
            return;
        }

        await next(context);
    }

    private bool RequiresCheck(HttpContext context)
    {
        var request = context.Request;

        if (SafeMethods.Contains(request.Method)) return false;
        if (!request.Path.StartsWithSegments("/api")) return false;

        // Login mints the pair; requiring one to obtain one is a deadlock.
        if (request.Path.StartsWithSegments("/api/auth/login")) return false;

        // The CCAvenue callback. The customer returns from the gateway on a
        // cross-site top-level POST, which by construction cannot carry our
        // header — so requiring one would reject every real payment.
        //
        // This is not a hole. With SameSite=Strict the session cookie is not
        // sent on that POST either, so the branch below would already exempt
        // it; stating it explicitly means the exemption survives someone
        // loosening SameSite later, and makes it obvious that the endpoint
        // authenticates its MESSAGE rather than its caller. It is anonymous,
        // and a body that does not decrypt under the working key never reaches
        // the database — see PaymentEndpoints.
        if (request.Path.StartsWithSegments("/api/payments/callback")) return false;

        // A caller presenting an explicit Authorization header is not riding a
        // cookie, so cross-site forgery does not apply to it.
        if (!string.IsNullOrEmpty(request.Headers.Authorization.ToString())) return false;

        // Nothing to forge without the session cookie.
        return request.Cookies.ContainsKey(_options.TokenCookieName);
    }

    /// <summary>
    /// Constant-time comparison. A short-circuiting string equality leaks, via
    /// response timing, how many leading characters of a guess were right.
    /// </summary>
    private static bool FixedTimeEquals(string a, string b)
    {
        var x = Encoding.UTF8.GetBytes(a);
        var y = Encoding.UTF8.GetBytes(b);
        return x.Length == y.Length && CryptographicOperations.FixedTimeEquals(x, y);
    }
}

public static class CsrfProtectionExtensions
{
    public static IApplicationBuilder UseInfinityCsrfProtection(this IApplicationBuilder app) =>
        app.UseMiddleware<CsrfProtection>();
}
