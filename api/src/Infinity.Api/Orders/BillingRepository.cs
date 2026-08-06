using System.Data;
using Infinity.Api.Data;
using Infinity.Api.Reads;

namespace Infinity.Api.Orders;

/// <param name="AlreadyRecorded">
/// The same gateway reference had already been recorded, so nothing changed.
/// Only meaningful when a reference was supplied — see the note on
/// <see cref="BillingRepository.RecordReceiptAsync"/>.
/// </param>
public sealed record ReceiptResult(
    bool Ok, string? ErrorCode, string? Message,
    bool AlreadyRecorded, decimal? Balance, string? TxnId);

public sealed record VoidResult(
    bool Ok, string? ErrorCode, string? Message, bool AlreadyVoided, decimal? Balance);

public sealed record EditReceiptResult(
    bool Ok, string? ErrorCode, string? Message, bool Unchanged, decimal? OldAmount, decimal? Balance);

public sealed record DiscountResult(bool Ok, string? ErrorCode, string? Message, decimal? Balance);

/// <summary>
/// Money against a single bill: receipts, voids, corrections and discounts.
///
/// All four go through Telo's procedures, which hold the balance arithmetic and
/// the audit tables (telo_receipt_void, telo_receipt_edit). Three of them
/// REFUSE to act on a bill our software did not create — a boundary that keeps
/// us out of the legacy LIS's own receipts — and until Telo fa5568c that guard
/// read 'telo:' only, which would have made an Infinity bill uncorrectable.
///
/// NONE of these is retried. See the note on each.
/// </summary>
public sealed class BillingRepository(NobleConnectionFactory db)
{
    private const string Origin = "inf:";

    /// <summary>
    /// Record a payment against a bill.
    ///
    /// IDEMPOTENT ONLY WITH A REFERENCE. The procedure de-duplicates on
    /// @gatewayRef, so a repeated gateway webhook is a no-op. A counter payment
    /// has no reference and therefore NO idempotency key: a replay would record
    /// the money twice. Hence no retry, and hence the endpoint tells the caller
    /// to check the bill rather than resubmit.
    /// </summary>
    public Task<ReceiptResult> RecordReceiptAsync(
        int userId, int billId, int amount, string payMode, string? gatewayRef,
        CancellationToken ct = default) =>
        db.QueryAsync("billing.receipt", async (conn, inner) =>
        {
            await using var cmd = db.CreateWriteCommand(conn, "dbo.usp_telo_record_receipt");
            cmd.Parameters.Add("@billId", SqlDbType.Int).Value = billId;
            cmd.Parameters.Add("@amount", SqlDbType.Int).Value = amount;
            cmd.Parameters.Add("@payMode", SqlDbType.VarChar, 50).Value = payMode;
            cmd.Parameters.Add("@gatewayRef", SqlDbType.VarChar, 100).Value =
                string.IsNullOrWhiteSpace(gatewayRef) ? DBNull.Value : gatewayRef.Trim();
            cmd.Parameters.Add("@userId", SqlDbType.Int).Value = userId;
            cmd.Parameters.Add("@origin", SqlDbType.NVarChar, 20).Value = Origin;

            await using var r = await cmd.ExecuteReaderAsync(inner).ConfigureAwait(false);

            if (await r.ReadAsync(inner).ConfigureAwait(false))
            {
                return new ReceiptResult(
                    Flag(r, "ok"), r.Str("error_code"), r.Str("message"),
                    Flag(r, "already_recorded"), r.NullableDec("balance"), r.Str("txn_id"));
            }

            return new ReceiptResult(false, "NO_RESULT", "The procedure returned nothing.", false, null, null);
        }, ct);

