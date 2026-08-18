using System.Security.Cryptography;
using System.Text;

namespace Infinity.Api.Payments;

/// <summary>
/// Signs the link a customer lands on after paying.
///
/// -- WHY THE RECEIPT PAGE CANNOT NEED A SESSION -----------------------------
/// The customer returns from CCAvenue on a cross-site POST. Our session cookie
/// is SameSite=Strict, so the browser does not send it on that navigation — nor
/// on the GET that follows our redirect, because the chain was started from
/// another origin. The SPA therefore saw no session and bounced the customer to
/// the login screen, moments after taking their money.
///
/// Loosening the cookie to SameSite=Lax would paper over it and give back some
/// of the CSRF resistance that moving the JWT into a cookie was meant to buy.
/// So the receipt is a PUBLIC page instead, and this is what makes that safe: a
/// short HMAC over the order reference, minted server-side at the moment we
/// settle. Without the token the reference is inert, and the reference itself
/// is 20 hex characters of a GUID, so it cannot be guessed either.
///
/// The same shape as <see cref="Reports.ReportLink"/>, and it shares the one
/// secret — with a different purpose prefix, so a token minted for a report
/// cannot open a receipt or the other way round.
/// </summary>
public sealed class PaymentReceiptLink(IConfiguration config)
{
    private const string Purpose = "inf:receipt:";

    /// <summary>
    /// 24 base64url characters — 144 bits of a SHA-256 HMAC. Past brute force,
    /// and short enough to sit in a URL a customer might copy.
    /// </summary>
    private const int TokenChars = 24;

    private string Secret => config["Reports:TokenSecret"] ?? string.Empty;

    /// <summary>
    /// Whether receipts can be signed at all. With no secret the callback still
    /// settles the payment — money must never depend on a display feature — and
    /// simply sends the customer to a page that says so.
    /// </summary>
    public bool Enabled => Secret.Length > 0;

    public string Token(string orderRef)
    {
        var s = Secret;
        if (s.Length == 0) return string.Empty;

        var mac = HMACSHA256.HashData(
            Encoding.UTF8.GetBytes(s),
            Encoding.UTF8.GetBytes(Purpose + orderRef.Trim()));

        return Convert.ToBase64String(mac)
            .Replace('+', '-').Replace('/', '_').TrimEnd('=')
            [..TokenChars];
    }

    /// <summary>Constant-time check that <paramref name="token"/> opens this reference.</summary>
    public bool Verify(string orderRef, string? token)
    {
        var expected = Token(orderRef);
        var got = (token ?? string.Empty).Trim();
        // Length first and separately: FixedTimeEquals needs equal lengths, and
        // an empty expected token (no secret configured) must never match.
        if (expected.Length == 0 || got.Length != expected.Length) return false;

        return CryptographicOperations.FixedTimeEquals(
            Encoding.UTF8.GetBytes(expected), Encoding.UTF8.GetBytes(got));
    }
}
