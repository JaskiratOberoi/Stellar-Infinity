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

        // Reference data for the order form's referrer pickers. A read, so it
        // sits with the rest of order entry rather than behind the write gate
        // that PlaceOrder needs.
        entry.MapGet("/referrers", GetReferrers).WithName("GetOrderReferrers");

        // Barcode collision feedback for the order form's Sample ID panel.
        entry.MapGet("/sid-taken", GetSidTaken).WithName("GetOrderSidTaken");

        entry.MapPost("/preview", PreviewOrder).WithName("PreviewOrder");
        entry.MapPost("/", PlaceOrder).WithName("PlaceOrder");
    }

    /// <summary>
    /// The referring doctors and customers the order form can offer.
    /// </summary>
    /// <remarks>
    /// Not scoped by client code: referrers are shared across the network, and
    /// the order itself is scoped by the centre the operator picked.
    /// </remarks>
    private static async Task<IResult> GetReferrers(
        ReferrerRepository repo,
        CancellationToken ct)
        => Results.Ok(await repo.GetAsync(ct).ConfigureAwait(false));

    /// <summary>
    /// Whether a barcode is already on a tube, so the order form can say so
    /// before the operator has typed out the rest of the patient.
    /// </summary>
    /// <remarks>
    /// Returns one bit and nothing about the sample it collides with — see the
    /// procedure's own note on why the check is global rather than scoped to
    /// the caller's centres, and why that does not make it a disclosure.
    ///
    /// Not scope-checked beyond the OrderCreate capability the whole group
    /// carries, because there is no client in the question to check against: a
    /// barcode is unique across the LIS, and the answer is the same whichever
    /// centre is asking.
    /// </remarks>
    private static async Task<IResult> GetSidTaken(
        AccessionRepository repo,
        [FromQuery] string? vailid,
        CancellationToken ct)
    {
        var v = (vailid ?? string.Empty).Trim();

        // Blank is not a question. Answering "free" would be true and useless;
        // the caller should not have asked.
        if (v.Length == 0) return Results.BadRequest(new { error = "A Sample ID is required." });

        // Bounded before it reaches SQL. The column is nvarchar(50), and a
        // longer string would either be silently truncated into a match against
        // a DIFFERENT barcode or rejected deep in the driver.
        if (v.Length > 50) return Results.BadRequest(new { error = "That Sample ID is too long." });

        return Results.Ok(new { vailid = v, taken = await repo.SidTakenAsync(v, ct).ConfigureAwait(false) });
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
    /// <param name="channel">
    /// <c>b2c</c> or <c>b2b</c>. The preview must be quoted in the channel the
    /// order will actually be placed in, or the operator agrees a total the
    /// bill then contradicts.
    /// </param>
    private static async Task<IResult> PreviewOrder(
        System.Security.Claims.ClaimsPrincipal principal,
        ScopeRepository scopes,
        CartStore carts,
        CatalogRepository catalog,
        OrderWriteRepository orders,
        CancellationToken ct,
        string? channel = null)
    {
        if (principal.UserId() is not int userId) return Results.Unauthorized();

        var (chan, chanError) = ResolveChannel(principal, channel);
        if (chanError is not null) return chanError;
        var b2b = chan == B2b;

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
            var mrp = p?.Mrp;
            var clientRate = p?.Rate;

            // WHAT THIS LINE IS BILLED AT — the one number that differs by
            // channel, and it mirrors the procedure exactly: with
            // @billAtMrp = 1 the special-rate and rate-list tiers are nulled
            // out and resolution falls straight through to MRP. Quoting the
            // rate here and billing MRP there is how a preview stops matching
            // the bill it produced.
            var charge = b2b ? mrp : clientRate;

            return new
            {
                kind = i.Kind,
                id = i.Id,
                code = p?.Code ?? i.Code,
                name = p?.Name ?? i.Name,
                mrp,
                rate = charge,
                // What the centre owes the lab for this line. Only meaningful
                // in B2B, where the patient's money and the lab's are
                // different numbers; null in B2C, where they are the same one.
                clientCost = b2b ? clientRate : null,
                // The centre's margin on this line, and null rather than zero
                // when either side is unknown — a missing price is not a
                // margin of nothing.
                margin = b2b && mrp is not null && clientRate is not null ? mrp - clientRate : null,
                // 'none' means the catalogue has no price for this client at
                // all. Surfaced per line so the operator sees WHICH item is
                // unpriced rather than only that the total looks wrong.
                //
                // In B2B the line bills at MRP regardless of which client tier
                // matched, so the source describes where the CLIENT'S COST came
                // from, not where the charge did.
                rateSource = p?.RateSource ?? "none",
            };
        }).ToArray();

        var total = lines.Sum(l => l.rate ?? 0m);

        // MARGIN IS COMPUTED OVER A SUBSET, DELIBERATELY.
        //
        // A line with no MRP has nothing to compare against, and folding it in
        // as a zero would read as a total loss on that line rather than as the
        // missing datum it is. So margin sums only over lines that carry an
        // MRP, and the number excluded travels with it — a margin figure whose
        // basis is invisible is worse than no margin figure, because someone
        // eventually prices a contract off it.
        //
        // A previous note here claimed MRP was missing for most of the
        // catalogue: "1,248 of 1,457 priced tests carry MRP = 0". That is not
        // true and the subsetting is not load-bearing. Measured directly:
        // 1,446 of 1,457 active tests carry an MRP, profiles and master
        // profiles are 100% covered, and of 1,000 rows returned by
        // usp_inf_catalog_search for a live client exactly 4 lacked one. The
        // old figure was almost certainly an id-vs-code join — the rate-list
        // tables name their key columns TestCode/profilecode but store the
        // numeric id, and joining them by code silently matches nothing.
        //
        // This matters more now than it did: in B2B the line is BILLED at MRP,
        // so a genuinely missing MRP is not a cosmetic gap in a margin figure,
        // it is a line that bills at nothing. Counted below as billedAtZero.
        var comparable = lines.Where(l => l.mrp is > 0m).ToArray();
        var comparableMrp = comparable.Sum(l => l.mrp ?? 0m);
        var comparableRate = comparable.Sum(l => l.clientCost ?? l.rate ?? 0m);

        return Results.Ok(new
        {
            channel = chan,
            lines,
            groups,
            total,
            margin = new
            {
                // In B2C: what the lab gives up against list price.
                // In B2B: what the CENTRE keeps — it collects MRP from the
                // patient and owes the lab its rate. Same subtraction, opposite
                // pocket, which is why the channel travels in the response.
                amount = comparableMrp - comparableRate,
                mrpTotal = comparableMrp,
                rateTotal = comparableRate,
                comparableLines = comparable.Length,
                // Lines with no MRP on record; the margin above ignores them.
                linesWithoutMrp = lines.Length - comparable.Length,
            },
            unpriced = lines.Count(l => l.rateSource == "none"),
            // B2B only, and the number that must not be ignored: these lines
            // would go onto the bill at zero, because MRP is what B2B charges
            // and they have none.
            billedAtZero = b2b ? lines.Count(l => l.mrp is null or 0m) : 0,
            // ── B2B LINES THAT LOSE THE CENTRE MONEY ──────────────────────
            // MRP is not reliably above the client's rate. Measured on ABC01's
            // catalogue: of 1,000 items, 755 price MRP exactly AT the client
            // rate and 91 price it BELOW — on those the patient pays less than
            // the centre owes the lab, and the centre is out of pocket on a
            // sale it just made.
            //
            // That is a real commercial fact about the rate lists, not a bug to
            // correct here, so the order is allowed. But it is surfaced as its
            // own count rather than buried in a net margin, where 91 losses
            // hide inside 150 gains and the total still looks positive.
            belowCost = b2b ? lines.Count(l => l.margin is < 0m) : 0,
        });
    }

    // ---- channels ------------------------------------------------------------

    private const string B2c = "b2c";
    private const string B2b = "b2b";

    /// <summary>
    /// Resolve the requested channel and check the caller may use it.
    /// </summary>
    /// <remarks>
    /// ── THE TWO SIDES ARE GATED DIFFERENTLY, ON PURPOSE ────────────────────
    /// B2B is checked strictly against <c>order:b2b</c>. It is new, nobody
    /// holds it yet, and it is the side that changes what a basket costs — a
    /// B2B order bills the patient at full MRP rather than at the client's
    /// negotiated rate.
    ///
    /// B2C accepts <c>order:b2c</c> OR plain <c>order:create</c>. Capabilities
    /// are baked into the JWT at sign-in and tokens last eight hours, so a
    /// strict check would break order placement for every operator already
    /// signed in until their token rotated — mid-shift, on a lab that runs
    /// around the clock. The fallback grants nothing new: every order:create
    /// holder could already place exactly these orders at exactly these prices.
    ///
    /// Remove the fallback once tokens have rotated. Until then the Client
    /// role's confinement to B2B is expressed in the role table but not yet
    /// enforced, which is the honest cost of not forcing a mass re-login.
    /// </remarks>
    private static (string Channel, IResult? Error) ResolveChannel(
        System.Security.Claims.ClaimsPrincipal principal, string? requested)
    {
        var channel = string.IsNullOrWhiteSpace(requested) ? B2c : requested.Trim().ToLowerInvariant();

        if (channel is not (B2c or B2b))
        {
            return (B2c, Results.BadRequest(new
            {
                error = "channel must be \"b2c\" or \"b2b\".",
            }));
        }

        if (channel == B2b && !principal.HasCapability(Capabilities.OrderB2b))
        {
            return (B2c, Results.Problem(
                title: "Forbidden",
                detail: "Raising a client (B2B) order requires the 'order:b2b' capability.",
                statusCode: StatusCodes.Status403Forbidden));
        }

        if (channel == B2c
            && !principal.HasCapability(Capabilities.OrderB2c)
            && !principal.HasCapability(Capabilities.OrderCreate))
        {
            return (B2c, Results.Problem(
                title: "Forbidden",
                detail: "Raising a walk-in (B2C) order requires the 'order:b2c' capability.",
                statusCode: StatusCodes.Status403Forbidden));
        }

        return (channel, null);
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

        var (channel, channelError) = ResolveChannel(principal, body.Channel);
        if (channelError is not null) return channelError;

        // Checked before anything is decoded: base64 inflates by a third, so a
        // 40 MB string is a 30 MB allocation before the cap would otherwise be
        // reached. The number matches Telo's cap so the same file is accepted
        // by both systems.
        if (body.ClinicalFileBase64 is { Length: > 0 } b64
            && b64.Length / 4 * 3 > OrderWriteRepository.ClinicalFileMaxBytes)
        {
            return Results.BadRequest(new
            {
                error = "The clinical history PDF is larger than 10 MB.",
            });
        }

        // The request's own BillAtMrp is DISCARDED and rederived here. It is the
        // bit that decides whether this basket is billed at the client's rate or
        // at MRP, and honouring a posted value would let any order:create holder
        // pick the price without holding the channel capability that authorises
        // it.
        var placed = body with { BillAtMrp = channel == B2b, Channel = channel };

        var result = await orders.CreateAsync(userId, placed, ct).ConfigureAwait(false);

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
    /// An empty operational scope means NO clients, not all of them.
    ///
    /// GetScopeAsync returns an explicit list of mcc ids — an unrestricted user
    /// gets every id expanded into it, not an empty list — which is why
    /// OrdersRepository returns nothing when the list is empty. An earlier
    /// version of this method read `scope.Count == 0 || scope.Contains(mcc)`,
    /// conflating it with the REPORT scope contract, where emptiness does mean
    /// unrestricted because that type carries a separate IsUnrestricted flag.
    /// The effect was that a user with no operational scope could book an order
    /// for any client in the database.
    /// </summary>
    private static async Task<bool> InScopeAsync(
        ScopeRepository scopes, int userId, int mcc, CancellationToken ct)
    {
        var scope = await scopes.GetScopeAsync(userId, ct).ConfigureAwait(false);
        return scope.Contains(mcc);
    }
}
