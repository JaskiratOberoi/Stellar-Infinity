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

        // ---- the branding editor -------------------------------------------
        //
        // user:manage, which is what Telo gates its own invoice admin on.
        //
        // rate:manage would read more naturally — this is commercial config and
        // Admins already hold it — but that is a WIDENING, and the table is one
        // Telo prints from live. Matching Telo means exactly the same people can
        // change the document in both systems for as long as both exist. Worth
        // revisiting when Telo retires; not worth diverging on beforehand.
        var admin = app.MapGroup("/api/invoice-config")
                       .RequireAuthorization()
                       .RequireCapability(Capabilities.UserManage);

        admin.MapGet("/{mcc:int}", GetConfig).WithName("GetInvoiceConfig");
        admin.MapPut("/{mcc:int}", SaveConfig).WithName("SaveInvoiceConfig");
    }

    /// <summary>
    /// What the editor posts. Every managed field, every time — see the
    /// procedure's header for why there is no partial update.
    /// </summary>
    public sealed record SaveRequest(
        string? LabName,
        string? Address,
        string? City,
        string? State,
        string? Pincode,
        string? Phone,
        string? Email,
        string? PreparedBy,
        string? OnBehalf,
        bool? ShowDisclaimer,
        bool? ShowSignatory);

    private static async Task<IResult> GetConfig(
        int mcc,
        System.Security.Claims.ClaimsPrincipal principal,
        ScopeRepository scopes,
        InvoiceRepository invoices,
        CancellationToken ct)
    {
        if (principal.UserId() is not int userId) return Results.Unauthorized();
        if (!await InScopeAsync(scopes, userId, mcc, ct).ConfigureAwait(false)) return Results.NotFound();

        var config = await invoices.GetAsync(mcc, ct).ConfigureAwait(false);
        return config is null
            ? Results.NotFound()
            // `stored` is what the editor binds to; `config.Flags` is what a
            // print would use. Both travel, because the screen shows both.
            : Results.Ok(new { config, stored = config.Stored, disclaimer = InvoiceRepository.DisclaimerText });
    }

    private static async Task<IResult> SaveConfig(
        int mcc,
        SaveRequest body,
        System.Security.Claims.ClaimsPrincipal principal,
        ScopeRepository scopes,
        InvoiceRepository invoices,
        ILoggerFactory loggers,
        CancellationToken ct)
    {
        if (principal.UserId() is not int userId) return Results.Unauthorized();
        if (!await InScopeAsync(scopes, userId, mcc, ct).ConfigureAwait(false)) return Results.NotFound();

        // Rejected rather than coerced, matching the procedure. A value that is
        // neither of these is a bug in the caller, and silently resolving it to
        // "client" would hide the bug behind a document that looks right.
        if (body.OnBehalf is not null &&
            body.OnBehalf.Trim().ToLowerInvariant() is not ("" or "client" or "qugen"))
        {
            return Results.BadRequest(new { error = "onBehalf must be \"client\", \"qugen\", or null for auto." });
        }

        try
        {
            var saved = await invoices.SaveAsync(mcc, new InvoiceRepository.InvoiceConfigEdit(
                body.LabName, body.Address, body.City, body.State, body.Pincode,
                body.Phone, body.Email, body.PreparedBy,
                body.OnBehalf, body.ShowDisclaimer, body.ShowSignatory), ct).ConfigureAwait(false);

            // The re-read decides the response: the editor then shows what the
            // invoice will actually say, not an echo of what was submitted.
            return saved is null
                ? Results.NotFound()
                : Results.Ok(new { config = saved, stored = saved.Stored, disclaimer = InvoiceRepository.DisclaimerText });
        }
        catch (Microsoft.Data.SqlClient.SqlException ex) when (ex.Class == 16)
        {
            // RAISERROR severity 16 from the procedure: the caller sent
            // something it validates. The message is ours and safe to return.
            loggers.CreateLogger(typeof(InvoiceEndpoints)).LogWarning(
                ex, "Invoice config save rejected for mcc {Mcc}", mcc);
            return Results.BadRequest(new { error = ex.Message });
        }
    }

    /// <summary>
    /// Operational scope, same resolution the order routes use. Editing a
    /// centre's letterhead is an act against that centre.
    /// </summary>
    private static async Task<bool> InScopeAsync(
        ScopeRepository scopes, int userId, int mcc, CancellationToken ct)
    {
        var scope = await scopes.GetScopeAsync(userId, ct).ConfigureAwait(false);
        return scope.Contains(mcc);
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
