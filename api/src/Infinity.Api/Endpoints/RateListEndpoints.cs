using Infinity.Api.Auth;
using Infinity.Api.Orders;
using Microsoft.AspNetCore.Mvc;

namespace Infinity.Api.Endpoints;

/// <summary>
/// Rate lists — what clients are charged.
///
/// Reading is billing:view; changing anything is rate:manage, which only
/// super_admin and admin hold. The split is deliberate: seeing a client's
/// balance is a daily commercial task, while editing a rate re-prices every
/// centre on that list at once.
///
/// NOT scoped by client, unlike everything else here. A rate list is not owned
/// by a centre — one list serves many — so there is no per-client scope to
/// apply. The capability is the whole gate, which is why it is a narrow one.
/// </summary>
public static class RateListEndpoints
{
    public static void MapRateListEndpoints(this WebApplication app)
    {
        var g = app.MapGroup("/api/rate-lists").RequireAuthorization();

        g.MapGet("/", ListRateLists)
         .RequireCapability(Capabilities.BillingView)
         .WithName("ListRateLists");

        g.MapGet("/{id:int}/items", ListItems)
         .RequireCapability(Capabilities.BillingView)
         .WithName("ListRateListItems");

        g.MapPost("/", CreateRateList)
         .RequireCapability(Capabilities.RateManage)
         .WithName("CreateRateList");

        g.MapPut("/{id:int}/rates/{testId:int}", SetRate)
         .RequireCapability(Capabilities.RateManage)
         .WithName("SetRate");
    }

    private static async Task<IResult> ListRateLists(
        RateListRepository repo, CancellationToken ct, string? search = null) =>
        Results.Ok(new { rows = await repo.ListAsync(search, ct).ConfigureAwait(false) });

    private static async Task<IResult> ListItems(
        int id,
        RateListRepository repo,
        CancellationToken ct,
        string? search = null,
        string? filter = null,
        int page = 1,
        int pageSize = 100)
    {
        var r = await repo.ItemsAsync(id, search, filter, page, pageSize, ct).ConfigureAwait(false);
        return Results.Ok(new
        {
            rows = r.Rows, count = r.Rows.Count, total = r.Total,
            page = r.Page, pageSize = r.PageSize, pageCount = r.PageCount,
        });
    }

    public sealed record CreateRequest(string Name);

    private static async Task<IResult> CreateRateList(
        [FromBody] CreateRequest body,
        System.Security.Claims.ClaimsPrincipal principal,
        RateListRepository repo,
        CancellationToken ct)
    {
        if (principal.UserId() is not int userId) return Results.Unauthorized();
        if (string.IsNullOrWhiteSpace(body.Name))
            return Results.BadRequest(new { error = "A rate list needs a name." });

        var r = await repo.CreateAsync(userId, body.Name, ct).ConfigureAwait(false);

        return r.Ok
            ? Results.Ok(r)
            // The procedure's own message covers the duplicate-name case, which
            // is the one people actually hit.
            : Results.BadRequest(new { error = r.Message, code = r.ErrorCode });
    }

    public sealed record SetRateRequest(int Price);

    private static async Task<IResult> SetRate(
        int id, int testId,
        [FromBody] SetRateRequest body,
        RateListRepository repo,
        CancellationToken ct)
    {
        if (body.Price < 0)
            return Results.BadRequest(new { error = "A rate cannot be negative." });

        await repo.SetRateAsync(id, testId, body.Price, ct).ConfigureAwait(false);
        return Results.Ok(new { ok = true });
    }
}
