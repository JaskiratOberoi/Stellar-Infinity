using Infinity.Api.Auth;
using Infinity.Api.Orders;
using Microsoft.AspNetCore.Mvc;

namespace Infinity.Api.Endpoints;

/// <summary>
/// Client accounts — what each client owes, the movements behind it, and
/// recording a payment.
///
/// Gated on billing:view for the reads and payment:capture for the write. A
/// technologist has neither; what a client owes is commercial information and
/// taking money against an account is a stronger act still.
/// </summary>
public static class ClientAccountEndpoints
{
    public static void MapClientAccountEndpoints(this WebApplication app)
    {
        var g = app.MapGroup("/api/accounts").RequireAuthorization();

        g.MapGet("/", ListAccounts)
         .RequireCapability(Capabilities.BillingView)
         .WithName("ListClientAccounts");

        g.MapGet("/{mcc:int}/ledger", Ledger)
         .RequireCapability(Capabilities.BillingView)
         .WithName("ClientLedger");

        g.MapPost("/{mcc:int}/payments", RecordPayment)
         .RequireCapability(Capabilities.PaymentCapture)
         .WithName("RecordClientPayment");
    }

    private static async Task<IResult> ListAccounts(
        System.Security.Claims.ClaimsPrincipal principal,
        ScopeRepository scopes,
        ClientAccountRepository repo,
        CancellationToken ct,
        string? search = null,
        bool onlyOwing = false,
        int page = 1,
        int pageSize = 100)
    {
        if (principal.UserId() is not int userId) return Results.Unauthorized();

        // Report scope: this is a commercial view of the same client set the
        // reporting screens cover, not an operational action.
        var scope = await scopes.GetReportClientCodesAsync(userId, principal.Role(), ct).ConfigureAwait(false);
        if (scope.IsDenied)
            return Results.Ok(new { rows = Array.Empty<object>(), count = 0, total = 0, page = 1, pageSize, pageCount = 0 });

        var r = await repo.ListAsync(scope.ClientCodes, search, onlyOwing, page, pageSize, ct)
            .ConfigureAwait(false);

        return Results.Ok(new
        {
            rows = r.Rows,
            count = r.Rows.Count,
            total = r.Total,
            page = r.Page,
            pageSize = r.PageSize,
            pageCount = r.PageCount,
            // The sum across the WHOLE filtered set would need a second query;
            // this is the page's share and is labelled as such by the UI.
            pageOwed = r.Rows.Sum(x => x.Owed > 0 ? x.Owed : 0m),
        });
    }

    private static async Task<IResult> Ledger(
        int mcc,
        System.Security.Claims.ClaimsPrincipal principal,
        ScopeRepository scopes,
        ClientAccountRepository repo,
        CancellationToken ct,
        int page = 1,
        int pageSize = 100)
    {
        if (principal.UserId() is not int userId) return Results.Unauthorized();
        if (!await InScopeAsync(scopes, userId, mcc, ct).ConfigureAwait(false)) return Results.NotFound();

        var r = await repo.LedgerAsync(mcc, page, pageSize, ct).ConfigureAwait(false);
        return Results.Ok(new
        {
            rows = r.Rows, count = r.Rows.Count, total = r.Total,
            page = r.Page, pageSize = r.PageSize, pageCount = r.PageCount,
        });
    }

    public sealed record PaymentRequest(int Amount, int Mode, string? ChequeNo, string? Reason);

    /// <summary>
    /// Record a payment from a client.
    ///
    /// Real money. The procedure credits the running balance and appends a
    /// ledger row in one transaction, and this is deliberately not retried —
    /// a replay after a timeout would credit them twice.
    /// </summary>
    private static async Task<IResult> RecordPayment(
        int mcc,
        [FromBody] PaymentRequest body,
        System.Security.Claims.ClaimsPrincipal principal,
        ScopeRepository scopes,
        ClientAccountRepository repo,
        CancellationToken ct)
    {
        if (principal.UserId() is not int userId) return Results.Unauthorized();

        // Operational scope for a write, matching order creation. Membership,
        // not `Count > 0 &&`: an empty list means no clients, not all of them.
        var scope = await scopes.GetScopeAsync(userId, ct).ConfigureAwait(false);
        if (!scope.Contains(mcc)) return Results.NotFound();

        if (body.Amount <= 0)
            return Results.BadRequest(new { error = "A payment must be greater than zero." });

        var r = await repo.RecordPaymentAsync(
            userId, mcc, body.Amount, body.Mode, body.ChequeNo, body.Reason, ct).ConfigureAwait(false);

        return r.Ok
            ? Results.Ok(r)
            : Results.BadRequest(new { error = r.Message, code = r.ErrorCode });
    }

    /// <summary>
    /// An empty operational scope means NO clients. See the note in
    /// OrderEntryEndpoints for why the obvious-looking alternative is wrong.
    /// </summary>
    private static async Task<bool> InScopeAsync(
        ScopeRepository scopes, int userId, int mcc, CancellationToken ct)
    {
        var scope = await scopes.GetScopeAsync(userId, ct).ConfigureAwait(false);
        return scope.Contains(mcc);
    }
}
