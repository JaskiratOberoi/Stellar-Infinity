using System.Security.Cryptography;
using System.Text;

namespace Infinity.Api.Worksheet;

/// <summary>
/// Salted PBKDF2-HMAC-SHA256, encoded as
/// <c>pbkdf2-sha256$&lt;iterations&gt;$&lt;base64 salt&gt;$&lt;base64 key&gt;</c>.
///
/// Deliberately dependency-free: the HashPassword tool links this exact file so
/// that the digest it produces and the digest the API verifies are computed by
/// the same code. A second implementation that drifted by one iteration count
/// would emit hashes that silently never validate.
///
/// This is the opposite of how the legacy LIS treats a password. There,
/// tbl_med_user_master.password is cleartext, LoginClass.UserAuth compares it
/// with a plain SQL equality, the admin screen renders the stored value back
/// into an input, and new users are emailed their password in the message body.
/// </summary>
public static class PasswordHash
{
    private const string Prefix = "pbkdf2-sha256";
    private const int KeyLength = 32;
    private const int SaltLength = 16;

    /// <summary>
    /// OWASP's 2023 floor for PBKDF2-HMAC-SHA256. Stored in the encoded string
    /// rather than assumed, so raising it later does not invalidate existing
    /// digests — <see cref="Verify"/> uses whatever the stored value declares.
    /// </summary>
    public const int DefaultIterations = 210_000;

    public static string Create(string password, int iterations = DefaultIterations)
    {
        var salt = RandomNumberGenerator.GetBytes(SaltLength);
        var key = Rfc2898DeriveBytes.Pbkdf2(
            Encoding.UTF8.GetBytes(password), salt, iterations, HashAlgorithmName.SHA256, KeyLength);

        return $"{Prefix}${iterations}${Convert.ToBase64String(salt)}${Convert.ToBase64String(key)}";
    }

    public static bool IsWellFormed(string? encoded) => TryParse(encoded, out _, out _, out _);

    /// <summary>
    /// Constant-time verification.
    ///
    /// <see cref="CryptographicOperations.FixedTimeEquals"/> is not decoration:
    /// a comparison that returns as soon as two bytes differ leaks, through
    /// response timing, how much of a guess was right. That is a practical
    /// attack against a shared secret an attacker can submit repeatedly.
    /// </summary>
    public static bool Verify(string password, string? encoded)
    {
        if (!TryParse(encoded, out var iterations, out var salt, out var expected)) return false;

        var actual = Rfc2898DeriveBytes.Pbkdf2(
            Encoding.UTF8.GetBytes(password), salt, iterations, HashAlgorithmName.SHA256, expected.Length);

        return CryptographicOperations.FixedTimeEquals(actual, expected);
    }

    private static bool TryParse(string? encoded, out int iterations, out byte[] salt, out byte[] key)
    {
        iterations = 0;
        salt = [];
        key = [];

        if (string.IsNullOrWhiteSpace(encoded)) return false;

        var parts = encoded.Split('$');
        if (parts.Length != 4 || parts[0] != Prefix) return false;

        // A digest claiming an implausibly low iteration count is treated as
        // malformed rather than honoured — otherwise anyone who could write the
        // config could weaken the hash to near-instant brute force while leaving
        // it looking valid.
        if (!int.TryParse(parts[1], out iterations) || iterations < 10_000) return false;

        try
        {
            salt = Convert.FromBase64String(parts[2]);
            key = Convert.FromBase64String(parts[3]);
        }
        catch (FormatException)
        {
            return false;
        }

        return salt.Length >= 8 && key.Length >= 16;
    }
}
