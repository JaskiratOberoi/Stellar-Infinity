using System.Data;
using Infinity.Api.Data;
using Infinity.Api.Domain;
using Microsoft.Data.SqlClient;

namespace Infinity.Api.Reads;

public sealed record OrderSummary(
    int BillId,
    int? BillNumber,
    DateTimeOffset? BillDate,
    string? PatientName,
    int? MccCode,
    string? ClientCode,
    decimal Amount,
    decimal Balance);

public sealed record OrderPage(IReadOnlyList<OrderSummary> Orders, int TotalCount);

public sealed record OrderLine(
    int LineId,
    string? TestCode,
    string? TestName,
    string? TestType,
    decimal Amount,
    /// <summary>Catalogue MRP for this line — what the CENTRE charges its
    /// patient. Null for custom lines (Smart Report etc.), which have no
    /// catalogue entry; the billed amount is the patient price there.</summary>
    decimal? Mrp,
    bool Cancelled,
    /// <summary>Billed by us, performed outside Noble (an extras-only line).
    /// The invoice marks these * and adds the not-performed-by-Noble note.</summary>
    bool IsExternal);

public sealed record OrderSample(
    string Vailid,
    string SampleTypeName,
    string? TestCodes,
    string? Status);

public sealed record OrderReceipt(
    int ReceiptId,
    DateTimeOffset? Date,
    decimal Amount,
    string? Method,
    string? Reference,
    /// <summary>payment | refund</summary>
    string Kind,
    bool Voided,
    /// <summary>Gateway/manual transaction id from telo_txn, when one exists.</summary>
    string? TxnId);

public sealed record OrderDetail(
    int BillId,
    int? BillNumber,
    DateTimeOffset? BillDate,
    string? PatientName,
    int? MccCode,
    string? ClientCode,
    decimal Amount,
    decimal Balance,
    int? Age,
    int? AgeType,
    int? Gender,
    string? Mobile,
    string? Email,
    string? RefDoctorName,
    string? RefCustomerName,
    string? PaymentType,
    string? ClinicalHistory,
    decimal Discount,
    decimal AmountPaid,
    int? PatientId,
    string? RegisteredBy,
    /// <summary>Tagged b2b in telo_order_kind at creation — decides which of
    /// the three printable documents exist for this order (a walk-in has no
    /// client bill).</summary>
    bool IsB2b,
    /// <summary>The registering ACCOUNT's printed name (telo_account.prepared_by).
    /// Telo's bill prints this over the user's own name when set — several desks
    /// share one client code and each prints its own — so the parity bill needs
    /// the same value, not a re-derivation.</summary>
    string? PreparedByOverride,
    IReadOnlyList<OrderLine> Lines,
    IReadOnlyList<OrderSample> Samples,
    IReadOnlyList<OrderReceipt> Receipts)
{
    /// <summary>
    /// A copy with every monetary field zeroed and the payment history removed.
    ///
    /// For roles without <c>billing:view</c> — a technician needs to open an
    /// order to accession its samples but must never see line totals, balance,
    /// discount or the payment ledger. Per-line amounts are zeroed too, so a
    /// total cannot simply be re-summed on the client.
    /// </summary>
    public OrderDetail WithoutFinancials() => this with
    {
        Amount = 0,
        Balance = 0,
        Discount = 0,
        AmountPaid = 0,
        Receipts = [],
        Lines = Lines.Select(l => l with { Amount = 0, Mrp = null }).ToArray(),
    };
}

