using System.Security.Claims;

namespace Infinity.Api.Auth;

/// <summary>
/// Capability gate for minimal-API endpoints.
///
/// Applied as an endpoint filter rather than checked inside handlers, so a new
/// endpoint cannot silently ship without a gate — the requirement is visible in
/// the route definition and reviewable in one place.
/// </summary>
public sealed class RequireCapabilityFilter(string capability) : IEndpointFilter
{
    public async ValueTask<object?> InvokeAsync(EndpointFilterInvocationContext context, EndpointFilterDelegate next)
    {
        var user = context.HttpContext.User;

        if (user.Identity?.IsAuthenticated != true)
        {
            return Results.Unauthorized();
        }

        if (!user.HasCapability(capability))
        {
            // 403, not 404: the caller is authenticated and we are telling them
            // this action is not theirs. Resource-existence hiding belongs on
            // the resource lookup (scope), not on the capability check.
            return Results.Problem(
                title: "Forbidden",
                detail: $"This action requires the '{capability}' capability.",
                statusCode: StatusCodes.Status403Forbidden);
        }

        return await next(context);
    }
}

public static class CapabilityExtensions
{
    public static TBuilder RequireCapability<TBuilder>(this TBuilder builder, string capability)
        where TBuilder : IEndpointConventionBuilder
    {
        builder.AddEndpointFilter(new RequireCapabilityFilter(capability));
        return builder;
    }

    public static bool HasCapability(this ClaimsPrincipal user, string capability) =>
        user.HasClaim(JwtIssuer.CapabilityClaim, capability);

    public static int? UserId(this ClaimsPrincipal user) =>
        int.TryParse(user.FindFirstValue(System.IdentityModel.Tokens.Jwt.JwtRegisteredClaimNames.Sub), out var id)
            ? id
            : null;
}
