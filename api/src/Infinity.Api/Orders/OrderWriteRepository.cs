using System.Data;
// The reader helpers are split across two namespaces: Str/NullableInt live in
// Reads, GetOrdinalBool in Auth. Both are needed here.
using Infinity.Api.Auth;
using Infinity.Api.Data;
using Infinity.Api.Reads;
using Microsoft.Data.SqlClient;

namespace Infinity.Api.Orders;

/// <summary>
/// One tube the order will need. The LIS decides this from each test's sample
/// type, so a panel spanning serum and EDTA produces two groups and therefore
/// needs two barcodes.
/// </summary>
/// <param name="SampleTypeId">-1 when the test master has no sample type set.</param>
public sealed record SampleGroup(
    int SampleTypeId,
    string? SampleTypeName,
    string? Codes,
    string? Names,
    bool RequiresSplit,
    int ItemCount);

/// <param name="Vailid">
/// The barcode. Operator-supplied, not generated: these come off pre-printed
/// label rolls, so the system's job is to validate one, never to invent one.
/// </param>
public sealed record SampleSid(int SampleTypeId, string Vailid);

public sealed record CreateOrderRequest(
    int Mcc,
    IReadOnlyList<CartItem> Items,
    IReadOnlyList<SampleSid>? SampleSids,
    int? PatientId,
    string? Name,
    string? Initial,
    int? Age,
    int? AgeType,
    int? Gender,
    string? Mobile,
    string? Email,
    string? ClinicalHistory,
    string? MrnId,
    int? RefDoctor,
    int? RefCustomer,
    string? NewRefDoctorName,
    string? NewRefCustomerName,
    int DiscountAmount,
    string? PaymentType,
    int? PayMode,
    int ReceiptAmount,
    string? PaymentRef,
    /// <summary>
    /// Charge the basket at catalogue MRP instead of the client's rate.
    /// </summary>
    /// <remarks>
    /// NOT taken from the request body even though it travels on this record.
    /// The endpoint overwrites it from <see cref="Channel"/> after checking the
    /// matching capability, because this single bit decides whether a basket is
    /// billed at a client's negotiated rate or at full MRP — and a caller that
    /// could set it directly would be choosing the price without holding the
    /// capability that authorises the channel.
    /// </remarks>
    bool BillAtMrp,
    /// <summary>
    /// <c>b2c</c> (walk-in, priced at the client's rate) or <c>b2b</c> (client
    /// order, billed at MRP). Absent means b2c, so callers written before the
    /// split behave exactly as they did.
    /// </summary>
    string? Channel = null,

    // ---- Gold Card (B2C only) ----------------------------------------------
    /// <summary>
    /// Halve every line on the bill under the Gold Card scheme.
    /// </summary>
    /// <remarks>
    /// The procedure applies the 50% at the SOURCE — header amount, billing
    /// lines and the LIS-facing test rows are all halved together, so nothing
    /// downstream has to know a discount happened. It records which card was
    /// used in dbo.telo_gold_card, one row per bill, so the reduction is
    /// auditable rather than just cheaper.
    ///
    /// Ignored when the order is B2B: that bill is the patient's at MRP and
    /// the centre's margin is not the lab's to give away.
    /// </remarks>
    bool GoldCard = false,
    string? GoldCardNumber = null,
    string? GoldCardHolder = null,

    // ---- clinical history attachment ---------------------------------------
    /// <summary>
    /// A clinical-history PDF, base64. Stored by the procedure into
    /// tbl_med_mcc_patient_clinicaldata against the patient, tagged 'HISTORY'.
    /// </summary>
    /// <remarks>
    /// Base64 in the JSON body rather than multipart, because everything else
    /// about placing an order is one atomic call and splitting the attachment
    /// into a second request would mean an order could exist with its history
    /// lost in flight. Capped at the endpoint; see ClinicalFileMaxBytes.
    /// </remarks>
    string? ClinicalFileBase64 = null,
    string? ClinicalFileName = null,

    /// <summary>
    /// Split tender: part cash, part UPI, part card. Empty means "use the
    /// single PayMode/ReceiptAmount above", which is what every caller written
    /// before split payments does.
    /// </summary>
    /// <remarks>
    /// The procedure prefers this TVP whenever it has rows and falls back to
    /// the scalar pair otherwise, so the two cannot both apply and there is no
    /// double-receipting.
    /// </remarks>
    IReadOnlyList<PaymentLine>? Payments = null,

    /// <summary>
    /// The patient's date of birth. The order form has always collected it to
    /// derive age; it is now also stored, because the LIS keeps no birth date
    /// of its own (see 119_table_inf_patient_dob.sql). Null leaves any date
    /// captured on an earlier visit untouched.
    /// </summary>
    DateOnly? Dob = null,

    /// <summary>
    /// Lines the lab BILLS but never performs — the Smart Report is one. Each
    /// produces a billing line and a telo_custom_test_order row, and no LIS
    /// test or sample. Empty for an ordinary order.
    /// </summary>
    IReadOnlyList<CustomLine>? CustomLines = null,
    /// <summary>The operator's MRD free text, snapshotted on each custom line.</summary>
    string? MrdText = null);

