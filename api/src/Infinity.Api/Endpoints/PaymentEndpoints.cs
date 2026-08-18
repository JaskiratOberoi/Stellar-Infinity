using System.Globalization;
using Infinity.Api.Auth;
using Infinity.Api.Payments;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Options;

namespace Infinity.Api.Endpoints;

/// <summary>
/// Online payment against a client account, through CCAvenue.
///
/// -- THE TRUST BOUNDARY ----------------------------------------------------
/// Two endpoints, and they trust completely different things.
///
/// /checkout is ours. It is authenticated, scope-checked, and it decides the
/// amount. Nothing the browser sends afterwards can change that figure.
///
/// /callback is the public internet. CCAvenue posts to it, but so can anyone
/// who knows the URL. It is anonymous by necessity — the customer arrives back
/// on a cross-site POST, which carries no session — so it authenticates the
/// MESSAGE instead of the caller: the body must decrypt under our working key,
/// and must name an order we minted. Everything that matters is then read from
/// our own intent row, not from the response.
///
/// The one thing taken from the response is the pass/fail and the tracking id.
/// The amount is compared, never adopted: see 112_usp_inf_payment_intent.sql.
/// </summary>
public static class PaymentEndpoints
{
    public static void MapPaymentEndpoints(this WebApplication app)
    {
        var g = app.MapGroup("/api/payments");

        g.MapGet("/config", GetConfig)
         .RequireAuthorization()
         .WithName("PaymentConfig");

        g.MapPost("/checkout", Checkout)
         .RequireAuthorization()
         .RequireRateLimiting(RateLimitPolicies.Payment)
         .WithName("PaymentCheckout");

        // Anonymous, and it must stay that way — the customer returns on a
        // cross-site POST with no cookie. Rate-limited because it is the one
        // unauthenticated write in the system.
        g.MapPost("/callback", Callback)
         .AllowAnonymous()
         .RequireRateLimiting(RateLimitPolicies.Payment)
         .WithName("PaymentCallback");
    }

    /// <summary>
    /// Whether the pay button should exist at all. The SPA asks rather than
    /// assuming, so that a stack with no gateway configured shows an honest
    /// "not available" instead of a control that fails on click.
    /// </summary>
    private static IResult GetConfig(IOptions<CCAvenueOptions> opts)
    {
        var o = opts.Value;
        return Results.Ok(new
        {
            enabled = o.Enabled,
            maxAmount = o.MaxAmount,
            // Deliberately not the access code or the working key. The browser
            // gets the access code only inside a minted checkout, where it is
            // paired with a request we have already authorised.
            test = o.GatewayUrl.Contains("test.ccavenue.com", StringComparison.OrdinalIgnoreCase),
        });
    }

    public sealed record CheckoutRequest(int Mcc, int Amount);

    /// <summary>
    /// Mint an intent and hand back the encrypted request.
    ///
    /// The response is everything the browser needs to POST itself to CCAvenue
    /// and nothing more. It does NOT include the working key — the encryption
    /// happens here, so the secret never reaches a client.
    /// </summary>
    private static async Task<IResult> Checkout(
        [FromBody] CheckoutRequest body,
        System.Security.Claims.ClaimsPrincipal principal,
        ScopeRepository scopes,
        PaymentRepository payments,
        IOptions<CCAvenueOptions> opts,
        ILoggerFactory logs,
        CancellationToken ct)
    {
        var o = opts.Value;
        if (!o.Enabled)
            return Results.BadRequest(new { error = "Online payment is not configured on this deployment." });

        if (principal.UserId() is not int userId) return Results.Unauthorized();

        // Operational scope, the same membership test order creation uses. A
        // client login can pay for its own account and no other; `Contains`
        // rather than `Count > 0 &&`, because an empty scope means no clients,
        // not all of them.
        var scope = await scopes.GetScopeAsync(userId, ct).ConfigureAwait(false);
        if (!scope.Contains(body.Mcc)) return Results.NotFound();

        // Whole rupees. The wallet procedure takes an INT and the ledger is
        // kept in rupees; accepting paise here would round somewhere invisible.
        if (body.Amount <= 0)
            return Results.BadRequest(new { error = "A payment must be greater than zero." });
        if (body.Amount > o.MaxAmount)
            return Results.BadRequest(new { error = $"The most that can be paid online at once is {o.MaxAmount:N0}." });

        // Unguessable, and unique by construction. A sequential reference would
        // let anyone who made one payment enumerate everyone else's.
        var orderRef = "INF" + Guid.NewGuid().ToString("N")[..20].ToUpperInvariant();

        var intent = await payments.CreateAsync(userId, body.Mcc, body.Amount, orderRef, ct).ConfigureAwait(false);
        if (!intent.Ok)
            return Results.BadRequest(new { error = intent.Message ?? "The payment could not be started." });

        var plain = CCAvenueCrypto.BuildPairs(
        [
            new("merchant_id", o.MerchantId),
            new("order_id", orderRef),
            new("amount", body.Amount.ToString("0.00", CultureInfo.InvariantCulture)),
            new("currency", "INR"),
            new("redirect_url", o.RedirectUrl),
            new("cancel_url", o.CancelUrl),
            new("language", "EN"),
            // Echoed back verbatim by the gateway. Useful in the response log;
            // NOT used to decide anything, since the customer could alter it in
            // the intervening form post.
            new("merchant_param1", body.Mcc.ToString(CultureInfo.InvariantCulture)),
        ]);

        // The plaintext is logged deliberately. It carries no secret — merchant
        // id, our order reference, an amount and our own URLs — and when the
        // gateway rejects a request it is the only way to see what it was
        // actually sent. CCAvenue's errors name a field ("Working is empty")
        // without echoing what arrived, so without this the diagnosis is
        // guesswork. The access code and working key are NOT in it.
        logs.CreateLogger("Payments").LogInformation(
            "payment.intent ref={Ref} mcc={Mcc} amount={Amount} user={User} request={Request}",
            orderRef, body.Mcc, body.Amount, userId, plain);

        return Results.Ok(new
        {
            gatewayUrl = o.GatewayUrl,
            accessCode = o.AccessCode,
            encRequest = CCAvenueCrypto.Encrypt(plain, o.WorkingKey),
            orderRef,
            amount = body.Amount,
        });
    }

