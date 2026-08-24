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
        // Both anonymous, and token-signed instead. The customer reading a
        // receipt has just come back from CCAvenue and has no session cookie
        // - see PaymentReceiptLink.
        g.MapGet("/receipt/{orderRef}", Receipt)
         .AllowAnonymous()
         .RequireRateLimiting(RateLimitPolicies.Payment)
         .WithName("PaymentReceipt");

        g.MapGet("/receipt/{orderRef}/pdf", ReceiptPdf)
         .AllowAnonymous()
         .RequireRateLimiting(RateLimitPolicies.Payment)
         .WithName("PaymentReceiptPdf");

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
        Audit.AuditLog audit,
        HttpContext http,
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

        audit.Log("mcc.online_payment.initiated", actor: userId, ip: Audit.AuditIp.From(http),
            details: new { mcc = body.Mcc, amount = body.Amount, orderId = orderRef });

        // The centre's details, for billing_*. A failure here must not stop a
        // payment: these are optional fields and a blank one is better than a
        // dead button.
        BillingDetails billing;
        try
        {
            billing = await payments.BillingAsync(body.Mcc, ct).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            logs.CreateLogger("Payments").LogWarning(ex, "payment.billing.lookup.failed mcc={Mcc}", body.Mcc);
            billing = new BillingDetails(null, null, null, null, null, null);
        }

        /*
         * Shaped after the LIS's request, not after CCAvenue's documentation.
         *
         * The LIS has been taking payments on this same merchant account for
         * years, and where the two disagree the working one wins. What it does
         * that this did not:
         *
         *   • `tid` FIRST. CCAvenue's own sample leads with it and the LIS
         *     sends it on every request; we omitted it entirely.
         *   • billing_* on every request, from the centre's own record.
         *   • no trailing separator — see BuildPairs.
         *
         * `language` is kept, though the LIS omits it: current CCAvenue
         * documentation lists it as mandatory, and an extra recognised field is
         * a smaller risk than a missing required one.
         */
        var pairs = new List<KeyValuePair<string, string>>
        {
            // A per-attempt transaction id. The LIS hardcodes one, which means
            // every payment it has ever made shares a tid; a fresh value per
            // attempt is what the field is for.
            new("tid", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds().ToString(CultureInfo.InvariantCulture)),
            new("merchant_id", o.MerchantId),
            new("order_id", orderRef),
            new("amount", body.Amount.ToString("0.00", CultureInfo.InvariantCulture)),
            new("currency", "INR"),
            new("redirect_url", o.RedirectUrl),
            new("cancel_url", o.CancelUrl),
            new("language", "EN"),
        };

        // Only what we actually hold. An empty billing_email is worse than an
        // absent one — it is a value the gateway may try to validate.
        void AddIf(string key, string? value)
        {
            var v = value?.Trim();
            if (string.IsNullOrEmpty(v)) return;
            // These come from operator-entered LIS records, so unlike our own
            // URLs they can genuinely contain a separator. Dropping the
            // character keeps the payload parseable; BuildPairs would throw.
            pairs.Add(new(key, v.Replace("&", " ").Replace("=", " ")));
        }
        AddIf("billing_name", billing.Name);
        AddIf("billing_address", billing.Code);
        AddIf("billing_city", billing.City);
        AddIf("billing_zip", billing.Zip);
        AddIf("billing_tel", billing.Phone);
        AddIf("billing_email", billing.Email);
        if (!string.IsNullOrWhiteSpace(billing.City)) pairs.Add(new("billing_country", "India"));

        // Echoed back verbatim by the gateway. Useful in the response log; NOT
        // used to decide anything, since the customer could alter it in the
        // intervening form post.
        pairs.Add(new("merchant_param1", body.Mcc.ToString(CultureInfo.InvariantCulture)));

        var plain = CCAvenueCrypto.BuildPairs(pairs);

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
        PaymentReceiptLink receipts,
        ILoggerFactory logs,
        Audit.AuditLog audit,
        CancellationToken ct)
    {
        var log = logs.CreateLogger("Payments");
        var o = opts.Value;
        /*
         * Where the customer lands.
         *
         * NOT /client. That is behind the session guard, and the cookie is
         * SameSite=Strict - the browser sends nothing on a navigation chain
         * started by CCAvenue, so the SPA saw no session and bounced them to
         * the login screen seconds after taking their money.
         *
         * /payment/complete is public and carries its own signed token.
         */
        var baseUrl = o.PublicBaseUrl.TrimEnd('/');
        string Land(string outcome, string? reference = null) =>
            reference is null || !receipts.Enabled
                ? $"{baseUrl}/payment/complete?pay={outcome}"
                : $"{baseUrl}/payment/complete?pay={outcome}&ref={Uri.EscapeDataString(reference)}"
                  + $"&t={receipts.Token(reference)}";

        if (!o.Enabled) return Results.Redirect(Land("unavailable"));

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
            return Results.Redirect(Land("invalid"));
        }

        var p = CCAvenueCrypto.ParsePairs(plain);
        var orderRef = p.GetValueOrDefault("order_id", "").Trim();
        var trackingId = p.GetValueOrDefault("tracking_id", "").Trim();
        var rawStatus = p.GetValueOrDefault("order_status", "").Trim();
        var message = p.GetValueOrDefault("failure_message", "").Trim();
        if (message.Length == 0) message = p.GetValueOrDefault("status_message", "").Trim();

        if (orderRef.Length == 0) return Results.Redirect(Land("invalid"));

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

        // How they actually paid. CCAvenue sends payment_mode as a phrase
        // ("Credit Card", "Net Banking", "Unified Payments", "Wallet") and
        // card_name as the issuer or app behind it ("Visa", "Google Pay", a
        // bank). The LIS files every gateway payment as plain "Online", which
        // cannot answer "how much of last quarter came in on UPI" — so these
        // are kept beside the ledger row rather than folded away. See
        // 114_payment_instrument.sql for why they are not a new deposittype.
        var instrument = p.GetValueOrDefault("payment_mode", "").Trim();
        var card = p.GetValueOrDefault("card_name", "").Trim();

        var r = await payments.SettleAsync(
            orderRef, trackingId, status, amount, Trim(message, 400), o.PaymentMode,
            instrument, card, ct).ConfigureAwait(false);

        audit.Log("mcc.online_payment.result",
            details: new { orderId = orderRef, status = r.Status, ok = r.Ok,
                           amount, instrument = instrument.Length > 0 ? instrument : null });

        log.LogInformation(
            "payment.callback ref={Ref} gatewaySaid={Raw} recorded={Status} ok={Ok} code={Code} instrument={Instrument} card={Card}",
            orderRef, rawStatus, r.Status, r.Ok, r.ErrorCode, instrument, card);

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
        if (r.ErrorCode == "UNKNOWN") return Results.Redirect(Land("invalid"));

        var outcome = (r.Ok, r.Status) switch
        {
            (true, "success") => "success",
            (true, "aborted") => "cancelled",
            (true, "mismatch") => "mismatch",
            (true, _) => "failed",
            _ => "error",
        };

        return Results.Redirect(Land(outcome, orderRef));
    }

    /// <summary>
    /// One receipt, for the page the customer lands on after paying.
    ///
    /// Anonymous, because the customer has no session at this moment — the
    /// return from CCAvenue is a cross-site navigation and SameSite=Strict
    /// withholds the cookie. The token is what authorises it instead, and the
    /// 404 for a bad one is deliberate: a wrong token and an unknown reference
    /// must be indistinguishable, or this becomes a way to test whether a
    /// reference exists.
    /// </summary>
    private static async Task<IResult> Receipt(
        string orderRef,
        PaymentRepository payments,
        PaymentReceiptLink receipts,
        CancellationToken ct,
        string? t = null)
    {
        if (!receipts.Verify(orderRef, t)) return Results.NotFound();

        var r = await payments.GetReceiptAsync(orderRef, ct).ConfigureAwait(false);
        if (r is null) return Results.NotFound();

        return Results.Ok(new
        {
            orderRef = r.OrderRef,
            status = r.Status,
            amount = r.Amount,
            reference = r.GatewayRef,
            instrument = r.Instrument,
            card = r.Card,
            // Stamped with its offset before it leaves.
            //
            // settled_at is a naive DATETIME2 holding IST wall-clock, because
            // SYSDATETIME() runs on a SQL Server set to IST. Serialised bare it
            // says "17:12:36" with no offset, so a browser - and the PDF
            // renderer, whose container is UTC - reads it as UTC and then
            // formats it to IST, printing 10:42 pm on a payment taken at 5:12.
            // Five and a half hours wrong on a document someone files against
            // a bank statement.
            paidAt = r.SettledAt is null ? null
                : (DateTimeOffset?)new DateTimeOffset(r.SettledAt.Value, IstOffset),
            clientCode = r.ClientCode,
            clientName = r.ClientName,
        });
    }

    /// <summary>
    /// The same receipt as a PDF, rendered from the print page.
    ///
    /// The token travels through to the renderer in the URL, because the
    /// headless browser has no session either — it is the same trust story as
    /// the page itself, not a second one.
    /// </summary>
    private static async Task<IResult> ReceiptPdf(
        string orderRef,
        PaymentRepository payments,
        PaymentReceiptLink receipts,
        Infinity.Api.Reports.RenderClient render,
        ILoggerFactory logs,
        CancellationToken ct,
        string? t = null)
    {
        if (!receipts.Verify(orderRef, t)) return Results.NotFound();

        var r = await payments.GetReceiptAsync(orderRef, ct).ConfigureAwait(false);
        if (r is null) return Results.NotFound();
        // Only a settled payment has a receipt. Handing someone a PDF for a
        // pending or failed one would be a document saying money moved when it
        // has not.
        if (!string.Equals(r.Status, "success", StringComparison.OrdinalIgnoreCase))
            return Results.BadRequest(new { error = "That payment is not complete, so there is no receipt." });

        try
        {
            var pdf = await render.RenderAsync(
                [new Infinity.Api.Reports.RenderClient.ReportRequest(
                    Url: $"/print/payment-receipt/{Uri.EscapeDataString(orderRef)}?t={Uri.EscapeDataString(receipts.Token(orderRef))}",
                    Attachments: null,
                    Headless: true,
                    PageNumbers: false)],
                null,
                ct).ConfigureAwait(false);

            return Results.File(pdf, "application/pdf", $"Receipt_{Sanitise(orderRef)}.pdf");
        }
        catch (Infinity.Api.Reports.RenderFailedException ex)
        {
            logs.CreateLogger("Payments").LogError(ex, "payment.receipt.render.failed ref={Ref}", orderRef);
            return Results.Problem("The receipt could not be produced. The payment itself is recorded.");
        }
    }

    /// <summary>
    /// Asia/Kolkata. A constant rather than a lookup: India has one zone and
    /// has never observed daylight saving, so the offset cannot drift, and a
    /// tz database lookup would be one more thing to be missing in a container.
    /// </summary>
    private static readonly TimeSpan IstOffset = TimeSpan.FromMinutes(330);

    /// <summary>Filename-safe, because the reference reaches a Content-Disposition header.</summary>
    private static string Sanitise(string s) =>
        new(s.Where(c => char.IsLetterOrDigit(c) || c is '-' or '_').ToArray());

    private static string? Trim(string? s, int max) =>
        string.IsNullOrWhiteSpace(s) ? null : s.Length <= max ? s : s[..max];
}