/// <summary>
/// Bills and their detail, ported from Telo's db/read/orders.ts.
/// Every query is scope-bounded and fails closed on an empty scope.
/// </summary>
public sealed class OrdersRepository(NobleConnectionFactory db, SqlRetry retry)
{
    public async Task<OrderPage> ListAsync(
        IReadOnlyList<int> scope,
        string? search,
        string? fromDate,
        string? toDate,
        int page,
        int pageSize,
        CancellationToken ct = default)
    {
        if (scope.Count == 0) return new OrderPage([], 0);

        var size = Math.Clamp(pageSize, 1, 200);
        var skip = (Math.Max(page, 1) - 1) * size;

        return await retry.ExecuteAsync("orders.list", token =>
            db.QueryAsync("orders.list", async (conn, inner) =>
            {
                await using var cmd = NobleConnectionFactory.CreateCommand(conn, "");
                var sc = ScopeFilter.For(cmd, "b.mcc_code", scope);

                var filters = new List<string> { sc.Predicate };

                if (!string.IsNullOrWhiteSpace(search))
                {
                    // Leading wildcard cannot use an index. Acceptable because the
                    // result set is paged and ordered by a clustered key; do not
                    // reuse this shape on a hot path.
                    cmd.Parameters.Add("@q", SqlDbType.NVarChar, 102).Value = $"%{search.Trim()}%";
                    cmd.Parameters.Add("@qnum", SqlDbType.Int).Value =
                        int.TryParse(search.Trim(), out var n) ? n : (object)DBNull.Value;
                    filters.Add("(b.patientname LIKE @q OR b.mobile_number LIKE @q OR b.bill_number = @qnum)");
                }

                if (TryDate(fromDate, out var from))
                {
                    cmd.Parameters.Add("@from", SqlDbType.Date).Value = from;
                    filters.Add("CAST(b.bill_date AS DATE) >= @from");
                }

                if (TryDate(toDate, out var to))
                {
                    cmd.Parameters.Add("@to", SqlDbType.Date).Value = to;
                    filters.Add("CAST(b.bill_date AS DATE) <= @to");
                }

                cmd.Parameters.Add("@skip", SqlDbType.Int).Value = skip;
                cmd.Parameters.Add("@take", SqlDbType.Int).Value = size;

                cmd.CommandText = $"""
                    SELECT
                        b.id            AS billId,
                        b.bill_number   AS billNumber,
                        b.bill_date     AS billDate,
                        b.patientname   AS patientName,
                        b.mcc_code      AS mccCode,
                        u.MCCUnitCode   AS clientCode,
                        b.amount        AS amount,
                        b.Balance       AS balance,
                        COUNT(*) OVER() AS totalCount
                    FROM dbo.tbl_billing_patient_detail b
                    LEFT JOIN dbo.tbl_med_mcc_unit_master u ON u.id = b.mcc_code
                    WHERE {string.Join(" AND ", filters)}
                    ORDER BY b.id DESC
                    OFFSET @skip ROWS FETCH NEXT @take ROWS ONLY
                    """;

                await using var reader = await cmd.ExecuteReaderAsync(CommandBehavior.SingleResult, inner)
                    .ConfigureAwait(false);

                var rows = new List<OrderSummary>();
                var total = 0;
                while (await reader.ReadAsync(inner).ConfigureAwait(false))
                {
                    rows.Add(new OrderSummary(
                        reader.Int("billId"),
                        reader.NullableInt("billNumber"),
                        NobleTime.ToIst(reader.Date("billDate")),
                        reader.Str("patientName"),
                        reader.NullableInt("mccCode"),
                        reader.Str("clientCode"),
                        reader.Dec("amount"),
                        reader.Dec("balance")));
                    total = reader.Int("totalCount");
                }

                return new OrderPage(rows, total);
            }, token), ct).ConfigureAwait(false);
    }