    /// <summary>
    /// The gateway's answer, and the customer's browser, arriving together.
    ///
    /// Always a redirect back into the SPA, never a JSON body: a person is
    /// looking at this response. The outcome travels in the query string as a
    /// status word only — no amount, no client code, nothing that would put a
    /// payment detail into a URL, a browser history and a proxy log.
    /// </summary>
    private static async Task<IResult> Callback(
        HttpRequest request,
        PaymentRepository payments,
        IOptions<CCAvenueOptions> opts,
        ILoggerFactory logs,
        CancellationToken ct)
    {
        var log = logs.CreateLogger("Payments");
        var o = opts.Value;
        var home = o.PublicBaseUrl.TrimEnd('/') + "/client";

        if (!o.Enabled) return Results.Redirect(home + "?pay=unavailable");

        string? encResp = null;
        if (request.HasFormContentType)
        {
            var form = await request.ReadFormAsync(ct).ConfigureAwait(false);
            encResp = form["encResp"].ToString();
        }

        var plain = string.IsNullOrWhiteSpace(encResp)
            ? null
            : CCAvenueCrypto.TryDecrypt(encResp, o.WorkingKey);

        // Undecryptable means it was not produced with our working key. That is
        // a stranger at the URL, not a payment, and it is logged as such
        // without echoing the body back into the log.
        if (plain is null)
        {
            log.LogWarning("payment.callback.undecryptable len={Len} ip={Ip}",
                encResp?.Length ?? 0, request.HttpContext.Connection.RemoteIpAddress);
            return Results.Redirect(home + "?pay=invalid");
        }

        var p = CCAvenueCrypto.ParsePairs(plain);
        var orderRef = p.GetValueOrDefault("order_id", "").Trim();
        var trackingId = p.GetValueOrDefault("tracking_id", "").Trim();
        var rawStatus = p.GetValueOrDefault("order_status", "").Trim();
        var message = p.GetValueOrDefault("failure_message", "").Trim();
        if (message.Length == 0) message = p.GetValueOrDefault("status_message", "").Trim();

        if (orderRef.Length == 0) return Results.Redirect(home + "?pay=invalid");

        // CCAvenue says Success / Failure / Aborted / Invalid. Anything we do
        // not recognise is a failure, not a success — the default must be the
        // one that does not move money.
        var status = rawStatus.ToLowerInvariant() switch
        {
            "success" => "success",
            "aborted" => "aborted",
            _ => "failed",
        };

        decimal? amount = decimal.TryParse(p.GetValueOrDefault("amount", ""),
            NumberStyles.Number, CultureInfo.InvariantCulture, out var a) ? a : null;

        var r = await payments.SettleAsync(
            orderRef, trackingId, status, amount, Trim(message, 400), o.PaymentMode, ct).ConfigureAwait(false);

        log.LogInformation(
            "payment.callback ref={Ref} gatewaySaid={Raw} recorded={Status} ok={Ok} code={Code}",
            orderRef, rawStatus, r.Status, r.Ok, r.ErrorCode);

        // A mismatch is reported to the customer as a failure, because from
        // their side nothing was credited. It is separately visible as
        // 'mismatch' in inf_payment_intent for whoever reconciles.
        // An order we never minted is reported exactly like a body that did not
        // decrypt: "invalid", the same answer undecryptable garbage gets.
        //
        // Not cosmetic. Distinguishing "unknown order" from "known order, wrong
        // amount" makes this endpoint an oracle for which references exist —
        // anyone could sit on it and learn valid order refs by watching which
        // answer comes back. The refs are 20 hex characters of a GUID and so
        // are not realistically guessable, but an endpoint that confirms a
        // guess is a thing not to build in the first place.
        if (r.ErrorCode == "UNKNOWN") return Results.Redirect(home + "?pay=invalid");

        var outcome = (r.Ok, r.Status) switch
        {
            (true, "success") => "success",
            (true, "aborted") => "cancelled",
            (true, "mismatch") => "mismatch",
            (true, _) => "failed",
            _ => "error",
        };

        return Results.Redirect(home + "?pay=" + outcome);
    }

    private static string? Trim(string? s, int max) =>
        string.IsNullOrWhiteSpace(s) ? null : s.Length <= max ? s : s[..max];
}
