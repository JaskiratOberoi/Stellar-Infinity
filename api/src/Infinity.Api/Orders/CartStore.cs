using System.Text.Json;
using Infinity.Api.Caching;

using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using Infinity.Api.Auth;

namespace Infinity.Api.Orders;

/// <param name="Kind">test | profile | master</param>
public sealed record CartItem(string Kind, int Id, string? Code, string? Name);

/// <param name="Mcc">
/// The client this cart is being built for. Every price in the order depends on
/// it, so changing it empties the cart rather than silently repricing — an
/// operator who switched client and did not notice would otherwise bill one
/// client's tests at another's negotiated rates.
/// </param>
public sealed record Cart(int? Mcc, IReadOnlyList<CartItem> Items)
{
    public static readonly Cart Empty = new(null, []);
}

/// <summary>
/// The per-SESSION order cart.
///
/// Redis-backed with a 24-hour expiry: a cart is ephemeral shopping state, not
/// order data. Nothing here is a record of anything — the order only exists
/// once it is placed, and a cart lost to a Redis restart costs the operator a
/// re-entry, not a booking.
///
/// Keyed <c>inf:cart:&lt;userId&gt;:&lt;session&gt;</c> — the session being the
/// token's jti, one per sign-in. It was keyed on the user alone, and a client
/// LOGIN is shared by every desk and phone at that centre: one desk signing
/// in (which cleared the cart) or picking a client emptied the basket under
/// every other desk mid-order, whose next add then failed with "Choose a
/// client" (UP0804, 2026-10-05). A session key gives each sign-in its own
/// basket; sign-out drops it and the TTL sweeps the rest. Deliberately NOT
/// Telo's <c>telo:cart:</c> namespace: the two carts hold different shapes
/// and a collision would deserialise one as the other.
/// </summary>
public sealed partial class CartStore(InfinityCache cache, ILogger<CartStore> logger)
{
    private static readonly TimeSpan Ttl = TimeSpan.FromHours(24);
    private static string Key(CartOwner o) =>
        o.Session.Length == 0 ? $"inf:cart:{o.UserId}" : $"inf:cart:{o.UserId}:{o.Session}";

    private static readonly JsonSerializerOptions Json = new()
    {
        PropertyNameCaseInsensitive = true,
    };

    public async Task<Cart> GetAsync(CartOwner owner, CancellationToken ct = default)
    {
        var raw = await cache.GetAsync(Key(owner), ct).ConfigureAwait(false);
        if (string.IsNullOrEmpty(raw)) return Cart.Empty;

        try
        {
            return JsonSerializer.Deserialize<Cart>(raw, Json) ?? Cart.Empty;
        }
        catch (JsonException ex)
        {
            // A cart written by an older shape. Discarding it is right: the
            // alternative is a 500 on every page load until the key expires,
            // and the cost of being wrong is one re-entry.
            LogUnreadable(logger, owner.UserId, ex);
            return Cart.Empty;
        }
    }

    public Task SaveAsync(CartOwner owner, Cart cart, CancellationToken ct = default) =>
        cache.SetAsync(Key(owner), JsonSerializer.Serialize(cart, Json), Ttl, ct);

    public Task ClearAsync(CartOwner owner, CancellationToken ct = default) =>
        cache.RemoveAsync(Key(owner), ct);

    /// <summary>
    /// Point the cart at a client. Changing to a DIFFERENT client empties it —
    /// see the note on <see cref="Cart.Mcc"/>.
    /// </summary>
    public async Task<Cart> SetClientAsync(CartOwner owner, int mcc, CancellationToken ct = default)
    {
        var cart = await GetAsync(owner, ct).ConfigureAwait(false);
        var next = cart.Mcc == mcc ? cart with { Mcc = mcc } : new Cart(mcc, []);
        await SaveAsync(owner, next, ct).ConfigureAwait(false);
        return next;
    }

    public async Task<Cart> AddAsync(CartOwner owner, CartItem item, CancellationToken ct = default)
    {
        var cart = await GetAsync(owner, ct).ConfigureAwait(false);

        // A cart holds one of each item. Quantity is meaningless for a lab test
        // — you cannot run the same analyte twice on one sample and bill it
        // twice — so adding an item already present is a no-op, not a second
        // line. (Quantity DOES apply to custom non-lab lines, which are a
        // separate concept and not part of the cart.)
        if (cart.Items.Any(i => i.Kind == item.Kind && i.Id == item.Id)) return cart;

        var next = cart with { Items = [.. cart.Items, item] };
        await SaveAsync(owner, next, ct).ConfigureAwait(false);
        return next;
    }

    public async Task<Cart> RemoveAsync(CartOwner owner, string kind, int id, CancellationToken ct = default)
    {
        var cart = await GetAsync(owner, ct).ConfigureAwait(false);
        var next = cart with { Items = [.. cart.Items.Where(i => !(i.Kind == kind && i.Id == id))] };
        await SaveAsync(owner, next, ct).ConfigureAwait(false);
        return next;
    }

    [LoggerMessage(EventId = 5100, Level = LogLevel.Warning,
        Message = "cart.unreadable userId={UserId} — discarded")]
    private static partial void LogUnreadable(ILogger logger, int userId, Exception ex);
}

/// <summary>Whose basket: the user, and the sign-in (the token's jti).</summary>
public readonly record struct CartOwner(int UserId, string Session)
{
    public static CartOwner Of(ClaimsPrincipal principal) =>
        new(principal.UserId() ?? 0, principal.FindFirstValue(JwtRegisteredClaimNames.Jti) ?? string.Empty);
}
