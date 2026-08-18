using System.Security.Cryptography;
using System.Text;

namespace Infinity.Api.Payments;

/// <summary>
/// CCAvenue's request/response encryption.
///
/// AES-128-CBC over the MD5 of the working key, with a fixed IV of 0x00..0x0f,
/// hex-encoded. This is not a design; it is CCAvenue's published scheme and it
/// must be reproduced exactly or the gateway rejects the request. The MD5 and
/// the constant IV are theirs — worth knowing about, not worth "fixing", since
/// the other end will not change with us.
///
/// What the scheme does still buy: only a holder of the working key can produce
/// a ciphertext that decrypts to well-formed parameters. That is the whole
/// basis on which the callback is believed, which is why the key must never
/// leave the deployment env — see <see cref="CCAvenueOptions"/>.
///
/// It buys nothing else. It is not authenticated encryption, so a decrypt that
/// succeeds proves the key was used, not that the content is what the gateway
/// sent. Everything that matters — the amount, the order — is therefore checked
/// against our own intent record rather than taken from the response.
/// </summary>
public static class CCAvenueCrypto
{
    // CCAvenue's fixed initialisation vector.
    private static readonly byte[] Iv =
    [
        0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07,
        0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f,
    ];

    public static string Encrypt(string plainText, string workingKey)
    {
        using var aes = Create(workingKey);
        using var enc = aes.CreateEncryptor();
        var bytes = Encoding.UTF8.GetBytes(plainText);
        return Convert.ToHexStringLower(enc.TransformFinalBlock(bytes, 0, bytes.Length));
    }

    /// <summary>
    /// Returns null rather than throwing on anything malformed. The caller is
    /// an endpoint reachable by the public internet: a body that is not valid
    /// hex, or not a multiple of the block size, or does not decrypt under our
    /// key is a stranger poking at the URL, and it should cost us a 400 rather
    /// than an exception and a stack trace in the log.
    /// </summary>
    public static string? TryDecrypt(string cipherHex, string workingKey)
    {
        if (string.IsNullOrWhiteSpace(cipherHex)) return null;

        byte[] cipher;
        try { cipher = Convert.FromHexString(cipherHex.Trim()); }
        catch (FormatException) { return null; }

        if (cipher.Length == 0 || cipher.Length % 16 != 0) return null;

        try
        {
            using var aes = Create(workingKey);
            using var dec = aes.CreateDecryptor();
            var plain = dec.TransformFinalBlock(cipher, 0, cipher.Length);
            return Encoding.UTF8.GetString(plain);
        }
        catch (CryptographicException)
        {
            // Wrong key, or padding that does not check out.
            return null;
        }
    }

    private static Aes Create(string workingKey)
    {
        var aes = Aes.Create();
        aes.Mode = CipherMode.CBC;
        aes.Padding = PaddingMode.PKCS7;
        // MD5 here is CCAvenue's key derivation, not a hash of anything secret
        // we choose. It is 16 bytes because AES-128 needs 16.
        aes.Key = MD5.HashData(Encoding.UTF8.GetBytes(workingKey));
        aes.IV = Iv;
        return aes;
    }

    /// <summary>
    /// CCAvenue's payload looks like a query string and is NOT one.
    ///
    /// Their kits build it by concatenation and read it by splitting on '&amp;'
    /// and '=', and the two official kits DISAGREE about escaping: the Java one
    /// sends values raw, the PHP one urlencodes them. Both are accepted, so the
    /// server evidently tolerates either. We send raw, matching the Java kit —
    /// the safer of the two to imitate, since a value that needs no escaping is
    /// unambiguous under both readings.
    ///
    /// The cost is that a value can carry neither '&amp;' nor '=';
    /// <see cref="BuildPairs"/> refuses those instead of emitting a payload
    /// that would silently reparse into different fields.
    ///
    /// The FIRST binding of a repeated key wins, so a response that appends a
    /// second order_status cannot overwrite the first.
    /// </summary>
    public static Dictionary<string, string> ParsePairs(string body)
    {
        var map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var pair in body.Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var i = pair.IndexOf('=');
            if (i <= 0) continue;
            // No unescaping: the sender did not escape. Running UnescapeDataString
            // over a raw value would corrupt any '%' in, say, a failure message.
            var k = pair[..i].Trim();
            var v = pair[(i + 1)..].Trim();
            if (k.Length > 0) map.TryAdd(k, v);
        }
        return map;
    }

    /// <summary>
    /// Build the request blob in CCAvenue's own format — see
    /// <see cref="ParsePairs"/> for why it is not a query string.
    /// </summary>
    /// <exception cref="ArgumentException">
    /// A value containing '&amp;' or '=' cannot be represented. Every value we
    /// send is one we control — our order reference, our URLs, an amount — so
    /// this is a programming error, and throwing beats shipping a payload that
    /// reparses into fields nobody intended.
    /// </exception>
    public static string BuildPairs(IEnumerable<KeyValuePair<string, string>> pairs)
    {
        var sb = new System.Text.StringBuilder();
        foreach (var p in pairs)
        {
            if (p.Value.Contains('&') || p.Value.Contains('='))
                throw new ArgumentException($"CCAvenue parameter '{p.Key}' cannot contain '&' or '='.", nameof(pairs));

            // TRAILING ampersand, on every pair including the last.
            //
            // Not a stray. Both of CCAvenue's official kits build the payload by
            // appending "name=value&" in a loop, so what their server is fed
            // always ends in a separator. The two kits disagree about whether to
            // urlencode the values — the Java one does not, the PHP one does —
            // but they agree on this, which makes it the part their parser is
            // most likely to depend on. string.Join would omit it.
            sb.Append(p.Key).Append('=').Append(p.Value).Append('&');
        }
        return sb.ToString();
    }
}