/// <param name="CustomTestId">dbo.telo_custom_test.id — the price is re-resolved from it server-side.</param>
public sealed record CustomLine(int CustomTestId, int Qty);

/// <param name="Method">Cash, UPI, Card, Cheque, NEFT — the label, not an id.</param>
/// <param name="Ref">
/// UTR, card slip, cheque number. Meaningless for cash and dropped there.
/// </param>
public sealed record PaymentLine(string Method, int Amount, string? Ref);

public sealed record CreateOrderResult(
    bool Ok,
    string? ErrorCode,
    string? Message,
    int? PatientId,
    int? BillId,
    int? BillNumber,
    int Total,
    int SampleCount,
    IReadOnlyList<IssuedSample> Samples);

public sealed record IssuedSample(int SampleId, string? Vailid, int SampleTypeId, string? SampleTypeName);

/// <summary>
/// Order creation, on top of the procedures the LIS billing path already uses.
///
/// ── WHY THIS CALLS TELO'S PROCEDURE RATHER THAN A NEW ONE ──────────────────
/// dbo.usp_telo_create_order is ~1,000 lines of pricing, sample-splitting,
/// bill-numbering, receipt and ledger rules that are already correct and
/// already in production. Re-implementing it for Infinity would mean two
/// versions of the lab's billing logic writing to the same tables, drifting
/// apart from the first bug fix onward.
///
/// It was parameterised for this: @origin (added in Telo commit a62e977,
/// defaulted to 'telo:' so Telo is unaffected) is what lets Infinity stamp its
/// own rows 'inf:&lt;userId&gt;'. Do not pass anything else — the marker is how
/// each platform recognises the orders it created.
///
/// ── BILL NUMBERS WHILE BOTH PLATFORMS ARE LIVE ─────────────────────────────
/// The procedure allocates through dbo.usp_telo_next_bill_number, which
/// serialises on an app-lock keyed by MCC and month. Because Infinity goes
/// through the same procedure it takes the same lock, so the two systems cannot
/// issue the same bill number. A separate Infinity allocator — even an
/// identical one — would take a DIFFERENT lock and collide.
/// </summary>
public sealed class OrderWriteRepository(NobleConnectionFactory db, SqlRetry retry)
{
    /// <summary>
    /// Largest clinical-history attachment accepted, matching Telo's own cap.
    /// </summary>
    public const int ClinicalFileMaxBytes = 10 * 1024 * 1024;

