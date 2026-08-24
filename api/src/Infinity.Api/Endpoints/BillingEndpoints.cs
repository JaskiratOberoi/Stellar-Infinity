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

        // Void, edit, discount, cancellations and refunds are Telo's
        // super-admin controls, and they stay super-admin here: user:manage is
        // the capability only that role holds, so it is the honest marker.
        // Recording a NEW receipt stays with payment:capture — taking money at
        // the counter is ordinary desk work; rewriting it afterwards is not.
        g.MapPost("/receipts/{receiptId:int}/void", VoidReceipt)
         .RequireCapability(Capabilities.UserManage)
         .WithName("VoidReceipt");

        g.MapPut("/receipts/{receiptId:int}", EditReceipt)
         .RequireCapability(Capabilities.UserManage)
         .WithName("EditReceipt");

        g.MapPut("/discount", SetDiscount)
         .RequireCapability(Capabilities.UserManage)
         .WithName("SetBillDiscount");

        g.MapPost("/cancel-test", CancelTest)
         .RequireCapability(Capabilities.UserManage)
         .WithName("CancelBillTest");

        g.MapPost("/refund", RecordRefund)
         .RequireCapability(Capabilities.UserManage)
         .WithName("RecordBillRefund");

        g.MapPost("/cancel-booking", CancelBooking)
         .RequireCapability(Capabilities.UserManage)
         .WithName("CancelBooking");

        // The Bills page — Telo's balances screen for the B2C franchise
        // brands. Scope is checked per user AND the code must be a B2C one:
        // a B2B client's money lives on its ledger, not on per-patient bills.
        app.MapGet("/api/bills/{mcc:int}", GetBills)
           .RequireAuthorization()
           .RequireCapability(Capabilities.BillingView)
           .WithName("GetBills");
    }

    public sealed record ReceiptRequest(int Amount, string? PayMode, string? Reference);

    private static async Task<IResult> RecordReceipt(
        int billId,
        [FromBody] ReceiptRequest body,
        System.Security.Claims.ClaimsPrincipal principal,
        ScopeRepository scopes,
        OrdersRepository orders,
        BillingRepository billing,
        Audit.AuditLog audit,
        HttpContext http,
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

        audit.Log("payment.recorded", actor: userId, billId: billId, ip: Audit.AuditIp.From(http),
            details: new { amount = body.Amount, mode = body.PayMode ?? "Cash", reference = body.Reference });

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
        Audit.AuditLog audit,
        HttpContext http,
        CancellationToken ct)
    {
        if (principal.UserId() is not int userId) return Results.Unauthorized();
        if (!await CanTouchAsync(scopes, orders, userId, billId, ct).ConfigureAwait(false))
            return Results.NotFound();

        var r = await billing.VoidReceiptAsync(userId, receiptId, billId, body.Reason, ct)
            .ConfigureAwait(false);

        if (r.Ok)
            audit.Log("receipt.voided", actor: userId, billId: billId, ip: Audit.AuditIp.From(http),
                details: new { receiptId, reason = body.Reason });
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
        Audit.AuditLog audit,
        HttpContext http,
        CancellationToken ct)
    {
        if (principal.UserId() is not int userId) return Results.Unauthorized();
        if (body.NewAmount < 0)
            return Results.BadRequest(new { error = "A receipt cannot be negative." });
        if (!await CanTouchAsync(scopes, orders, userId, billId, ct).ConfigureAwait(false))
            return Results.NotFound();

        var r = await billing.EditReceiptAsync(userId, receiptId, billId, body.NewAmount, body.Reason, ct)
            .ConfigureAwait(false);

        if (r.Ok)
            audit.Log("receipt.amount.edited", actor: userId, billId: billId, ip: Audit.AuditIp.From(http),
                details: new { receiptId, newAmount = body.NewAmount, reason = body.Reason });
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
        Audit.AuditLog audit,
        HttpContext http,
        CancellationToken ct)
    {
        if (principal.UserId() is not int userId) return Results.Unauthorized();
        if (body.Discount < 0)
            return Results.BadRequest(new { error = "A discount cannot be negative." });
        if (!await CanTouchAsync(scopes, orders, userId, billId, ct).ConfigureAwait(false))
            return Results.NotFound();

        var r = await billing.SetDiscountAsync(userId, billId, body.Discount, ct).ConfigureAwait(false);

        if (r.Ok)
            audit.Log("bill.discount.set", actor: userId, billId: billId, ip: Audit.AuditIp.From(http),
                details: new { discount = body.Discount });
        return r.Ok ? Results.Ok(r) : Results.BadRequest(new { error = r.Message, code = r.ErrorCode });
    }

    /// <summary>
    /// Can this user act on this bill?
    ///
    /// Resolved by reading the bill through the scoped orders repository: it
    /// returns null both for a bill that does not exist and one outside scope,
    public sealed record CancelTestRequest(int LineId, string Reason);

    private static async Task<IResult> CancelTest(
        int billId,
        [FromBody] CancelTestRequest body,
        System.Security.Claims.ClaimsPrincipal principal,
        ScopeRepository scopes,
        OrdersRepository orders,
        BillingRepository billing,
        Audit.AuditLog audit,
        HttpContext http,
        CancellationToken ct)
    {
        if (principal.UserId() is not int userId) return Results.Unauthorized();
        if (string.IsNullOrWhiteSpace(body.Reason))
            return Results.BadRequest(new { error = "A reason is required to cancel a test." });
        if (!await CanTouchAsync(scopes, orders, userId, billId, ct).ConfigureAwait(false))
            return Results.NotFound();

        var r = await billing.CancelTestAsync(userId, billId, body.LineId, body.Reason.Trim(), ct)
            .ConfigureAwait(false);
        if (!r.Ok) return Results.BadRequest(new { error = r.Message, code = r.ErrorCode });
        audit.Log("bill.test.cancelled", actor: userId, billId: billId, ip: Audit.AuditIp.From(http),
            details: new { lineId = body.LineId, reason = body.Reason.Trim() });
        return Results.Ok(new { ok = true, balance = r.Balance });
    }

    public sealed record RefundRequest(int Amount, string? PayMode, string? Reference);

    private static async Task<IResult> RecordRefund(
        int billId,
        [FromBody] RefundRequest body,
        System.Security.Claims.ClaimsPrincipal principal,
        ScopeRepository scopes,
        OrdersRepository orders,
        BillingRepository billing,
        Audit.AuditLog audit,
        HttpContext http,
        CancellationToken ct)
    {
        if (principal.UserId() is not int userId) return Results.Unauthorized();
        if (body.Amount <= 0)
            return Results.BadRequest(new { error = "A refund must be greater than zero." });
        if (!await CanTouchAsync(scopes, orders, userId, billId, ct).ConfigureAwait(false))
            return Results.NotFound();

        var r = await billing.RecordRefundAsync(
            userId, billId, body.Amount, body.PayMode ?? "Cash", body.Reference, ct).ConfigureAwait(false);
        if (!r.Ok) return Results.BadRequest(new { error = r.Message, code = r.ErrorCode });
        audit.Log("payment.refunded", actor: userId, billId: billId, ip: Audit.AuditIp.From(http),
            details: new { amount = body.Amount, mode = body.PayMode ?? "Cash", reference = body.Reference });
        return Results.Ok(new { ok = true, balance = r.Balance });
    }

    public sealed record CancelBookingRequest(string Reason);

    /// <summary>
    /// Cancel the whole booking, orchestrated exactly as Telo's action does:
    /// cancel every active line (already-cancelled counts as done), clear any
    /// discount so the bill settles at exactly zero, then refund whatever was
    /// paid. A line that will not cancel stops the flow BEFORE any refund —
    /// partial cancellation with a full refund is money walking out the door.
    /// </summary>
    private static async Task<IResult> CancelBooking(
        int billId,
        [FromBody] CancelBookingRequest body,
        System.Security.Claims.ClaimsPrincipal principal,
        ScopeRepository scopes,
        OrdersRepository orders,
        BillingRepository billing,
        ILoggerFactory loggers,
        Audit.AuditLog audit,
        HttpContext http,
        CancellationToken ct)
    {
        if (principal.UserId() is not int userId) return Results.Unauthorized();
        if (string.IsNullOrWhiteSpace(body.Reason))
            return Results.BadRequest(new { error = "A reason is required to cancel the booking." });
        if (!await CanTouchAsync(scopes, orders, userId, billId, ct).ConfigureAwait(false))
            return Results.NotFound();

        var state = await billing.BillStateAsync(billId, ct).ConfigureAwait(false);
        if (state is null) return Results.NotFound();

        var reason = body.Reason.Trim();
        var cancelled = 0;
        var failures = new List<string>();
        foreach (var lineId in state.ActiveLineIds)
        {
            var res = await billing.CancelTestAsync(userId, billId, lineId, reason, ct).ConfigureAwait(false);
            if (res.Ok || res.ErrorCode == "ALREADY_CANCELLED") cancelled++;
            else failures.Add($"line {lineId}");
        }

        if (failures.Count > 0)
        {
            loggers.CreateLogger("Billing").LogWarning(
                "billing.cancelBooking.blocked billId={BillId} cancelled={Cancelled} blocked={Blocked}",
                billId, cancelled, failures.Count);
            return Results.BadRequest(new
            {
                error = $"Cancelled {cancelled} of {state.ActiveLineIds.Count} test(s). "
                      + $"Couldn't cancel {string.Join(", ", failures)} — likely already accessioned or a "
                      + "master package; resolve in the LIS, then try again. No refund was made.",
            });
        }

        // Fresh state: the cancellations recompute discount and paid figures.
        var after = await billing.BillStateAsync(billId, ct).ConfigureAwait(false);

        if (after is { Discount: not 0 })
        {
            var d = await billing.SetDiscountAsync(userId, billId, 0, ct).ConfigureAwait(false);
            if (!d.Ok)
                return Results.BadRequest(new { error = d.Message ?? "Tests cancelled, but the discount could not be cleared." });
        }

        var refunded = 0m;
        if (after is { AmountPaid: > 0 })
        {
            var rr = await billing.RecordRefundAsync(
                userId, billId, (int)Math.Round(after.AmountPaid), "Cash",
                $"booking cancelled: {reason}", ct).ConfigureAwait(false);
            if (!rr.Ok)
                return Results.BadRequest(new { error = rr.Message ?? "Tests cancelled, but the refund could not be recorded." });
            refunded = after.AmountPaid;
        }

        audit.Log("bill.booking.cancelled", actor: userId, billId: billId, ip: Audit.AuditIp.From(http),
            details: new { cancelled, refunded, reason });
        return Results.Ok(new { ok = true, cancelled, refunded });
    }

    private static async Task<IResult> GetBills(
        int mcc,
        System.Security.Claims.ClaimsPrincipal principal,
        ScopeRepository scopes,
        Reads.CatalogRepository catalog,
        BillingRepository billing,
        CancellationToken ct,
        string? from = null,
        string? to = null,
        string? q = null,
        int page = 1,
        // "My registrations" — this operator's own bills, in either counter.
        bool mine = false,
        // Every matching bill, for the Excel export and the printed statement.
        // Both describe the whole period; neither may ship the page on screen.
        bool all = false)
    {
        if (principal.UserId() is not int userId) return Results.Unauthorized();

        var scope = await scopes.GetScopeAsync(userId, ct).ConfigureAwait(false);
        var unrestricted = scope.Count > 1000;
        if (scope.Count == 0 || (!unrestricted && !scope.Contains(mcc)))
            return Results.NotFound();

        var code = await catalog.ClientCodeAsync(mcc, ct).ConfigureAwait(false);
        if (!Orders.DiscountPolicy.IsB2cClientCode(code))
            return Results.BadRequest(new { error = "Bills exist for B2C clients only — this client settles on its ledger." });

        var today = Reads.StatsRepository.TodayIst();
        var toDate = to ?? today;
        var fromDate = from ?? toDate[..8] + "01";
        const int pageSize = 50;
        var pg = Math.Max(1, page);

        int? mineId = mine ? userId : null;

        var totals = await billing.BillTotalsAsync(mcc, fromDate, toDate, q, mineId, ct).ConfigureAwait(false);
        var pageCount = Math.Max(1, (totals.Count + pageSize - 1) / pageSize);
        pg = Math.Min(pg, pageCount);

        var rows = await billing.BillsPageAsync(
            mcc, fromDate, toDate, q, pg, all ? 0 : pageSize, mineId, ct).ConfigureAwait(false);
        var collected = await billing.CollectedInPeriodAsync(mcc, fromDate, toDate, ct).ConfigureAwait(false);

        return Results.Ok(new
        {
            clientCode = code,
            totals,
            collected,
            rows,
            page = all ? 1 : pg,
            pageSize = all ? rows.Count : pageSize,
            pageCount = all ? 1 : pageCount,
            // True when the export hit its ceiling — the caller must say so
            // rather than hand over a workbook that silently stops.
            truncated = all && rows.Count >= Orders.BillingRepository.ExportRowCap,
            from = fromDate,
            to = toDate,
        });
    }

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
