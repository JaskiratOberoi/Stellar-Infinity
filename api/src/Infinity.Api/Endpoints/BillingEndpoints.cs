using Infinity.Api.Auth;
using Infinity.Api.Orders;
using Infinity.Api.Reads;
using Microsoft.AspNetCore.Mvc;

namespace Infinity.Api.Endpoints;

/// <summary>
/// Money against one bill: receipts, voids, corrections, discounts.
///
/// Every route re-reads the bill through the orders repository first, which
/// applies the caller's operational scope. The underlying procedures take a
/// bill id and would happily act on any bill in the database; the scope check
/// is here, and skipping it on even one route would let a user take money
/// against another centre's patient.
/// </summary>
public static class BillingEndpoints
{
    public static void MapBillingEndpoints(this WebApplication app)
    {
        var g = app.MapGroup("/api/orders/{billId:int}").RequireAuthorization();

        g.MapPost("/receipts", RecordReceipt)
         .RequireCapability(Capabilities.PaymentCapture)
         .WithName("RecordReceipt");

        g.MapPost("/receipts/{receiptId:int}/void", VoidReceipt)
         .RequireCapability(Capabilities.PaymentCapture)
         .WithName("VoidReceipt");

        g.MapPut("/receipts/{receiptId:int}", EditReceipt)
         .RequireCapability(Capabilities.PaymentCapture)
         .WithName("EditReceipt");

        g.MapPut("/discount", SetDiscount)
         .RequireCapability(Capabilities.BillingView)
         .WithName("SetBillDiscount");
    }

    public sealed record ReceiptRequest(int Amount, string? PayMode, string? Reference);

    private static async Task<IResult> RecordReceipt(
        int billId,
        [FromBody] ReceiptRequest body,
        System.Security.Claims.ClaimsPrincipal principal,
        ScopeRepository scopes,
        OrdersRepository orders,
        BillingRepository billing,
        CancellationToken ct)
    {
        if (principal.UserId() is not int userId) return Results.Unauthorized();
        if (body.Amount <= 0)
            return Results.BadRequest(new { error = "A receipt must be greater than zero." });
        if (!await CanTouchAsync(scopes, orders, userId, billId, ct).ConfigureAwait(false))
            return Results.NotFound();

        var r = await billing.RecordReceiptAsync(
            userId, billId, body.Amount, body.PayMode ?? "Cash", body.Reference, ct).ConfigureAwait(false);

        if (!r.Ok) return Results.BadRequest(new { error = r.Message, code = r.ErrorCode });

        // Distinguished for the UI. Without a reference there is no idempotency
        // key at all, so "already recorded" can only ever be the truth about a
        // repeated gateway callback — never a silently swallowed duplicate at
        // the counter.
        return Results.Ok(r);
    }

    public sealed record VoidRequest(string? Reason);

    private static async Task<IResult> VoidReceipt(
        int billId, int receiptId,
        [FromBody] VoidRequest body,
        System.Security.Claims.ClaimsPrincipal principal,
        ScopeRepository scopes,
        OrdersRepository orders,
        BillingRepository billing,
        CancellationToken ct)
    {
        if (principal.UserId() is not int userId) return Results.Unauthorized();
        if (!await CanTouchAsync(scopes, orders, userId, billId, ct).ConfigureAwait(false))
            return Results.NotFound();

        var r = await billing.VoidReceiptAsync(userId, receiptId, billId, body.Reason, ct)
            .ConfigureAwait(false);

        return r.Ok ? Results.Ok(r) : Results.BadRequest(new { error = r.Message, code = r.ErrorCode });
    }

    public sealed record EditReceiptRequest(int NewAmount, string? Reason);

    private static async Task<IResult> EditReceipt(
        int billId, int receiptId,
        [FromBody] EditReceiptRequest body,
        System.Security.Claims.ClaimsPrincipal principal,
        ScopeRepository scopes,
        OrdersRepository orders,
        BillingRepository billing,
        CancellationToken ct)
    {
        if (principal.UserId() is not int userId) return Results.Unauthorized();
        if (body.NewAmount < 0)
            return Results.BadRequest(new { error = "A receipt cannot be negative." });
        if (!await CanTouchAsync(scopes, orders, userId, billId, ct).ConfigureAwait(false))
            return Results.NotFound();

        var r = await billing.EditReceiptAsync(userId, receiptId, billId, body.NewAmount, body.Reason, ct)
            .ConfigureAwait(false);

        return r.Ok ? Results.Ok(r) : Results.BadRequest(new { error = r.Message, code = r.ErrorCode });
    }

    public sealed record DiscountRequest(int Discount);

    private static async Task<IResult> SetDiscount(
        int billId,
        [FromBody] DiscountRequest body,
        System.Security.Claims.ClaimsPrincipal principal,
        ScopeRepository scopes,
        OrdersRepository orders,
        BillingRepository billing,
        CancellationToken ct)
    {
        if (principal.UserId() is not int userId) return Results.Unauthorized();
        if (body.Discount < 0)
            return Results.BadRequest(new { error = "A discount cannot be negative." });
        if (!await CanTouchAsync(scopes, orders, userId, billId, ct).ConfigureAwait(false))
            return Results.NotFound();

        var r = await billing.SetDiscountAsync(userId, billId, body.Discount, ct).ConfigureAwait(false);

        return r.Ok ? Results.Ok(r) : Results.BadRequest(new { error = r.Message, code = r.ErrorCode });
    }

    /// <summary>
    /// Can this user act on this bill?
    ///
    /// Resolved by reading the bill through the scoped orders repository: it
    /// returns null both for a bill that does not exist and one outside scope,
    /// which is also why every failure here is a 404 rather than a 403 — a
    /// distinction would let someone enumerate other centres' bill ids.
    /// </summary>
    private static async Task<bool> CanTouchAsync(
        ScopeRepository scopes, OrdersRepository orders, int userId, int billId, CancellationToken ct)
    {
        var scope = await scopes.GetScopeAsync(userId, ct).ConfigureAwait(false);
        if (scope.Count == 0) return false;   // no scope means no clients, not all clients

        return await orders.GetAsync(billId, scope, ct).ConfigureAwait(false) is not null;
    }
}