    /// <summary>
    /// Base64 to bytes, or null for anything that is not a usable attachment.
    /// </summary>
    /// <remarks>
    /// Returns null rather than throwing on malformed input: a corrupt
    /// attachment must not cost the operator the order. The endpoint checks
    /// the size first, so what reaches here is either decodable or junk.
    /// </remarks>
    /// <summary>
    /// The split-payment lines, as dbo.TeloPayment.
    /// </summary>
    /// <remarks>
    /// Column order and types mirror Telo's builder exactly — seq, method,
    /// amount, ref — because a TVP is positional and a mismatch here would
    /// post the amount into the method column rather than failing loudly.
    ///
    /// Zero and negative lines are dropped rather than sent: an empty row the
    /// operator added and did not fill is not a receipt, and the procedure
    /// decides between the TVP and the scalar pair by whether the TVP has ANY
    /// rows — so an all-blank TVP would suppress the scalar path and record
    /// nothing at all.
    /// </remarks>
    /// <summary>
    /// dbo.TeloCustomLine. The code, name and unit price come from the resolved
    /// catalogue row, NEVER from the request — the browser posts an id and a
    /// quantity and nothing else that reaches a bill.
    /// </summary>
    private static void AddCustomLineTvp(
        SqlCommand cmd, string name, IReadOnlyList<(CustomTest Test, int Qty)> lines)
    {
        var t = new System.Data.DataTable();
        t.Columns.Add("customTestId", typeof(int));
        t.Columns.Add("code", typeof(string));
        t.Columns.Add("name", typeof(string));
        t.Columns.Add("unitAmount", typeof(int));
        t.Columns.Add("qty", typeof(int));
        t.Columns.Add("requiresMrd", typeof(bool));

        // Repeats of one test are coalesced, summing quantity: the form adds a
        // single line per test, so a duplicate is a tampered or replayed post
        // and must not bill twice.
        var byId = new Dictionary<int, (CustomTest Test, int Qty)>();
        foreach (var (test, qty) in lines)
        {
            var q = Math.Max(1, qty);
            byId[test.Id] = byId.TryGetValue(test.Id, out var prev)
                ? (test, prev.Qty + q)
                : (test, q);
        }

        foreach (var (test, qty) in byId.Values)
        {
            t.Rows.Add(test.Id, test.Code, test.Name, test.Mrp,
                       test.AllowQty ? qty : 1, test.RequiresMrd);
        }

        var param = cmd.Parameters.AddWithValue(name, t);
        param.SqlDbType = SqlDbType.Structured;
        param.TypeName = "dbo.TeloCustomLine";
    }

    private static void AddPaymentTvp(SqlCommand cmd, string name, IReadOnlyList<PaymentLine> lines)
    {
        var t = new System.Data.DataTable();
        t.Columns.Add("seq", typeof(int));
        t.Columns.Add("method", typeof(string));
        t.Columns.Add("amount", typeof(int));
        t.Columns.Add("ref", typeof(string));

        var seq = 0;
        foreach (var p in lines)
        {
            if (p.Amount <= 0) continue;
            var method = string.IsNullOrWhiteSpace(p.Method) ? "Cash" : p.Method.Trim();
            // Cash has no reference to keep, and storing one invites a
            // reconciliation against something that was never issued.
            var reference = method.Equals("Cash", StringComparison.OrdinalIgnoreCase)
                ? null
                : (string.IsNullOrWhiteSpace(p.Ref) ? null : p.Ref.Trim());
            t.Rows.Add(seq++, method[..Math.Min(50, method.Length)], p.Amount,
                reference?[..Math.Min(50, reference.Length)]);
        }

        var param = cmd.Parameters.AddWithValue(name, t);
        param.SqlDbType = SqlDbType.Structured;
        param.TypeName = "dbo.TeloPayment";
    }

    private static byte[]? DecodeClinicalFile(string? base64)
    {
        if (string.IsNullOrWhiteSpace(base64)) return null;

        // Data URLs arrive from a browser's FileReader as
        // "data:application/pdf;base64,JVBERi0..." — take what follows.
        var comma = base64.IndexOf(',');
        var payload = comma >= 0 && base64.StartsWith("data:", StringComparison.Ordinal)
            ? base64[(comma + 1)..]
            : base64;

        return Convert.TryFromBase64String(payload, new byte[payload.Length], out var written)
            ? Convert.FromBase64String(payload)[..written]
            : null;
    }

    /// <summary>Infinity's origin marker. See the class remarks.</summary>
    private const string Origin = "inf:";

    /// <summary>
    /// Which tubes this set of tests needs. Read-only, so it calls Telo's
    /// preview procedure directly with no origin concern.
    /// </summary>
    public Task<IReadOnlyList<SampleGroup>> PreviewSampleGroupsAsync(
        IReadOnlyList<CartItem> items, CancellationToken ct = default)
    {
        if (items.Count == 0) return Task.FromResult<IReadOnlyList<SampleGroup>>([]);

        return retry.ExecuteAsync("orders.sampleGroups", token =>
            db.QueryAsync("orders.sampleGroups", async (conn, inner) =>
            {
                await using var cmd = db.CreateWriteCommand(conn, "dbo.usp_telo_preview_sample_groups");
                AddTestListTvp(cmd, "@items", items);

                await using var r = await cmd.ExecuteReaderAsync(CommandBehavior.SingleResult, inner)
                    .ConfigureAwait(false);

                var groups = new List<SampleGroup>();
                while (await r.ReadAsync(inner).ConfigureAwait(false))
                {
                    groups.Add(new SampleGroup(
                        SampleTypeId: r.NullableInt("sampleTypeId") ?? -1,
                        SampleTypeName: r.Str("sampleTypeName"),
                        Codes: r.Str("csvCodes"),
                        Names: r.Str("csvNames"),
                        RequiresSplit: r.GetOrdinalBool("requiresSplit"),
                        ItemCount: r.NullableInt("itemCount") ?? 0));
                }

                return (IReadOnlyList<SampleGroup>)groups;
            }, token), ct);
    }

