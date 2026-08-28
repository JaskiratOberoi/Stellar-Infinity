using Infinity.Api.Auth;
using Infinity.Api.Orders;
using Microsoft.AspNetCore.Mvc;

namespace Infinity.Api.Endpoints;

/// <summary>
/// Referrer roster management — the last client feature still chained to the
/// legacy portal. The LIS keeps its only two referrer screens in the CLIENT
/// area (Pcc/Doctors.aspx, Pcc/Customers.aspx): centres maintain their own
/// rosters of referring doctors and customers, hard-scoped to their own
/// centre; lab staff, whose scope is every centre, manage any.
/// </summary>
/// <remarks>
/// Scope is the operational scope, same as ordering — a roster is order-entry
/// reference data, and the franchise roll-up applies the same way. Reading a
/// roster needs order:view, changing it order:create (writing reference data
/// used at booking is a booking-strength act), and the business figures
/// billing:view because they are money.
/// </remarks>
public static class ReferrerEndpoints
{
    public static void MapReferrerEndpoints(this WebApplication app)
    {
        var g = app.MapGroup("/api/referrers")
                   .RequireAuthorization();

        g.MapGet("/", ListRoster)
         .RequireCapability(Capabilities.OrderView)
         .WithName("ListReferrers");
        g.MapPost("/", SaveReferrer)
         .RequireCapability(Capabilities.OrderCreate)
         .WithName("SaveReferrer");
        g.MapGet("/stats", GetStats)
         .RequireCapability(Capabilities.BillingView)
         .WithName("GetReferrerStats");
    }

    private static async Task<bool> InScopeAsync(
        ScopeRepository scopes, int userId, int mcc, CancellationToken ct)
    {
        var scope = await scopes.GetScopeAsync(userId, ct).ConfigureAwait(false);
        return scope.Contains(mcc);
    }

    private static async Task<IResult> ListRoster(
        [FromQuery] int mcc,
        System.Security.Claims.ClaimsPrincipal principal,
        ScopeRepository scopes,
        ReferrerAdminRepository repo,
        CancellationToken ct)
    {
        if (principal.UserId() is not int userId) return Results.Unauthorized();
        if (!await InScopeAsync(scopes, userId, mcc, ct).ConfigureAwait(false)) return Results.NotFound();
        return Results.Ok(await repo.ListAsync(mcc, ct).ConfigureAwait(false));
    }

    public sealed record SaveReferrerRequest(
        string Kind, int? Id, int Mcc, string? Code, string? Name, bool Active);

    private static async Task<IResult> SaveReferrer(
        [FromBody] SaveReferrerRequest body,
        System.Security.Claims.ClaimsPrincipal principal,
        ScopeRepository scopes,
        ReferrerAdminRepository repo,
        Audit.AuditLog audit,
        HttpContext http,
        CancellationToken ct)
    {
        if (principal.UserId() is not int userId) return Results.Unauthorized();
        if (body.Kind is not ("doctor" or "customer"))
            return Results.BadRequest(new { error = "kind must be doctor or customer." });
        if (!await InScopeAsync(scopes, userId, body.Mcc, ct).ConfigureAwait(false)) return Results.NotFound();

        var r = await repo.SaveAsync(
            body.Kind, body.Id, body.Mcc,
            body.Code?.Trim() ?? "", body.Name?.Trim() ?? "", body.Active, userId, ct)
            .ConfigureAwait(false);
        if (!r.Ok) return Results.BadRequest(new { error = r.Message, code = r.ErrorCode });

        // One kind per outcome, so the trail reads as what happened rather
        // than as which endpoint ran: a deactivation is the interesting event
        // and should not hide inside a generic "updated".
        var kind = body.Id is null ? "referrer.created"
                 : body.Active ? "referrer.updated" : "referrer.deactivated";
        audit.Log(kind, actor: userId, ip: Audit.AuditIp.From(http),
            details: new { body.Mcc, body.Kind, id = r.Id, name = body.Name?.Trim(), active = body.Active });

        return Results.Ok(new { ok = true, id = r.Id });
    }

    private static async Task<IResult> GetStats(
        [FromQuery] int mcc,
        [FromQuery] string? from,
        [FromQuery] string? to,
        System.Security.Claims.ClaimsPrincipal principal,
        ScopeRepository scopes,
        ReferrerAdminRepository repo,
        CancellationToken ct)
    {
        if (principal.UserId() is not int userId) return Results.Unauthorized();
        if (!await InScopeAsync(scopes, userId, mcc, ct).ConfigureAwait(false)) return Results.NotFound();

        // Default to the last 30 days — the window the balances screens use
        // for "recent business", and small enough to answer fast on the live
        // billing table.
        var toDay = DateTime.TryParse(to, out var t) ? t.Date : Domain.NobleTime.NowForNoble().Date;
        var fromDay = DateTime.TryParse(from, out var f) ? f.Date : toDay.AddDays(-30);
        if (fromDay > toDay) (fromDay, toDay) = (toDay, fromDay);
        // A runaway window is a table scan on the live LIS DB.
        if ((toDay - fromDay).TotalDays > 366)
            return Results.BadRequest(new { error = "The window can span at most a year." });

        return Results.Ok(await repo.StatsAsync(mcc, fromDay, toDay, ct).ConfigureAwait(false));
    }
}
