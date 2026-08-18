namespace Infinity.Api.Payments;

/// <summary>
/// CCAvenue gateway settings.
///
/// ── NOTHING HERE HAS A DEFAULT THAT WORKS ──────────────────────────────────
/// There is deliberately no fallback merchant id, access code or working key.
/// A half-configured gateway that silently falls back to someone else's
/// credentials is worse than one that is plainly off, so <see cref="Enabled"/>
/// is computed from whether the three secrets are actually present.
///
/// The working key is CCAvenue's AES secret. Anyone holding it, plus the access
/// code, can mint a request we would honour and forge a response we would
/// believe. It belongs in the deployment's gitignored env file and nowhere
/// else — not in appsettings.json, not in compose, not in this repository:
///
///     CCAvenue__MerchantId=...
///     CCAvenue__AccessCode=...
///     CCAvenue__WorkingKey=...
///
/// ── THE CREDENTIALS ARE PER-URL ────────────────────────────────────────────
/// CCAvenue issues a separate access code and working key for every registered
/// URL. Staging and live therefore hold DIFFERENT triples, and each stack must
/// carry only its own. Signing a staging request with the live key does not
/// fail cleanly — it is rejected by the gateway as a bad merchant, which reads
/// like an outage rather than a misconfiguration.
///
/// ── TEST vs PRODUCTION ─────────────────────────────────────────────────────
/// The two environments are separate systems, not a flag on one. Transactions
/// sent to test.ccavenue.com are never processed. Point <see cref="GatewayUrl"/>
/// at test until the round trip is proven, then move it.
/// </summary>
public sealed class CCAvenueOptions
{
    public const string SectionName = "CCAvenue";

    public string MerchantId { get; set; } = "";
    public string AccessCode { get; set; } = "";
    public string WorkingKey { get; set; } = "";

    /// <summary>
    /// Test by default. Moving money is opt-in: a deployment that forgets to
    /// set this takes no real payments, which is the safe way to be wrong.
    /// </summary>
    public string GatewayUrl { get; set; } = "https://test.ccavenue.com/transaction/transaction.do?command=initiateTransaction";

    /// <summary>
    /// The origin CCAvenue has registered for this stack. The redirect and
    /// cancel URLs are built from it, and the gateway refuses any that it does
    /// not recognise — so this must match the URL the access code was issued
    /// against, exactly, scheme included.
    /// </summary>
    public string PublicBaseUrl { get; set; } = "";

    /// <summary>
    /// Ceiling on a single online payment, in rupees. Not a business rule so
    /// much as a blast radius: a mistyped amount, or a caller probing the
    /// endpoint, cannot mint an intent for an arbitrary sum.
    /// </summary>
    public int MaxAmount { get; set; } = 500_000;

    /// <summary>
    /// The payment-mode id recorded on the wallet credit.
    ///
    /// 5, because that is what the LIS already uses. Its own CCAvenue rows in
    /// tbl_med_mcc_account_detail carry deposittype 5 ("Online"), going back
    /// years. This defaulted to 2 ("transfer") on the reasoning that no mode
    /// id meant "online" - which was a guess made before anyone looked at the
    /// table, and would have filed these under a heading the lab's existing
    /// reports do not expect. Still configurable, but the default is now
    /// copied from evidence rather than inferred.
    /// </summary>
    public int PaymentMode { get; set; } = 5;

    /// <summary>
    /// Configured means all three secrets are present. Checked at startup and
    /// again per request, so that turning the gateway off is a matter of
    /// clearing an env var rather than shipping a build.
    /// </summary>
    public bool Enabled =>
        !string.IsNullOrWhiteSpace(MerchantId)
        && !string.IsNullOrWhiteSpace(AccessCode)
        && !string.IsNullOrWhiteSpace(WorkingKey)
        && !string.IsNullOrWhiteSpace(PublicBaseUrl);

    public string RedirectUrl => $"{PublicBaseUrl.TrimEnd('/')}/api/payments/callback";
    public string CancelUrl   => $"{PublicBaseUrl.TrimEnd('/')}/api/payments/callback";

    /// <summary>
    /// Validation for the half-configured case only. Being entirely unset is
    /// legitimate — it means no online payments — but three of four set is a
    /// deployment mistake worth failing loudly at startup.
    /// </summary>
    public List<string> Validate()
    {
        var errors = new List<string>();
        var present = new[] { MerchantId, AccessCode, WorkingKey, PublicBaseUrl }
            .Count(v => !string.IsNullOrWhiteSpace(v));

        if (present is > 0 and < 4)
            errors.Add("CCAvenue is partly configured. Set all of CCAvenue__MerchantId, __AccessCode, __WorkingKey and __PublicBaseUrl, or none of them.");

        if (Enabled && !Uri.TryCreate(PublicBaseUrl, UriKind.Absolute, out _))
            errors.Add("CCAvenue__PublicBaseUrl must be an absolute URL, matching the URL the access code was issued against.");

        if (MaxAmount <= 0) errors.Add("CCAvenue__MaxAmount must be positive.");

        return errors;
    }
}