    /// <summary>
    /// Place the order.
    ///
    /// NOT retried. This is a non-idempotent write that consumes a bill number,
    /// creates a patient, writes receipts and posts to the ledger; a replay
    /// after a timeout would bill the patient twice. A caller that times out
    /// must check whether the order landed, not try again.
    /// </summary>
    /// <summary>
    /// Store (or update) a patient's date of birth in the Infinity sidecar.
    /// </summary>
    /// <remarks>
    /// Called after the order is booked, once the create procedure has returned
    /// the patient id. Deliberately separate from usp_telo_create_order — that
    /// procedure is shared with Telo and maps to a LIS that has no birth-date
    /// column, so the DOB is written here instead of threaded through it. The
    /// caller treats a failure as non-fatal: the order is already committed and
    /// a missing DOB is a blank line on a future report, not a lost order.
    /// </remarks>
    public Task SetPatientDobAsync(int patientId, DateOnly dob, string? actor, CancellationToken ct = default) =>
        retry.ExecuteAsync("orders.setDob", token =>
            db.QueryAsync("orders.setDob", async (conn, inner) =>
            {
                await using var cmd = db.CreateWriteCommand(conn, "dbo.usp_inf_set_patient_dob");
                cmd.Parameters.Add("@patient_id", SqlDbType.Int).Value = patientId;
                cmd.Parameters.Add("@dob", SqlDbType.Date).Value = dob.ToDateTime(TimeOnly.MinValue);
                cmd.Parameters.Add("@actor", SqlDbType.NVarChar, 100).Value = (object?)actor ?? DBNull.Value;
                await cmd.ExecuteNonQueryAsync(inner).ConfigureAwait(false);
                return 0;
            }, token), ct);