    /// <summary>
    /// Void a receipt.
    ///
    /// Not retried, though it is the safest of the four: it reports
    /// already_voided rather than double-reversing, so a replay would not move
    /// the balance twice. Left un-retried anyway because a void is an
    /// accounting event someone signs for, and silently repeating one is not a
    /// decision this layer should make.
    /// </summary>
    public Task<VoidResult> VoidReceiptAsync(
        int userId, int receiptId, int billId, string? reason, CancellationToken ct = default) =>
        db.QueryAsync("billing.void", async (conn, inner) =>
        {
            await using var cmd = db.CreateWriteCommand(conn, "dbo.usp_telo_void_receipt");
            cmd.Parameters.Add("@receiptId", SqlDbType.Int).Value = receiptId;
            cmd.Parameters.Add("@billId", SqlDbType.Int).Value = billId;
            cmd.Parameters.Add("@userId", SqlDbType.Int).Value = userId;
            cmd.Parameters.Add("@reason", SqlDbType.NVarChar, 200).Value =
                string.IsNullOrWhiteSpace(reason) ? DBNull.Value : reason.Trim();
            cmd.Parameters.Add("@origin", SqlDbType.NVarChar, 20).Value = Origin;

            await using var r = await cmd.ExecuteReaderAsync(inner).ConfigureAwait(false);

            if (await r.ReadAsync(inner).ConfigureAwait(false))
            {
                return new VoidResult(
                    Flag(r, "ok"), r.Str("error_code"), r.Str("message"),
                    Flag(r, "already_voided"), r.NullableDec("balance"));
            }

            return new VoidResult(false, "NO_RESULT", "The procedure returned nothing.", false, null);
        }, ct);

    /// <summary>
    /// Correct a receipt's amount.
    ///
    /// Not retried: it moves the balance by the DELTA between old and new, so a
    /// replay applies the difference twice.
    /// </summary>
    public Task<EditReceiptResult> EditReceiptAsync(
        int userId, int receiptId, int billId, int newAmount, string? reason,
        CancellationToken ct = default) =>
        db.QueryAsync("billing.editReceipt", async (conn, inner) =>
        {
            await using var cmd = db.CreateWriteCommand(conn, "dbo.usp_telo_edit_receipt_amount");
            cmd.Parameters.Add("@receiptId", SqlDbType.Int).Value = receiptId;
            cmd.Parameters.Add("@billId", SqlDbType.Int).Value = billId;
            cmd.Parameters.Add("@newAmount", SqlDbType.Int).Value = newAmount;
            cmd.Parameters.Add("@userId", SqlDbType.Int).Value = userId;
            cmd.Parameters.Add("@reason", SqlDbType.NVarChar, 200).Value =
                string.IsNullOrWhiteSpace(reason) ? DBNull.Value : reason.Trim();
            cmd.Parameters.Add("@origin", SqlDbType.NVarChar, 20).Value = Origin;

            await using var r = await cmd.ExecuteReaderAsync(inner).ConfigureAwait(false);

            if (await r.ReadAsync(inner).ConfigureAwait(false))
            {
                return new EditReceiptResult(
                    Flag(r, "ok"), r.Str("error_code"), r.Str("message"),
                    Flag(r, "unchanged"), r.NullableDec("old_amount"), r.NullableDec("balance"));
            }

            return new EditReceiptResult(false, "NO_RESULT", "The procedure returned nothing.", false, null, null);
        }, ct);

    /// <summary>
    /// Set the discount on a bill.
    ///
    /// Absolute, not incremental — it SETS the discount rather than adding to
    /// it, so a replay is harmless. Still not retried, for the same reason as
    /// the void: it changes what a client is charged.
    /// </summary>
    public Task<DiscountResult> SetDiscountAsync(
        int userId, int billId, int discount, CancellationToken ct = default) =>
        db.QueryAsync("billing.discount", async (conn, inner) =>
        {
            await using var cmd = db.CreateWriteCommand(conn, "dbo.usp_telo_set_bill_discount");
            cmd.Parameters.Add("@billId", SqlDbType.Int).Value = billId;
            cmd.Parameters.Add("@discount", SqlDbType.Int).Value = discount;
            cmd.Parameters.Add("@userId", SqlDbType.Int).Value = userId;
            cmd.Parameters.Add("@origin", SqlDbType.NVarChar, 20).Value = Origin;

            await using var r = await cmd.ExecuteReaderAsync(inner).ConfigureAwait(false);

            if (await r.ReadAsync(inner).ConfigureAwait(false))
            {
                return new DiscountResult(
                    Flag(r, "ok"), r.Str("error_code"), r.Str("message"), r.NullableDec("balance"));
            }

            return new DiscountResult(false, "NO_RESULT", "The procedure returned nothing.", null);
        }, ct);

    /// <summary>
    /// Read a BIT column that these procedures return via CAST(... AS BIT).
    /// NullableInt copes with both the bool and the int the driver may hand
    /// back, and a missing value reads as false rather than throwing.
    /// </summary>
    private static bool Flag(Microsoft.Data.SqlClient.SqlDataReader r, string column) =>
        (r.NullableInt(column) ?? 0) == 1;
}
