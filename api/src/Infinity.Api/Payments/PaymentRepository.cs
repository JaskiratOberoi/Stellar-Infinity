using System.Data;
using Infinity.Api.Data;
using Infinity.Api.Reads;

namespace Infinity.Api.Payments;

/// <param name="OrderRef">Our reference, minted before the customer leaves.</param>
public sealed record IntentResult(bool Ok, string? ErrorCode, string? Message, string? OrderRef, decimal Amount);

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
}