    /// <param name="customLines">
    /// Already RESOLVED against the catalogue by the caller, which is what
    /// makes the price trustworthy — the request only ever carried an id and a
    /// quantity. See CustomTestRepository.ResolveAsync.
    /// </param>
    public Task<CreateOrderResult> CreateAsync(
        int userId, CreateOrderRequest req,
        IReadOnlyList<(CustomTest Test, int Qty)>? customLines = null,
        CancellationToken ct = default) =>
        db.QueryAsync("orders.create", async (conn, inner) =>
        {
            await using var cmd = db.CreateWriteCommand(conn, "dbo.usp_telo_create_order");
            // Order creation touches a dozen tables inside one transaction and
            // takes an app-lock for the bill number; the default read timeout is
            // not the right budget for it.
            cmd.CommandTimeout = 60;

            cmd.Parameters.Add("@userId", SqlDbType.Int).Value = userId;
            cmd.Parameters.Add("@mcc", SqlDbType.Int).Value = req.Mcc;

            AddSidTvp(cmd, "@sids", req.SampleSids ?? []);
            AddTestListTvp(cmd, "@items", req.Items);
            AddPaymentTvp(cmd, "@payments", req.Payments ?? []);
            // The procedure has always taken these — Telo has billed custom
            // lines through them since it was written — Infinity simply never
            // sent any. Empty for an ordinary order, which is how it behaved
            // before this and how it still behaves.
            AddCustomLineTvp(cmd, "@customLines", customLines ?? []);
            AddVarChar(cmd, "@mrdText", 200, req.MrdText);

            cmd.Parameters.Add("@patientId", SqlDbType.Int).Value = req.PatientId ?? 0;
            AddNVarChar(cmd, "@name", 200, req.Name);
            AddNVarChar(cmd, "@initial", 10, req.Initial);
            cmd.Parameters.Add("@age", SqlDbType.Int).Value = (object?)req.Age ?? DBNull.Value;
            cmd.Parameters.Add("@gender", SqlDbType.Int).Value = (object?)req.Gender ?? DBNull.Value;
            cmd.Parameters.Add("@ageType", SqlDbType.Int).Value = (object?)req.AgeType ?? DBNull.Value;
            AddVarChar(cmd, "@mobile", 20, req.Mobile);
            AddVarChar(cmd, "@email", 100, req.Email);
            AddVarChar(cmd, "@clinicalHistory", 500, req.ClinicalHistory);
            AddVarChar(cmd, "@mrnId", 50, req.MrnId);
            cmd.Parameters.Add("@refDoctor", SqlDbType.Int).Value = (object?)req.RefDoctor ?? DBNull.Value;
            cmd.Parameters.Add("@refCustomer", SqlDbType.Int).Value = (object?)req.RefCustomer ?? DBNull.Value;
            AddNVarChar(cmd, "@newRefDoctorName", 200, req.NewRefDoctorName);
            AddNVarChar(cmd, "@newRefCustomerName", 200, req.NewRefCustomerName);
            cmd.Parameters.Add("@discountAmount", SqlDbType.Int).Value = req.DiscountAmount;
            AddVarChar(cmd, "@paymentType", 50, req.PaymentType);
            cmd.Parameters.Add("@payMode", SqlDbType.Int).Value = (object?)req.PayMode ?? DBNull.Value;
            cmd.Parameters.Add("@receiptAmount", SqlDbType.Int).Value = req.ReceiptAmount;
            cmd.Parameters.Add("@billAtMrp", SqlDbType.Bit).Value = req.BillAtMrp;
            // A B2B order is TAGGED at MRP but PRICED at the client rate: the
            // centre is billed what it owes the lab, not what its patient pays
            // it. Sent for B2B only, so a walk-in keeps resolving exactly as
            // before. See 108_alter_telo_create_order_client_rate.sql.
            cmd.Parameters.Add("@priceAtClientRate", SqlDbType.Bit).Value = req.BillAtMrp;
            AddVarChar(cmd, "@paymentRef", 100, req.PaymentRef);

            // Gold Card. Sent as 0 for a B2B order even if the caller set it —
            // the procedure ignores it there anyway, and passing it would
            // suggest, in the audit trail and to the next reader, that a
            // reduction was attempted on a bill that cannot take one.
            var gold = req.GoldCard
                       && !req.BillAtMrp
                       && !string.IsNullOrWhiteSpace(req.GoldCardNumber)
                       && !string.IsNullOrWhiteSpace(req.GoldCardHolder);
            cmd.Parameters.Add("@goldCard", SqlDbType.Bit).Value = gold;
            AddNVarChar(cmd, "@goldCardNumber", 50, gold ? req.GoldCardNumber : null);
            AddNVarChar(cmd, "@goldCardHolder", 200, gold ? req.GoldCardHolder : null);

            // The attachment. Decoded here rather than at the endpoint so the
            // bytes exist only for the life of this call.
            var pdf = DecodeClinicalFile(req.ClinicalFileBase64);
            cmd.Parameters.Add("@clinicalFile", SqlDbType.VarBinary, -1).Value =
                (object?)pdf ?? DBNull.Value;
            AddVarChar(cmd, "@clinicalFileName", 100,
                pdf is null ? null : (req.ClinicalFileName ?? "clinical-history.pdf"));

            // THE marker. See the class remarks.
            cmd.Parameters.Add("@origin", SqlDbType.NVarChar, 20).Value = Origin;

            await using var r = await cmd.ExecuteReaderAsync(inner).ConfigureAwait(false);

            var ok = false;
            string? errorCode = null, message = null;
            int? patientId = null, billId = null, billNumber = null;
            var total = 0; var sampleCount = 0;

            if (await r.ReadAsync(inner).ConfigureAwait(false))
            {
                ok = r.GetOrdinalBool("ok");
                errorCode = r.Str("error_code");
                message = r.Str("message");
                patientId = r.NullableInt("patient_id");
                billId = r.NullableInt("bill_id");
                billNumber = r.NullableInt("bill_number");
                total = r.NullableInt("total") ?? 0;
                sampleCount = r.NullableInt("sample_count") ?? 0;
            }

            // Second result set: the samples actually issued. Always present,
            // empty on failure and on an order booked without barcodes.
            //
            // snake_case, exactly as the procedure declares them (sample_id,
            // vailid, sample_type_id, sample_type_name — 60_usp_telo_create_
            // order.sql) and as AddSidsAsync reads the same shape. This read
            // was written camelCase, and the mistake stayed invisible for as
            // long as every order was booked WITHOUT barcodes: with zero rows
            // the column lookup never ran. The first real order with a scanned
            // SID reached the first row, asked for a column that does not
            // exist, and turned a successfully booked order into a 500 — the
            // procedure had already committed by the time the read blew up, so
            // the operator was told it failed while the LIS said it happened.
            var samples = new List<IssuedSample>();
            if (await r.NextResultAsync(inner).ConfigureAwait(false))
            {
                while (await r.ReadAsync(inner).ConfigureAwait(false))
                {
                    samples.Add(new IssuedSample(
                        SampleId: r.NullableInt("sample_id") ?? 0,
                        Vailid: r.Str("vailid"),
                        SampleTypeId: r.NullableInt("sample_type_id") ?? -1,
                        SampleTypeName: r.Str("sample_type_name")));
                }
            }

            return new CreateOrderResult(
                ok, errorCode, message, patientId, billId, billNumber, total, sampleCount, samples);
        }, ct);

