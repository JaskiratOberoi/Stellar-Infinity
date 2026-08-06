using Infinity.Api.Auth;
using Infinity.Api.Orders;
using Infinity.Api.Reads;

namespace Infinity.Api.Endpoints;

/// <summary>
/// The printable invoice for one bill.
///
/// Two documents come out of the same data:
///
///   costing — what the payer owes. Tests, amounts, discount, paid, balance.
///             No sample ids, because it may leave the lab with the patient.
///   lab     — the same bill plus the sample ids, for the collection envelope
///             and the lab's own file.
///
/// This route returns only the BRANDING; the order itself is already loaded by
/// the screen that opens the invoice, and refetching it here would be a second
/// round trip to render a document the user is already looking at.
///
/// Keyed on billId rather than on the client id on purpose: authorisation is
/// then exactly "can you open this order", reusing the operational scope check
/// the order routes apply. A /invoice-config/{mcc} route would have been a new
/// place to get scope wrong.
/// </summary>
public static class InvoiceEndpoints
{
    public static void MapInvoiceEndpoints(this WebApplication app)
    {
        app.MapGroup("/api/orders/{billId:int}")
           .RequireAuthorization()
           .MapGet("/invoice", GetInvoice)
           // billing:view, not order:view. The costing document exists to state
           // an amount owed, and a technologist who may accession this order
           // must not be able to print one.
           .RequireCapability(Capabilities.BillingView)
           .WithName("GetOrderInvoice");
    }

    private static async Task<IResult> GetInvoice(
        int billId,
        System.Security.Claims.ClaimsPrincipal principal,
        ScopeRepository scopes,
        OrdersRepository orders,
        InvoiceRepository invoices,
        CancellationToken ct)
    {
        if (principal.UserId() is not int userId) return Results.Unauthorized();

        var scope = await scopes.GetScopeAsync(userId, ct).ConfigureAwait(false);
        var order = await orders.GetAsync(billId, scope, ct).ConfigureAwait(false);
        // Out of scope and nonexistent are both 404, as everywhere else — the
        // difference would let a caller enumerate other centres' bill ids.
        if (order is null) return Results.NotFound();

        // A bill with no centre is a walk-in against the lab itself. There is
        // no per-client branding to fetch; the renderer falls back to the
        // lab's own letterhead.
        var config = order.MccCode is int mcc
            ? await invoices.GetAsync(mcc, ct).ConfigureAwait(false)
            : null;

        return Results.Ok(new
        {
            config,
            disclaimer = InvoiceRepository.DisclaimerText,
        });
    }
}
