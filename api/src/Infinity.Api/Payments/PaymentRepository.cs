using System.Data;
using Infinity.Api.Data;
using Infinity.Api.Reads;

namespace Infinity.Api.Payments;

/// <param name="OrderRef">Our reference, minted before the customer leaves.</param>
public sealed record IntentResult(bool Ok, string? ErrorCode, string? Message, string? OrderRef, decimal Amount);

/// <summary>
/// The centre's own details, for CCAvenue's billing_* parameters.
///
/// The LIS sends these on every request and has been taking payments on this
/// merchant account for years, so they are copied rather than reasoned about.
/// CCAvenue documents them as optional for the non-seamless flow; a merchant
/// profile can still be configured to require them, and matching the request
/// that demonstrably works costs one query.
/// </summary>
public sealed record BillingDetails(string? Name, string? Code, string? Email, string? Phone, string? City, string? Zip);

/// <param name="Status">success | failed | aborted | mismatch</param>
/// <param name="ErrorCode">
/// ALREADY marks a duplicate callback that changed nothing — a normal event,
/// not a failure, which is why it arrives with Ok = true.
/// </param>
public sealed record SettleResult(bool Ok, string? ErrorCode, string? Message, int? MccCode, decimal? Amount, string? Status);

/// <summary>
/// The intent record either side of a trip to the gateway.
///
/// Both halves are single procedure calls because both are money. The settle in
/// particular latches the intent and credits the wallet in ONE transaction —
/// see 112_usp_inf_payment_intent.sql for why splitting them loses payments.
/// </summary>
public sealed class PaymentRepository(NobleConnectionFactory db, SqlRetry retry)
{
    /// <summary>
    /// Mint an intent. Retried: nothing has been charged yet, and a duplicate
    /// reference is caught by the unique index rather than becoming a second
    /// payment.
    /// </summary>
    public Task<IntentResult> CreateAsync(
        int userId, int mcc, decimal amount, string orderRef, CancellationToken ct = default) =>
        retry.ExecuteAsync("payments.intent", token =>
            db.QueryAsync("payments.intent", async (conn, inner) =>
            {
                await using var cmd = db.CreateWriteCommand(conn, "dbo.usp_inf_payment_intent_create");
                cmd.Parameters.Add("@userId", SqlDbType.Int).Value = userId;
                cmd.Parameters.Add("@mcc", SqlDbType.Int).Value = mcc;
                cmd.Parameters.Add("@amount", SqlDbType.Decimal).Value = amount;
                cmd.Parameters["@amount"].Precision = 18;
                cmd.Parameters["@amount"].Scale = 2;
                cmd.Parameters.Add("@orderRef", SqlDbType.VarChar, 40).Value = orderRef;

                await using var r = await cmd.ExecuteReaderAsync(inner).ConfigureAwait(false);
                if (await r.ReadAsync(inner).ConfigureAwait(false))
                {
                    return new IntentResult(
                        (r.NullableInt("ok") ?? 0) == 1,
                        r.Str("error_code"), r.Str("message"),
                        r.StrOpt("order_ref"), r.NullableDec("amount") ?? 0m);
                }
                return new IntentResult(false, "NO_RESULT", "The payment procedure returned nothing.", null, 0m);
            }, token), ct);

    /// <summary>
    /// The centre's details for the billing_* parameters. Never fails the
    /// payment: a centre with no email on file still gets to pay, it just
    /// sends fewer optional fields.
    /// </summary>
    public Task<BillingDetails> BillingAsync(int mcc, CancellationToken ct = default) =>
        retry.ExecuteAsync("payments.billing", token =>
            db.QueryAsync("payments.billing", async (conn, inner) =>
            {
                await using var cmd = NobleConnectionFactory.CreateCommand(conn,
                    "SELECT MCCUnitName, MCCUnitCode, email, phone, city, zip " +
                    "FROM dbo.tbl_med_mcc_unit_master WHERE id = @mcc");
                cmd.Parameters.Add("@mcc", SqlDbType.Int).Value = mcc;

                await using var r = await cmd.ExecuteReaderAsync(inner).ConfigureAwait(false);
                if (await r.ReadAsync(inner).ConfigureAwait(false))
                {
                    return new BillingDetails(
                        r.StrOpt("MCCUnitName"), r.StrOpt("MCCUnitCode"), r.StrOpt("email"),
                        r.StrOpt("phone"), r.StrOpt("city"), r.StrOpt("zip"));
                }
                return new BillingDetails(null, null, null, null, null, null);
            }, token), ct);

    /// <summary>
    /// Settle against the gateway's answer.
    ///
    /// NOT retried. The procedure is idempotent by its own latch, so a retry
    /// would be safe for the wallet — but a retry here would also re-run after
    /// a timeout whose transaction may still be committing, and the honest
    /// answer to "did that land?" is to let the gateway call us again rather
    /// than to guess. This mirrors RecordPaymentAsync, and for the same reason.
    /// </summary>
    public Task<SettleResult> SettleAsync(
        string orderRef, string gatewayRef, string gatewayStatus,
        decimal? gatewayAmount, string? gatewayMessage, int paymentMode,
        string? instrument, string? card,
        CancellationToken ct = default) =>
        db.QueryAsync("payments.settle", async (conn, inner) =>
        {
            await using var cmd = db.CreateWriteCommand(conn, "dbo.usp_inf_payment_intent_settle");
            cmd.Parameters.Add("@orderRef", SqlDbType.VarChar, 40).Value = orderRef;
            cmd.Parameters.Add("@gatewayRef", SqlDbType.VarChar, 60).Value = gatewayRef ?? "";
            cmd.Parameters.Add("@gatewayStatus", SqlDbType.VarChar, 20).Value = gatewayStatus;
            cmd.Parameters.Add("@gatewayAmount", SqlDbType.Decimal).Value =
                gatewayAmount.HasValue ? gatewayAmount.Value : DBNull.Value;
            cmd.Parameters["@gatewayAmount"].Precision = 18;
            cmd.Parameters["@gatewayAmount"].Scale = 2;
            cmd.Parameters.Add("@gatewayMessage", SqlDbType.NVarChar, 400).Value =
                string.IsNullOrWhiteSpace(gatewayMessage) ? DBNull.Value : gatewayMessage.Trim();
            cmd.Parameters.Add("@paymentMode", SqlDbType.Int).Value = paymentMode;
            // Descriptive only — these decide no amount and gate no credit, so a
            // surprising value from the gateway is a labelling problem rather
            // than a money one. Truncated to the column rather than rejected for
            // the same reason: losing the label must not lose the payment.
            cmd.Parameters.Add("@instrument", SqlDbType.VarChar, 40).Value =
                string.IsNullOrWhiteSpace(instrument) ? DBNull.Value : Clip(instrument, 40);
            cmd.Parameters.Add("@card", SqlDbType.VarChar, 60).Value =
                string.IsNullOrWhiteSpace(card) ? DBNull.Value : Clip(card, 60);

            await using var r = await cmd.ExecuteReaderAsync(inner).ConfigureAwait(false);
            if (await r.ReadAsync(inner).ConfigureAwait(false))
            {
                return new SettleResult(
                    (r.NullableInt("ok") ?? 0) == 1,
                    r.Str("error_code"), r.Str("message"),
                    r.NullableInt("mcc_code"), r.NullableDec("amount"), r.StrOpt("status"));
            }
            return new SettleResult(false, "NO_RESULT", "The settle procedure returned nothing.", null, null, null);
        }, ct);

    private static string Clip(string s, int max)
    {
        var t = s.Trim();
        return t.Length <= max ? t : t[..max];
    }
}