    // ---- TVP builders ------------------------------------------------------

    /// <summary>
    /// dbo.TeloTestList. Deduplicated on (itemKind, testMasterId) because the
    /// type declares that pair as its primary key — a repeated item would fail
    /// the whole insert rather than being ignored.
    /// </summary>
    private static void AddTestListTvp(SqlCommand cmd, string name, IReadOnlyList<CartItem> items)
    {
        var t = new DataTable();
        t.Columns.Add("testMasterId", typeof(int));
        t.Columns.Add("itemKind", typeof(byte));
        t.Columns.Add("code", typeof(string));
        t.Columns.Add("name", typeof(string));

        var seen = new HashSet<(byte, int)>();
        foreach (var i in items)
        {
            byte kind = i.Kind switch { "master" => 2, "profile" => 1, _ => 0 };
            if (!seen.Add((kind, i.Id))) continue;

            // Both columns are NOT NULL in the type. Falling back to the id
            // keeps a catalogue row with a missing code or name insertable
            // rather than failing the order.
            var code = Truncate(i.Code, 50);
            var label = Truncate(i.Name, 200);
            t.Rows.Add(i.Id, kind,
                string.IsNullOrWhiteSpace(code) ? i.Id.ToString() : code,
                string.IsNullOrWhiteSpace(label) ? (code ?? i.Id.ToString()) : label);
        }

        var p = cmd.Parameters.AddWithValue(name, t);
        p.SqlDbType = SqlDbType.Structured;
        p.TypeName = "dbo.TeloTestList";
    }

    /// <summary>dbo.TeloSampleSid — keyed on sampleTypeId, so one barcode per tube.</summary>
    private static void AddSidTvp(SqlCommand cmd, string name, IReadOnlyList<SampleSid> sids)
    {
        var t = new DataTable();
        t.Columns.Add("sampleTypeId", typeof(int));
        t.Columns.Add("vailid", typeof(string));

        var seen = new HashSet<int>();
        foreach (var s in sids)
        {
            if (string.IsNullOrWhiteSpace(s.Vailid)) continue;
            if (!seen.Add(s.SampleTypeId)) continue;
            t.Rows.Add(s.SampleTypeId, s.Vailid.Trim());
        }

        var p = cmd.Parameters.AddWithValue(name, t);
        p.SqlDbType = SqlDbType.Structured;
        p.TypeName = "dbo.TeloSampleSid";
    }

    private static string? Truncate(string? s, int max) =>
        string.IsNullOrEmpty(s) ? s : (s.Length <= max ? s : s[..max]);

    private static void AddNVarChar(SqlCommand cmd, string name, int size, string? value) =>
        cmd.Parameters.Add(name, SqlDbType.NVarChar, size).Value =
            value is null ? DBNull.Value : Truncate(value, size)!;

    private static void AddVarChar(SqlCommand cmd, string name, int size, string? value) =>
        cmd.Parameters.Add(name, SqlDbType.VarChar, size).Value =
            value is null ? DBNull.Value : Truncate(value, size)!;
}
