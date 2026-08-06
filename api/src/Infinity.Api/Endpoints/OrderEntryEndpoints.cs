using Infinity.Api.Auth;
using Infinity.Api.Orders;
using Infinity.Api.Reads;
using Microsoft.AspNetCore.Mvc;

namespace Infinity.Api.Endpoints;

/// <summary>
/// Order entry: cart, preview, placement.
///
/// Phase 2 of taking the ordering pipeline off Telo. Every route here is scope
/// checked against the caller's OPERATIONAL scope — the same one the orders
/// list uses — because booking for a client is a stronger act than reading
/// their reports and must not be reachable by putting a foreign MCC id in a
/// request body.
/// </summary>
public static class OrderEntryEndpoints
{
    public static void MapOrderEntryEndpoints(this WebApplication app)
    {
        var cart = app.MapGroup("/api/orders/cart")
                      .RequireAuthorization()
                      .RequireCapability(Capabilities.OrderCreate);

        cart.MapGet("/", GetCart).WithName("GetCart");
        cart.MapPost("/client", SetCartClient).WithName("SetCartClient");
        cart.MapPost("/items", AddCartItem).WithName("AddCartItem");
        cart.MapDelete("/items/{kind}/{id:int}", RemoveCartItem).WithName("RemoveCartItem");
        cart.MapDelete("/", ClearCart).WithName("ClearCart");

        var entry = app.MapGroup("/api/orders")
                       .RequireAuthorization()
                       .RequireCapability(Capabilities.OrderCreate);

        entry.MapPost("/preview", PreviewOrder).WithName("PreviewOrder");
        entry.MapPost("/", PlaceOrder).WithName("PlaceOrder");
    }

    // ---- cart --------------------------------------------------------------

    private static async Task<IResult> GetCart(
        System.Security.Claims.ClaimsPrincipal principal,
        CartStore carts,
        CancellationToken ct)
    {
        if (principal.UserId() is not int userId) return Results.Unauthorized();
        return Results.Ok(await carts.GetAsync(userId, ct).ConfigureAwait(false));
    }

    public sealed record SetClientRequest(int Mcc);

    private static async Task<IResult> SetCartClient(
        [FromBody] SetClientRequest body,
        System.Security.Claims.ClaimsPrincipal principal,
        ScopeRepository scopes,
        CartStore carts,
        CancellationToken ct)
    {
        if (principal.UserId() is not int userId) return Results.Unauthorized();
        if (!await InScopeAsync(scopes, userId, body.Mcc, ct).ConfigureAwait(false))
            return Results.NotFound();

        return Results.Ok(await carts.SetClientAsync(userId, body.Mcc, ct).ConfigureAwait(false));
    }

    public sealed record AddItemRequest(string Kind, int Id, string? Code, string? Name);

    private static async Task<IResult> AddCartItem(
        [FromBody] AddItemRequest body,
        System.Security.Claims.ClaimsPrincipal principal,
        CartStore carts,
        CancellationToken ct)
    {
        if (principal.UserId() is not int userId) return Results.Unauthorized();
        if (body.Kind is not ("test" or "profile" or "master"))
            return Results.BadRequest(new { error = "kind must be test, profile or master." });

        var cart = await carts.GetAsync(userId, ct).ConfigureAwait(false);
        if (cart.Mcc is null)
            return Results.BadRequest(new { error = "Choose a client before adding tests — the price depends on it." });

        return Results.Ok(await carts
            .AddAsync(userId, new CartItem(body.Kind, body.Id, body.Code, body.Name), ct)
            .ConfigureAwait(false));
    }

    private static async Task<IResult> RemoveCartItem(
        string kind, int id,
        System.Security.Claims.ClaimsPrincipal principal,
        CartStore carts,
        CancellationToken ct)
    {
        if (principal.UserId() is not int userId) return Results.Unauthorized();
        return Results.Ok(await carts.RemoveAsync(userId, kind, id, ct).ConfigureAwait(false));
    }

    private static async Task<IResult> ClearCart(
        System.Security.Claims.ClaimsPrincipal principal,
        CartStore carts,
        CancellationToken ct)
    {
        if (principal.UserId() is not int userId) return Results.Unauthorized();
        await carts.ClearAsync(userId, ct).ConfigureAwait(false);
        return Results.Ok(Cart.Empty);
    }

    // ---- preview -----------------------------------------------------------

