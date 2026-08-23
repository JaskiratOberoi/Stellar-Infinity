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
    /* ---- the Bills page (Telo's balances screen, ported) ----------------
     * Totals, collected-in-period and the rows all bind an IDENTICAL
     * predicate, exactly as Telo's billsWhere insists: if they drift, the
     * page footer stops describing the rows above it and a financial total
     * silently misreports. Origin covers BOTH counters — 'telo:%' and
     * 'inf:%' — because the desks are migrating and a page that loses the
     * old counter's bills would read as money vanishing.
     * ------------------------------------------------------------------- */

    public sealed record BillTotals(
        int Count, decimal Balance, decimal Amount, decimal AmountPaid,
        decimal Discount, int PendingCount);

    public sealed record CollectedTotals(
        decimal Collected, decimal CashCollected, decimal OtherCollected,
        decimal Refunded, int ReceiptCount, int CashCount, int OtherCount);

    public sealed record BillRow(
        int BillId, int? BillNumber, DateTimeOffset? BillDate, string? PatientName,
        int? PatientId, decimal Amount, decimal AmountPaid, decimal Balance,
        decimal Discount, string? DoctorName, string? CustomerName,
        string? PaymentType, int? Age, string? AgeType);

    private const string BillsWhere = """
        WHERE (b.addedby LIKE 'telo:%' OR b.addedby LIKE 'inf:%')
          AND b.mcc_code = @mcc
          AND b.bill_date >= CAST(@from AS DATE)
          AND b.bill_date <  DATEADD(day, 1, CAST(@to AS DATE))
          AND (@q IS NULL OR (
               b.patientname LIKE @q
            OR CONVERT(VARCHAR(20), b.bill_number) LIKE @q
            OR b.medid LIKE @q
            OR b.mobile_number LIKE @q
            OR d.doctor_name LIKE @q
            OR c.customer_name LIKE @q
            OR b.payment_type LIKE @q
            OR TRY_CONVERT(INT, b.medid) IN (
                 SELECT s.patient_id FROM dbo.tbl_med_mcc_patient_samples s
                  WHERE s.vailid LIKE @qpfx)
          ))
        """;

    private static void BindBillsWhere(Microsoft.Data.SqlClient.SqlCommand cmd, int mcc, string from, string to, string? q)
    {
        cmd.Parameters.Add("@mcc", SqlDbType.Int).Value = mcc;
        cmd.Parameters.Add("@from", SqlDbType.VarChar, 10).Value = from;
        cmd.Parameters.Add("@to", SqlDbType.VarChar, 10).Value = to;
        // Metacharacters are stripped, not escaped — the box is a contains-match.
        var needle = (q ?? "").Trim();
        var safe = needle.Length == 0 ? null
            : System.Text.RegularExpressions.Regex.Replace(needle, @"[%_\[\]]", " ")[..Math.Min(needle.Length, 100)];
        cmd.Parameters.Add("@q", SqlDbType.NVarChar, 120).Value =
            safe is null ? DBNull.Value : $"%{safe}%";
        cmd.Parameters.Add("@qpfx", SqlDbType.NVarChar, 120).Value =
            safe is null ? DBNull.Value : $"{safe}%";
    }

    public Task<BillTotals> BillTotalsAsync(
        int mcc, string from, string to, string? q, CancellationToken ct = default) =>
        db.QueryAsync("billing.billTotals", async (conn, inner) =>
        {
            await using var cmd = NobleConnectionFactory.CreateCommand(conn, $"""
                SELECT COUNT(*) AS cnt,
                       ISNULL(SUM(b.Balance), 0) AS bal,
                       ISNULL(SUM(b.amount), 0) AS amt,
                       ISNULL(SUM(b.amount_paid), 0) AS paid,
                       ISNULL(SUM(ISNULL(b.discount_amount, 0)), 0) AS disc,
                       ISNULL(SUM(CASE WHEN b.Balance > 0 THEN 1 ELSE 0 END), 0) AS pend
                FROM dbo.tbl_billing_patient_detail b
                LEFT JOIN dbo.tbl_med_mcc_doctors  d ON d.id = b.ref_doctor
                LEFT JOIN dbo.tbl_med_mcc_customer c ON c.id = b.ref_customer
                {BillsWhere}
                """);
            BindBillsWhere(cmd, mcc, from, to, q);
            await using var r = await cmd.ExecuteReaderAsync(inner).ConfigureAwait(false);
            if (!await r.ReadAsync(inner).ConfigureAwait(false))
                return new BillTotals(0, 0, 0, 0, 0, 0);
            return new BillTotals(
                r.Int("cnt"), r.Dec("bal"), r.Dec("amt"), r.Dec("paid"),
                r.Dec("disc"), r.Int("pend"));
        }, ct);

    /// <summary>Keyed by RECEIPT date, not bill date — a payment taken today
    /// against last week's bill belongs in today's collections.</summary>
    public Task<CollectedTotals> CollectedInPeriodAsync(
        int mcc, string from, string to, CancellationToken ct = default) =>
        db.QueryAsync("billing.collected", async (conn, inner) =>
        {
            await using var cmd = NobleConnectionFactory.CreateCommand(conn, """
                SELECT
                  ISNULL(SUM(CASE WHEN r.receive_status = '1' THEN r.amount ELSE 0 END), 0) AS collected,
                  ISNULL(SUM(CASE WHEN r.receive_status = '1' AND r.pay_mode = 'Cash' THEN r.amount ELSE 0 END), 0) AS cash,
                  ISNULL(SUM(CASE WHEN r.receive_status = '1' AND (r.pay_mode IS NULL OR r.pay_mode <> 'Cash') THEN r.amount ELSE 0 END), 0) AS oth,
                  ISNULL(SUM(CASE WHEN r.receive_status = '2' THEN r.amount ELSE 0 END), 0) AS refunded,
                  ISNULL(SUM(CASE WHEN r.receive_status = '1' THEN 1 ELSE 0 END), 0) AS rc,
                  ISNULL(SUM(CASE WHEN r.receive_status = '1' AND r.pay_mode = 'Cash' THEN 1 ELSE 0 END), 0) AS cc,
                  ISNULL(SUM(CASE WHEN r.receive_status = '1' AND (r.pay_mode IS NULL OR r.pay_mode <> 'Cash') THEN 1 ELSE 0 END), 0) AS oc
                FROM dbo.tbl_billing_patient_amount_receipt r
                JOIN dbo.tbl_billing_patient_detail b ON b.id = r.bill_id
                WHERE (b.addedby LIKE 'telo:%' OR b.addedby LIKE 'inf:%')
                  AND NOT EXISTS (SELECT 1 FROM dbo.telo_receipt_void v WHERE v.receipt_id = r.id)
                  AND b.mcc_code = @mcc
                  AND r.recd_date >= CAST(@from AS DATE)
                  AND r.recd_date <  DATEADD(day, 1, CAST(@to AS DATE))
                """);
            cmd.Parameters.Add("@mcc", SqlDbType.Int).Value = mcc;
            cmd.Parameters.Add("@from", SqlDbType.VarChar, 10).Value = from;
            cmd.Parameters.Add("@to", SqlDbType.VarChar, 10).Value = to;
            await using var r = await cmd.ExecuteReaderAsync(inner).ConfigureAwait(false);
            if (!await r.ReadAsync(inner).ConfigureAwait(false))
                return new CollectedTotals(0, 0, 0, 0, 0, 0, 0);
            return new CollectedTotals(
                r.Dec("collected"), r.Dec("cash"), r.Dec("oth"), r.Dec("refunded"),
                r.Int("rc"), r.Int("cc"), r.Int("oc"));
        }, ct);

    public Task<IReadOnlyList<BillRow>> BillsPageAsync(
        int mcc, string from, string to, string? q, int page, int pageSize,
        CancellationToken ct = default) =>
        db.QueryAsync("billing.billsPage", async (conn, inner) =>
        {
            await using var cmd = NobleConnectionFactory.CreateCommand(conn, $"""
                SELECT b.id AS billId, b.bill_number AS billNumber, b.bill_date AS billDate,
                       b.patientname AS patientName, TRY_CONVERT(INT, b.medid) AS patientId,
                       b.amount, b.amount_paid AS amountPaid, b.Balance AS balance,
                       ISNULL(b.discount_amount, 0) AS discount,
                       d.doctor_name AS doctorName, c.customer_name AS customerName,
                       b.payment_type AS paymentType, b.age, b.age_type AS ageType
                FROM dbo.tbl_billing_patient_detail b
                LEFT JOIN dbo.tbl_med_mcc_doctors  d ON d.id = b.ref_doctor
                LEFT JOIN dbo.tbl_med_mcc_customer c ON c.id = b.ref_customer
                {BillsWhere}
                ORDER BY b.bill_date DESC, b.id DESC
                OFFSET @off ROWS FETCH NEXT @lim ROWS ONLY
                """);
            BindBillsWhere(cmd, mcc, from, to, q);
            cmd.Parameters.Add("@off", SqlDbType.Int).Value = (page - 1) * pageSize;
            cmd.Parameters.Add("@lim", SqlDbType.Int).Value = pageSize;
            await using var r = await cmd.ExecuteReaderAsync(inner).ConfigureAwait(false);
            var rows = new List<BillRow>();
            while (await r.ReadAsync(inner).ConfigureAwait(false))
            {
                rows.Add(new BillRow(
                    r.Int("billId"), r.NullableInt("billNumber"),
                    r.Date("billDate") is DateTime dt ? new DateTimeOffset(dt, TimeSpan.Zero) : null,
                    r.Str("patientName")?.Trim(), r.NullableInt("patientId"),
                    r.Dec("amount"), r.Dec("amountPaid"), r.Dec("balance"), r.Dec("discount"),
                    r.Str("doctorName")?.Trim(), r.Str("customerName")?.Trim(),
                    r.Str("paymentType")?.Trim(), r.NullableInt("age"), r.Str("ageType")));
            }
            return (IReadOnlyList<BillRow>)rows;
        }, ct);

    /* ---- the super-admin mutations, on Telo's own procedures ------------ */

    public Task<ReceiptResult> CancelTestAsync(
        int userId, int billId, int lineId, string reason, CancellationToken ct = default) =>
        db.QueryAsync("billing.cancelTest", async (conn, inner) =>
        {
            await using var cmd = db.CreateWriteCommand(conn, "dbo.usp_telo_cancel_test");
            cmd.Parameters.Add("@billId", SqlDbType.Int).Value = billId;
            cmd.Parameters.Add("@lineId", SqlDbType.Int).Value = lineId;
            cmd.Parameters.Add("@userId", SqlDbType.Int).Value = userId;
            cmd.Parameters.Add("@reason", SqlDbType.NVarChar, 200).Value = reason;
            await using var r = await cmd.ExecuteReaderAsync(inner).ConfigureAwait(false);
            if (await r.ReadAsync(inner).ConfigureAwait(false))
            {
                return new ReceiptResult(
                    Flag(r, "ok"), r.Str("error_code"), r.Str("message"),
                    false, r.NullableDec("balance"), null);
            }
            return new ReceiptResult(false, "NO_RESULT", "The procedure returned nothing.", false, null, null);
        }, ct);

    public Task<ReceiptResult> RecordRefundAsync(
        int userId, int billId, int amount, string payMode, string? reference,
        CancellationToken ct = default) =>
        db.QueryAsync("billing.refund", async (conn, inner) =>
        {
            await using var cmd = db.CreateWriteCommand(conn, "dbo.usp_telo_record_refund");
            cmd.Parameters.Add("@billId", SqlDbType.Int).Value = billId;
            cmd.Parameters.Add("@amount", SqlDbType.Int).Value = amount;
            cmd.Parameters.Add("@payMode", SqlDbType.VarChar, 50).Value = payMode;
            cmd.Parameters.Add("@reference", SqlDbType.VarChar, 100).Value =
                string.IsNullOrWhiteSpace(reference) ? DBNull.Value : reference.Trim();
            cmd.Parameters.Add("@userId", SqlDbType.Int).Value = userId;
            await using var r = await cmd.ExecuteReaderAsync(inner).ConfigureAwait(false);
            if (await r.ReadAsync(inner).ConfigureAwait(false))
            {
                return new ReceiptResult(
                    Flag(r, "ok"), r.Str("error_code"), r.Str("message"),
                    false, r.NullableDec("balance"), null);
            }
            return new ReceiptResult(false, "NO_RESULT", "The procedure returned nothing.", false, null, null);
        }, ct);

    /// <summary>What cancel-booking needs to orchestrate: the bill's centre,
    /// discount, net paid, and its still-active lines.</summary>
    public sealed record BillState(
        int Mcc, decimal Discount, decimal AmountPaid, IReadOnlyList<int> ActiveLineIds);

    public Task<BillState?> BillStateAsync(int billId, CancellationToken ct = default) =>
        db.QueryAsync("billing.billState", async (conn, inner) =>
        {
            await using var cmd = NobleConnectionFactory.CreateCommand(conn, """
                SELECT b.mcc_code AS mcc, ISNULL(b.discount_amount, 0) AS discount,
                       ISNULL(b.amount_paid, 0) AS amountPaid
                FROM dbo.tbl_billing_patient_detail b WHERE b.id = @bid;

                SELECT d.id AS lineId
                FROM dbo.tbl_billing_patient_test_detail d
                LEFT JOIN dbo.telo_test_cancellation tc ON tc.line_id = d.id
                WHERE d.billid = @bid AND d.testamount > 0 AND tc.line_id IS NULL
                ORDER BY d.id;
                """);
            cmd.Parameters.Add("@bid", SqlDbType.Int).Value = billId;
            await using var r = await cmd.ExecuteReaderAsync(inner).ConfigureAwait(false);
            if (!await r.ReadAsync(inner).ConfigureAwait(false)) return null;
            var mcc = r.Int("mcc");
            var discount = r.Dec("discount");
            var paid = r.Dec("amountPaid");
            var lines = new List<int>();
            if (await r.NextResultAsync(inner).ConfigureAwait(false))
            {
                while (await r.ReadAsync(inner).ConfigureAwait(false)) lines.Add(r.Int("lineId"));
            }
            return new BillState(mcc, discount, paid, lines);
        }, ct);

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
