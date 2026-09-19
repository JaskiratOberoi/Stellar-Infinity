using Infinity.Api.Auth;
using Infinity.Api.Reads;

namespace Infinity.Api.Endpoints;

/// <summary>
/// The sales dashboard: a salesperson's territory against its target.
/// </summary>
/// <remarks>
/// Two readers. A salesperson (sales_exec) reads its OWN dashboard and nothing
/// else: the user id comes from the token, never from the query. The Sales
/// Admin and above read anyone's, list the team, and set the targets — the
/// three things running a sales team needs — and each of those checks the
/// role, not just the capability, because sales:view is also what the
/// salesperson holds.
/// </remarks>
public static class SalesEndpoints
{
    public static void MapSalesEndpoints(this WebApplication app)
    {
        var sales = app.MapGroup("/api/sales-dashboard")
                       .RequireAuthorization()
                       .RequireCapability(Capabilities.SalesView);

        sales.MapGet("/", GetMine).WithName("GetMySalesDashboard");
        sales.MapGet("/team", GetTeam).WithName("GetSalesTeam");
        sales.MapGet("/team/{userId:int}", GetTheirs).WithName("GetSalesDashboardFor");
        sales.MapPut("/team/{userId:int}/target", SetTarget).WithName("SetSalesTarget");
    }

    /// <summary>Who may see the team and set its targets.</summary>
    private static bool RunsTheTeam(System.Security.Claims.ClaimsPrincipal principal) =>
        principal.Role() is InfinityRoles.SuperAdmin or InfinityRoles.Admin or InfinityRoles.Sales;

    private static async Task<IResult> GetMine(
        System.Security.Claims.ClaimsPrincipal principal, SalesRepository repo, CancellationToken ct, string? month = null)
    {
        if (principal.UserId() is not int userId) return Results.Unauthorized();
        var d = await repo.GetDashboardAsync(userId, month, ct).ConfigureAwait(false);
        return d is null ? Results.NotFound(new { error = "No sales account." }) : Results.Ok(d);
    }

    private static async Task<IResult> GetTheirs(
        int userId, System.Security.Claims.ClaimsPrincipal principal, SalesRepository repo, CancellationToken ct, string? month = null)
    {
        // A salesperson asking for a colleague's dashboard gets its own answer
        // withheld rather than someone else's given: 404, so the route does
        // not confirm which ids are salespeople.
        if (!RunsTheTeam(principal)) return Results.NotFound();
        var d = await repo.GetDashboardAsync(userId, month, ct).ConfigureAwait(false);
        return d is null ? Results.NotFound(new { error = "No such sales account." }) : Results.Ok(d);
    }

    private static async Task<IResult> GetTeam(
        System.Security.Claims.ClaimsPrincipal principal, SalesRepository repo, CancellationToken ct, string? month = null)
    {
        if (!RunsTheTeam(principal)) return Results.NotFound();
        return Results.Ok(await repo.GetTeamAsync(month, ct).ConfigureAwait(false));
    }

    public sealed record TargetBody(int Year, int Month, decimal Target);

    private static async Task<IResult> SetTarget(
        int userId, TargetBody? body, System.Security.Claims.ClaimsPrincipal principal,
        SalesRepository repo, Audit.AuditLog audit, HttpContext http, CancellationToken ct)
    {
        if (!RunsTheTeam(principal)) return Results.NotFound();
        if (body is null || body.Year < 2015 || body.Year > 2100 || body.Month < 1 || body.Month > 12 || body.Target < 0 || body.Target > 1_000_000_000)
            return Results.BadRequest(new { error = "A year, a month and a target of zero or more are needed." });

        if (principal.UserId() is not int actor) return Results.Unauthorized();
        var ok = await repo.SetTargetAsync(userId, body.Year, body.Month, body.Target, actor, ct).ConfigureAwait(false);
        if (!ok) return Results.NotFound(new { error = "No such sales account." });

        audit.Log("sales.target_set", actor: principal.UserId(), ip: Audit.AuditIp.From(http),
            details: new { userId, body.Year, body.Month, body.Target });
        return Results.Ok(new { userId, body.Year, body.Month, body.Target });
    }
}