    /// <summary>
    /// Full order detail, or null if the bill does not exist OR is outside the
    /// caller's scope — the two are deliberately indistinguishable, so this
    /// endpoint cannot be used to probe for bills belonging to other clients.
    /// </summary>
    public async Task<OrderDetail?> GetAsync(int billId, IReadOnlyList<int> scope, CancellationToken ct = default)
    {
        if (scope.Count == 0) return null;

        return await retry.ExecuteAsync("orders.get", token =>
            db.QueryAsync("orders.get", async (conn, inner) =>
            {
                // ---- header (also the scope gate) --------------------------
                await using var head = NobleConnectionFactory.CreateCommand(conn, "");
                head.Parameters.Add("@bid", SqlDbType.Int).Value = billId;
                var sc = ScopeFilter.For(head, "b.mcc_code", scope);

                head.CommandText = $"""
                    SELECT b.id AS billId, b.bill_number AS billNumber, b.bill_date AS billDate,
                           -- Salutation + name, as the reports print it since 77 grew
                           -- the same prefix. The BILL's own copy of the name stays
                           -- authoritative; only the title comes from the master —
                           -- the billing row never stored one. Blank and NULL titles
                           -- collapse to the bare name.
                           CONCAT(NULLIF(LTRIM(RTRIM(ISNULL(p.initial, N''))), N'') + N' ',
                                  b.patientname) AS patientName,
                           b.mcc_code AS mccCode,
                           u.MCCUnitCode AS clientCode,
                           b.amount AS amount, b.Balance AS balance,
                           b.age, b.age_type AS ageType, b.gender,
                           b.mobile_number AS mobile, b.email,
                           b.payment_type AS paymentType,
                           d.doctor_name AS refDoctorName,
                           c.customer_name AS refCustomerName,
                           p.Clinical_History AS clinicalHistory,
                           b.discount_amount AS discount, b.amount_paid AS amountPaid,
                           -- Telo stores patient_id in medid so bill can join patient.
                           TRY_CONVERT(INT, b.medid) AS patientId,
                           -- Whoever registered it: works for both the 'telo:' and
                           -- 'inf:' origin markers, since both are '<prefix>:<userId>'.
                           NULLIF(LTRIM(RTRIM(CONCAT(uu.firstname, ' ', uu.lastname))), '') AS registeredBy,
                           NULLIF(LTRIM(RTRIM(ta.prepared_by)), '') AS preparedByOverride,
                           CASE WHEN ok.bill_id IS NULL THEN 0 ELSE 1 END AS isB2b
                    FROM dbo.tbl_billing_patient_detail b
                    LEFT JOIN dbo.tbl_med_mcc_unit_master u ON u.id = b.mcc_code
                    LEFT JOIN dbo.tbl_med_mcc_doctors  d ON d.id = b.ref_doctor
                    LEFT JOIN dbo.tbl_med_mcc_customer c ON c.id = b.ref_customer
                    LEFT JOIN dbo.tbl_med_mcc_patient_master p ON p.id = TRY_CONVERT(INT, b.medid)
                    LEFT JOIN dbo.tbl_med_user_master uu
                           ON (b.addedby LIKE 'telo:%' OR b.addedby LIKE 'inf:%')
                          AND uu.id = TRY_CONVERT(INT, SUBSTRING(b.addedby, CHARINDEX(':', b.addedby) + 1, 20))
                    LEFT JOIN dbo.telo_account ta ON ta.user_id = uu.id
                    LEFT JOIN dbo.telo_order_kind ok ON ok.bill_id = b.id AND ok.kind = N'b2b'
                    WHERE b.id = @bid AND {sc.Predicate}
                    """;

                int? patientId;
                OrderDetail detail;

                await using (var r = await head.ExecuteReaderAsync(CommandBehavior.SingleResult, inner).ConfigureAwait(false))
                {
                    if (!await r.ReadAsync(inner).ConfigureAwait(false)) return null;

                    patientId = r.NullableInt("patientId");

                    detail = new OrderDetail(
                        BillId: r.Int("billId"),
                        BillNumber: r.NullableInt("billNumber"),
                        BillDate: NobleTime.ToIst(r.Date("billDate")),
                        PatientName: r.Str("patientName"),
                        MccCode: r.NullableInt("mccCode"),
                        ClientCode: r.Str("clientCode"),
                        Amount: r.Dec("amount"),
                        Balance: r.Dec("balance"),
                        Age: r.NullableInt("age"),
                        // age_type is VARCHAR on the bill but an int code (1/2/3).
                        AgeType: int.TryParse(r.Str("ageType")?.Trim(), out var at) ? at : null,
                        Gender: r.NullableInt("gender"),
                        Mobile: r.Str("mobile"),
                        Email: Trim(r.Str("email")),
                        RefDoctorName: Trim(r.Str("refDoctorName")),
                        RefCustomerName: Trim(r.Str("refCustomerName")),
                        PaymentType: Trim(r.Str("paymentType")),
                        ClinicalHistory: Trim(r.Str("clinicalHistory")),
                        Discount: r.Dec("discount"),
                        AmountPaid: r.Dec("amountPaid"),
                        PatientId: patientId,
                        RegisteredBy: Trim(r.Str("registeredBy")),
                        PreparedByOverride: Trim(r.Str("preparedByOverride")),
                        IsB2b: r.Int("isB2b") == 1,
                        Lines: [], Samples: [], Receipts: []);
                }

                // ---- children, one after another ---------------------------
                // These three used to be started together and awaited with
                // Task.WhenAll. That threw on every single request: three
                // overlapping readers on ONE connection is exactly what MARS
                // exists for, and NobleOptions turns MARS off deliberately
                // ("MARS costs throughput and we never interleave readers on
                // one connection"). The comment was right and this code was the
                // one place contradicting it, so opening any order returned 500.
                //
                // Sequential is also the correct shape rather than merely the
                // working one. MARS would not have made these concurrent — it
                // interleaves them over a single session — and giving each its
                // own connection would treble pool usage per order view against
                // a pool of twenty shared with every other request.
                var lines = await LoadLinesAsync(conn, billId, inner).ConfigureAwait(false);
                var receipts = await LoadReceiptsAsync(conn, billId, inner).ConfigureAwait(false);
                var samples = patientId is int pid
                    ? await LoadSamplesAsync(conn, pid, inner).ConfigureAwait(false)
                    : [];

                return detail with
                {
                    Lines = lines,
                    Receipts = receipts,
                    Samples = samples,
                };
            }, token), ct).ConfigureAwait(false);
    }

