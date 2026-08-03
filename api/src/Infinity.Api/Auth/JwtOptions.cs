namespace Infinity.Api.Auth;

public sealed class JwtOptions
{
    public const string SectionName = "Jwt";

    /// <summary>
    /// HMAC signing key. Must be at least 32 bytes of real entropy — this is the
    /// only thing standing between a stranger and a forged super_admin token.
    /// Supply via the Jwt__Secret environment variable; never commit it.
    /// </summary>
    public string Secret { get; set; } = "";

    public string Issuer { get; set; } = "infinity-api";
    public string Audience { get; set; } = "infinity-web";

    /// <summary>
    /// Token lifetime. Kept short because these are stateless bearer tokens:
    /// revocation only bites when the session-version cache next refreshes, so a
    /// long-lived token widens that window.
    /// </summary>
    public int LifetimeMinutes { get; set; } = 480;

    public IReadOnlyList<string> Validate()
    {
        var problems = new List<string>();

        if (string.IsNullOrWhiteSpace(Secret))
        {
            problems.Add("Jwt:Secret is required.");
        }
        else if (System.Text.Encoding.UTF8.GetByteCount(Secret) < 32)
        {
            problems.Add("Jwt:Secret must be at least 32 bytes.");
        }

        if (LifetimeMinutes is < 1 or > 1440)
        {
            problems.Add("Jwt:LifetimeMinutes must be between 1 and 1440.");
        }

        return problems;
    }
}
