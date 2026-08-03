using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Text;
using Microsoft.Extensions.Options;
using Microsoft.IdentityModel.Tokens;

namespace Infinity.Api.Auth;

/// <summary>Mints the bearer tokens the SPA sends back on every request.</summary>
public sealed class JwtIssuer
{
    /// <summary>Session-version claim. Checked on every request; see <c>SessionVersionValidator</c>.</summary>
    public const string SessionVersionClaim = "sv";

    /// <summary>Capability claim type. One claim per capability.</summary>
    public const string CapabilityClaim = "cap";

    public const string ManagedByClaim = "mgd";
    public const string LisAccessClaim = "lis";

    private readonly JwtOptions _options;
    private readonly SigningCredentials _credentials;

    public JwtIssuer(IOptions<JwtOptions> options)
    {
        _options = options.Value;

        var problems = _options.Validate();
        if (problems.Count > 0)
        {
            throw new InvalidOperationException("JWT is misconfigured: " + string.Join(" ", problems));
        }

        var key = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(_options.Secret));
        _credentials = new SigningCredentials(key, SecurityAlgorithms.HmacSha256);
    }

    public (string Token, DateTimeOffset ExpiresAt) Issue(AuthenticatedUser user, int sessionVersion)
    {
        var now = DateTimeOffset.UtcNow;
        var expires = now.AddMinutes(_options.LifetimeMinutes);

        var claims = new List<Claim>
        {
            new(JwtRegisteredClaimNames.Sub, user.UserId.ToString()),
            new(JwtRegisteredClaimNames.UniqueName, user.Username),
            new(JwtRegisteredClaimNames.Jti, Guid.NewGuid().ToString("N")),
            new(ClaimTypes.Role, user.Role),
            new(SessionVersionClaim, sessionVersion.ToString()),
            new(ManagedByClaim, user.ManagedBy),
            new(LisAccessClaim, user.LisAccess ? "1" : "0"),
        };

        // Capabilities are baked into the token so authorization needs no
        // database hit. The session version is what makes that safe: a role
        // change bumps it, which invalidates every token carrying the old caps.
        claims.AddRange(user.Capabilities.Select(c => new Claim(CapabilityClaim, c)));

        var token = new JwtSecurityToken(
            issuer: _options.Issuer,
            audience: _options.Audience,
            claims: claims,
            notBefore: now.UtcDateTime,
            expires: expires.UtcDateTime,
            signingCredentials: _credentials);

        return (new JwtSecurityTokenHandler().WriteToken(token), expires);
    }

    public TokenValidationParameters ValidationParameters => new()
    {
        ValidateIssuer = true,
        ValidIssuer = _options.Issuer,
        ValidateAudience = true,
        ValidAudience = _options.Audience,
        ValidateIssuerSigningKey = true,
        IssuerSigningKey = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(_options.Secret)),
        ValidateLifetime = true,
        // Default is 5 minutes of grace, which quietly extends every expiry.
        ClockSkew = TimeSpan.FromSeconds(30),
        RoleClaimType = ClaimTypes.Role,
        NameClaimType = JwtRegisteredClaimNames.UniqueName,
    };
}