    private static async Task<IReadOnlyList<OrderLine>> LoadLinesAsync(SqlConnection conn, int billId, CancellationToken ct)
    {
        // Note: cancelled lines are read from Telo's ledger. Infinity has no
        // cancellation mechanism yet, so that table is the only record of one —
        // omitting the join would show cancelled tests as live.
        await using var cmd = NobleConnectionFactory.CreateCommand(conn, """
            SELECT d.id AS lineId, d.testcode AS testCode, d.testname AS testName,
                   d.testtype AS testType, d.testamount AS amount,
                   mrp = CASE
                       WHEN d.testtype IN ('t', 'Test') THEN
                           (SELECT TOP 1 tm.MRP FROM dbo.tbl_med_test_master tm
                             WHERE tm.TestCode = d.testcode ORDER BY tm.id)
                       WHEN d.testtype IN ('p', 'Profile') THEN
                           (SELECT TOP 1 pm.MRP FROM dbo.tbl_med_test_profile_master pm
                             WHERE pm.Profile_Code = d.testcode ORDER BY pm.id)
                       ELSE
                           (SELECT TOP 1 mm.MRP FROM dbo.tbl_med_test_master_profile_master mm
                             WHERE mm.Master_Profile_Code = d.testcode ORDER BY mm.id)
                   END,
                   CASE WHEN tc.line_id IS NULL THEN 0 ELSE 1 END AS cancelled,
                   CASE WHEN EXISTS (
                          SELECT 1 FROM dbo.telo_custom_test_order cto
                          WHERE cto.bill_id = d.billid AND LEFT(cto.code, 10) = d.testcode
                        ) THEN 1 ELSE 0 END AS isExternal
            FROM dbo.tbl_billing_patient_test_detail d
            LEFT JOIN dbo.telo_test_cancellation tc ON tc.line_id = d.id
            WHERE d.billid = @bid
            ORDER BY d.id
            """);
        cmd.Parameters.Add("@bid", SqlDbType.Int).Value = billId;

        await using var r = await cmd.ExecuteReaderAsync(CommandBehavior.SingleResult, ct).ConfigureAwait(false);
        var list = new List<OrderLine>();
        while (await r.ReadAsync(ct).ConfigureAwait(false))
        {
            list.Add(new OrderLine(
                r.Int("lineId"), r.Str("testCode"), r.Str("testName"),
                r.Str("testType"), r.Dec("amount"), r.NullableDec("mrp"),
                r.Int("cancelled") == 1,
                r.Int("isExternal") == 1));
        }
        return list;
    }

