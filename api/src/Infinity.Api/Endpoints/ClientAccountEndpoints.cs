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

        // report:release — the capability that has existed unused since the
        // roles were written, and this is what it is for: letting a named
        // person release a client's reports against the money rule. NOT
        // billing:view (that is a read) and not payment:capture (this takes no
        // money) — it decides that results go out unpaid.
        g.MapPost("/{mcc:int}/unlock", SetUnlock)
         .RequireCapability(Capabilities.ReportRelease)
         .WithName("SetClientReportUnlock");
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
    /// Grant or revoke the master unlock: release this client's reports however
    /// much they owe, or put them back under the balance rule.
    /// </summary>
    /// <remarks>
    /// This writes the LIS's own PerminentUnlock bit, so the release applies in
    /// Telo and the legacy LIS too — see 120_client_report_unlock.sql. The
    /// lock itself is cached per SID for a minute, so a change takes up to that
    /// long to be felt on reports already looked at; the response says so
    /// rather than leaving an operator wondering why the report is still held.
    /// </remarks>
    private static async Task<IResult> SetUnlock(
        int mcc,
        [FromBody] UnlockRequest body,
        System.Security.Claims.ClaimsPrincipal principal,
        ScopeRepository scopes,
        ClientAccountRepository repo,
        ILoggerFactory loggers,
        CancellationToken ct)
    {
        if (principal.UserId() is not int userId) return Results.Unauthorized();

        // Operational scope, as for any write here: a login that cannot act for
        // this client cannot release it either.
        if (!await InScopeAsync(scopes, userId, mcc, ct).ConfigureAwait(false))
            return Results.NotFound();

        // A grant is a money decision someone has to answer for later, so it
        // does not happen anonymously. Revoking needs no justification: putting
        // a client back under the rule is the default state.
        if (body.Unlocked && string.IsNullOrWhiteSpace(body.Reason))
            return Results.BadRequest(new { error = "Say why this client is being released." });

        var actor = principal.Identity?.Name;
        var r = await repo.SetUnlockAsync(mcc, body.Unlocked, body.Reason, userId, actor, ct)
            .ConfigureAwait(false);

        if (!r.Ok) return Results.BadRequest(new { error = r.Message, code = r.ErrorCode });

        // Loud on purpose. This is the one action here that lets results leave
        // the building against the money rule, and it should be greppable.
        loggers.CreateLogger("ClientUnlock").LogWarning(
            "client.unlock.{Action} mcc={Mcc} code={Code} by={Actor} balance={Balance} changed={Changed}",
            r.Unlocked ? "granted" : "revoked", mcc, r.ClientCode, actor ?? "?", r.Balance, r.Changed);

        return Results.Ok(new
        {
            r.ClientCode, r.ClientName, r.Unlocked, r.WasUnlocked, r.Changed,
            r.Balance, r.CreditLimit,
            note = "Reports already opened may take up to a minute to reflect this.",
        });
    }

    /// <param name="Reason">Required when granting; free text, kept in the audit trail.</param>
    public sealed record UnlockRequest(bool Unlocked, string? Reason);

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