    /// <summary>
    /// What this order will cost and how many tubes it needs, before committing
    /// to any of it.
    ///
    /// Prices are resolved LIVE rather than taken from the cart. A cart can sit
    /// for 24 hours and a rate can change underneath it; quoting a stale price
    /// and then billing the current one is the kind of discrepancy a client
    /// notices on their invoice.
    /// </summary>
    private static async Task<IResult> PreviewOrder(
        System.Security.Claims.ClaimsPrincipal principal,
        ScopeRepository scopes,
        CartStore carts,
        CatalogRepository catalog,
        OrderWriteRepository orders,
        CancellationToken ct)
    {
        if (principal.UserId() is not int userId) return Results.Unauthorized();

        var cart = await carts.GetAsync(userId, ct).ConfigureAwait(false);
        if (cart.Mcc is not int mcc)
            return Results.BadRequest(new { error = "No client selected." });
        if (!await InScopeAsync(scopes, userId, mcc, ct).ConfigureAwait(false))
            return Results.NotFound();
        if (cart.Items.Count == 0)
            return Results.Ok(new { lines = Array.Empty<object>(), groups = Array.Empty<object>(), total = 0, mrpTotal = 0, margin = 0 });

        var groups = await orders.PreviewSampleGroupsAsync(cart.Items, ct).ConfigureAwait(false);

        // One catalogue read priced for this client, then matched against the
        // cart — rather than a rate lookup per item, which would be one round
        // trip per line.
        var priced = await catalog.SearchAsync(mcc, null, null, 1, 1000, ct).ConfigureAwait(false);
        var byKey = priced.Rows.ToDictionary(r => (r.Kind, r.Id));

        var lines = cart.Items.Select(i =>
        {
            byKey.TryGetValue((i.Kind, i.Id), out var p);
            return new
            {
                kind = i.Kind,
                id = i.Id,
                code = p?.Code ?? i.Code,
                name = p?.Name ?? i.Name,
                mrp = p?.Mrp,
                rate = p?.Rate,
                // 'none' means the catalogue has no price for this client at
                // all. Surfaced per line so the operator sees WHICH item is
                // unpriced rather than only that the total looks wrong.
                rateSource = p?.RateSource ?? "none",
            };
        }).ToArray();

        var total = lines.Sum(l => l.rate ?? 0m);

        // MARGIN IS COMPUTED OVER A SUBSET, DELIBERATELY.
        //
        // MRP is not populated for most of this catalogue — measured on rate
        // list 139 (Medicare), 1,248 of 1,457 priced tests carry MRP = 0. A
        // margin of (sum of MRP) minus (sum of rate) across every line
        // therefore reads as a large LOSS on almost every order, because the
        // zeros are missing data rather than a price of nothing.
        //
        // So margin is summed only over lines that actually have an MRP to
        // compare against, and the count of lines excluded is returned with it.
        // A margin figure whose basis is invisible is worse than no margin
        // figure: someone would eventually price a contract off it.
        var comparable = lines.Where(l => l.mrp is > 0m).ToArray();
        var comparableMrp = comparable.Sum(l => l.mrp ?? 0m);
        var comparableRate = comparable.Sum(l => l.rate ?? 0m);

        return Results.Ok(new
        {
            lines,
            groups,
            total,
            margin = new
            {
                // What the lab gives up against list price, over the lines
                // where "list price" means anything.
                amount = comparableMrp - comparableRate,
                mrpTotal = comparableMrp,
                rateTotal = comparableRate,
                comparableLines = comparable.Length,
                // Lines with no MRP on record. Not an error — most of the
                // catalogue is like this — but the margin above ignores them.
                linesWithoutMrp = lines.Length - comparable.Length,
            },
            unpriced = lines.Count(l => l.rateSource == "none"),
        });
    }

    // ---- placement ---------------------------------------------------------

    /// <summary>
    /// Place the order. This is the real write: a patient, a bill, a bill
    /// number, samples, and optionally a receipt and a ledger posting.
    /// </summary>
    private static async Task<IResult> PlaceOrder(
        [FromBody] CreateOrderRequest body,
        System.Security.Claims.ClaimsPrincipal principal,
        ScopeRepository scopes,
        CartStore carts,
        OrderWriteRepository orders,
        CancellationToken ct)
    {
        if (principal.UserId() is not int userId) return Results.Unauthorized();
        if (!await InScopeAsync(scopes, userId, body.Mcc, ct).ConfigureAwait(false))
            return Results.NotFound();
        if (body.Items.Count == 0)
            return Results.BadRequest(new { error = "An order needs at least one test." });

        var result = await orders.CreateAsync(userId, body, ct).ConfigureAwait(false);

        if (!result.Ok)
        {
            // The procedure's own message is the useful one — it knows about
            // duplicate barcodes, the mobile allowance and unpriced items.
            return Results.BadRequest(new { error = result.Message, code = result.ErrorCode });
        }

        // Only once the order is safely placed. Clearing earlier would lose the
        // operator's work on any failure.
        await carts.ClearAsync(userId, ct).ConfigureAwait(false);

        return Results.Ok(result);
    }

    /// <summary>
    /// An empty operational scope means unrestricted, matching the convention
    /// the orders list already uses.
    /// </summary>
    private static async Task<bool> InScopeAsync(
        ScopeRepository scopes, int userId, int mcc, CancellationToken ct)
    {
        var scope = await scopes.GetScopeAsync(userId, ct).ConfigureAwait(false);
        return scope.Count == 0 || scope.Contains(mcc);
    }
}
