using System.Security.Cryptography;
using System.Text;
using QRCoder;

namespace Infinity.Api.Reports;

/// <summary>
/// The patient-facing report link, and the QR that carries it.
///
/// A printed report carries a QR encoding a PUBLIC, token-gated URL that a
/// patient can open without an account. Ported from Telo's lib/report/
/// reportLink.ts so a report issued by either platform behaves the same in a
/// patient's hands.
/// </summary>
/// <remarks>
/// <para>
/// ── WHAT THE TOKEN IS, AND WHAT IT IS NOT ─────────────────────────────────
/// The token is an HMAC of the SID under a server secret. That makes it
/// unguessable and non-enumerable: holding the token for one SID tells you
/// nothing about the token for the next one, so a patient cannot walk the SID
/// space by incrementing a number.
/// </para>
/// <para>
/// It is NOT a session, and it does not expire. Anyone holding the printed
/// report — or a photograph of it — can fetch that report, for ever. That is
/// the intended behaviour (it is the patient's own result, on their own copy)
/// but it is a real property and worth stating plainly rather than discovering:
/// a report forwarded in a WhatsApp group is readable by that group.
/// </para>
/// <para>
/// ── FAILS CLOSED ──────────────────────────────────────────────────────────
/// With no secret configured, <see cref="Token"/> returns empty, no QR is
/// drawn, and the public endpoint rejects every request. A deployment that has
/// not been given a secret therefore publishes nothing, rather than publishing
/// everything under a predictable empty-key HMAC.
/// </para>
/// </remarks>
public sealed class ReportLink(IConfiguration config)
{
    /// <summary>
    /// Distinct from Telo's "telo:report:" prefix on purpose. The two products
    /// may be configured with the same secret, and a token minted by one must
    /// not open the other's public route — the scopes behind them differ.
    /// </summary>
    private const string Purpose = "inf:report:";

    /// <summary>
    /// 24 base64url characters — 144 bits of a SHA-256 HMAC. Truncated because
    /// the whole string has to survive being printed at QR density and,
    /// occasionally, typed; 144 bits is far past brute force either way.
    /// </summary>
    private const int TokenChars = 24;

    private string Secret => config["Reports:TokenSecret"] ?? string.Empty;

    /// <summary>Where the printed QR must resolve. Empty disables the link.</summary>
    private string PublicBaseUrl => (config["Reports:PublicBaseUrl"] ?? string.Empty).TrimEnd('/');

    public bool Enabled => Secret.Length > 0 && PublicBaseUrl.Length > 0;

    /// <summary>The token for a SID, or empty when no secret is configured.</summary>
    public string Token(string sid)
    {
        var s = Secret;
        if (s.Length == 0) return string.Empty;

        var mac = HMACSHA256.HashData(
            Encoding.UTF8.GetBytes(s),
            Encoding.UTF8.GetBytes(Purpose + sid.Trim()));

        return Convert.ToBase64String(mac)
            .Replace('+', '-').Replace('/', '_').TrimEnd('=')
            [..TokenChars];
    }

    /// <summary>Constant-time check that <paramref name="token"/> opens <paramref name="sid"/>.</summary>
    public bool Verify(string sid, string? token)
    {
        var expected = Token(sid);
        var got = (token ?? string.Empty).Trim();
        // Length is checked first and separately: FixedTimeEquals requires equal
        // lengths, and an empty expected token (no secret) must never match.
        if (expected.Length == 0 || got.Length != expected.Length) return false;

        return CryptographicOperations.FixedTimeEquals(
            Encoding.UTF8.GetBytes(expected), Encoding.UTF8.GetBytes(got));
    }

    /// <summary>The URL a patient scans, or null when the link is not configured.</summary>
    public string? PublicUrl(string sid)
    {
        if (!Enabled) return null;
        return $"{PublicBaseUrl}/r/{Uri.EscapeDataString(sid.Trim())}?t={Token(sid)}";
    }

    /// <summary>
    /// The QR as a PNG data URI, ready to inline into the printed report.
    /// </summary>
    /// <remarks>
    /// Inlined rather than served from a route because the renderer photographs
    /// the page in a headless browser, and an image fetched over HTTP is one
    /// more thing that can be slow or fail between "ready to print" and the
    /// shutter. ECC level Q, not the usual M: this is printed small and then
    /// scanned off paper that has been folded, stamped and posted.
    /// </remarks>
    public string? QrDataUrl(string sid)
    {
        var url = PublicUrl(sid);
        if (url is null) return null;

        try
        {
            using var gen = new QRCodeGenerator();
            using var data = gen.CreateQrCode(url, QRCodeGenerator.ECCLevel.Q);
            var png = new PngByteQRCode(data).GetGraphic(8);
            return $"data:image/png;base64,{Convert.ToBase64String(png)}";
        }
        catch
        {
            // A report without a QR is a report; a report that failed to render
            // is not. Never let the code generator take the page down.
            return null;
        }
    }
}