    private static async Task<IReadOnlyList<OrderReceipt>> LoadReceiptsAsync(SqlConnection conn, int billId, CancellationToken ct)
    {
        // card_number carries the txn ref / cheque no / UPI UTR — the LIS column
        // name is legacy, the value is generic.
        await using var cmd = NobleConnectionFactory.CreateCommand(conn, """
            SELECT r.id AS receiptId, r.recd_date AS date, r.amount,
                   r.pay_mode AS method, r.card_number AS reference,
                   r.receive_status AS status,
                   CASE WHEN v.receipt_id IS NULL THEN 0 ELSE 1 END AS voided,
                   t.txn_id AS txnId
            FROM dbo.tbl_billing_patient_amount_receipt r
            LEFT JOIN dbo.telo_txn t ON t.receipt_id = r.id
            LEFT JOIN dbo.telo_receipt_void v ON v.receipt_id = r.id
            WHERE r.bill_id = @bid
            ORDER BY r.id
            """);
        cmd.Parameters.Add("@bid", SqlDbType.Int).Value = billId;

        await using var r = await cmd.ExecuteReaderAsync(CommandBehavior.SingleResult, ct).ConfigureAwait(false);
        var list = new List<OrderReceipt>();
        while (await r.ReadAsync(ct).ConfigureAwait(false))
        {
            list.Add(new OrderReceipt(
                r.Int("receiptId"),
                NobleTime.ToIst(r.Date("date")),
                r.Dec("amount"),
                Trim(r.Str("method")),
                Trim(r.Str("reference")),
                r.Str("status") == "2" ? "refund" : "payment",
                r.Int("voided") == 1,
                Trim(r.Str("txnId"))));
        }
        return list;
    }

    private static async Task<IReadOnlyList<OrderSample>> LoadSamplesAsync(SqlConnection conn, int patientId, CancellationToken ct)
    {
        await using var cmd = NobleConnectionFactory.CreateCommand(conn, """
            SELECT s.vailid, sm.Sampletype AS sampleTypeName,
                   s.testcodes AS testCodes, st.status AS status
            FROM dbo.tbl_med_mcc_patient_samples s
            LEFT JOIN dbo.tbl_med_sample_master sm ON sm.id = s.sampleid
            LEFT JOIN dbo.tbl_med_mcc_patient_samples_status_master st ON st.id = s.sample_status
            WHERE s.patient_id = @pid
            ORDER BY s.id
            """);
        cmd.Parameters.Add("@pid", SqlDbType.Int).Value = patientId;

        await using var r = await cmd.ExecuteReaderAsync(CommandBehavior.SingleResult, ct).ConfigureAwait(false);
        var list = new List<OrderSample>();
        while (await r.ReadAsync(ct).ConfigureAwait(false))
        {
            list.Add(new OrderSample(
                r.Str("vailid") ?? "",
                r.Str("sampleTypeName") ?? "Unspecified",
                r.Str("testCodes"),
                r.Str("status")));
        }
        return list;
    }

    private static string? Trim(string? s) => string.IsNullOrWhiteSpace(s) ? null : s.Trim();

    private static bool TryDate(string? s, out DateTime value) =>
        DateTime.TryParseExact(s, "yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture,
            System.Globalization.DateTimeStyles.None, out value);
}

// Column readers live in Data/SqlReaderExtensions.cs — shared, so two
// repositories cannot define conflicting versions of the same helper.
