namespace Stellar.Sync;

/// <summary>
/// Bills, lines, receipts and the centre ledger.
///
/// Small by comparison with the clinical core — 23k bills, 40k lines, 22k
/// receipts, 551k ledger entries — but the tables where correctness matters
/// most, since they are the ones Telo and Infinity both write to today.
/// </summary>
internal static class BillingTables
{
    public static IReadOnlyList<TableSync> All =>
    [
        Bill,
        BillLine,
        Receipt,
        AccountEntry,
    ];

    // ---- bill (Noble: tbl_billing_patient_detail, 23,297) -------------------
    //
    // The patient's name, age and sex are copied onto the bill by Noble as well
    // as living on the registration. Carried deliberately: a bill is a document
    // that was PRINTED with those values, and a later correction to the
    // registration must not retroactively rewrite what was handed over.
    public static TableSync Bill => new()
    {
        NobleTable = "tbl_billing_patient_detail",
        KeyColumns = ["id"],
        SelectList = """
            t.id, t.bill_number, t.bill_date, t.mcc_code, t.medid, t.patientname,
            t.age, t.age_type, t.gender, t.mobile_number, t.email, t.ipopnumber,
            t.ref_doctor, t.ref_customer, t.amount, t.dis_type, t.dis_per,
            t.discount_amount, t.service_tax_type, t.service_tax_per,
            t.service_tax_amount, t.amount_paid, t.Balance, t.payment_type,
            t.paymode, t.noofpatients, t.phlebotomy, t.remarks, t.comments,
            t.addedby, t.addeddate
            """,
        Apply = async (pg, rows, ct) =>
        {
            var vals = rows.Select(r => new object?[]
            {
                Conv.ToInt(r["id"]),
                Conv.ToInt(r["bill_number"]),
                Conv.ToInt(r["mcc_code"]),
                // medid is the registration id, stored as a varchar in Noble.
                Conv.ToInt(r["medid"]),
                Conv.Text(r["patientname"]),
                Conv.ToInt(r["age"]),
                // Unlike patient_master's numeric age_type, the bill stores it
                // as text ('Year(s)'), so it needs its own decode.
                AgeUnitFromText(r["age_type"]),
                Conv.Sex(r["gender"]),
                Conv.Text(r["mobile_number"]),
                Conv.Text(r["email"]),
                Conv.Text(r["ipopnumber"]),
                Conv.ToInt(r["ref_doctor"]),
                Conv.ToInt(r["ref_customer"]),
                Conv.Money(r["amount"]),
                Conv.Text(r["dis_type"]),
                Conv.Money(r["dis_per"]),
                Conv.Money(r["discount_amount"]),
                Conv.Text(r["service_tax_type"]),
                Conv.Money(r["service_tax_per"]),
                Conv.Money(r["service_tax_amount"]),
                Conv.Money(r["amount_paid"]),
                Conv.Money(r["Balance"]),
                Conv.Text(r["payment_type"]),
                Conv.ToInt(r["paymode"]),
                Conv.ToInt(r["noofpatients"]),
                Conv.Flag(r["phlebotomy"]),
                Conv.Text(r["remarks"]),
                Conv.Text(r["comments"]),
                Conv.Ts(r["bill_date"]),
                Conv.Origin(r["addedby"]),
                Conv.CreatedAt(r["addeddate"], r["bill_date"]),
            }).ToList();

            await Upsert.RunAsync(pg, "bill",
                ["noble_id", "bill_number", "centre_noble_id", "registration_noble_id",
                 "patient_name", "age", "age_unit", "sex", "mobile_number", "email",
                 "ip_op_number", "ref_doctor_noble_id", "ref_customer_noble_id",
                 "amount", "discount_type", "discount_percent", "discount_amount",
                 "tax_type", "tax_percent", "tax_amount", "amount_paid", "balance",
                 "payment_type", "pay_mode", "patient_count", "is_phlebotomy",
                 "remarks", "comments", "billed_at", "origin", "created_at"],
                vals, ct);
        },
        Delete = (pg, ids, ct) => Upsert.DeleteAsync(pg, "bill", ids, ct),
    };

    /// <summary>Bill headers store the age unit as free text, not a code.</summary>
    private static string? AgeUnitFromText(object? v)
    {
        var s = v?.ToString()?.Trim().ToLowerInvariant();
        if (string.IsNullOrEmpty(s)) return null;
        if (s.StartsWith("y")) return "years";
        if (s.StartsWith("m")) return "months";
        if (s.StartsWith("d")) return "days";
        return null;
    }

    // ---- bill line (Noble: tbl_billing_patient_test_detail, 39,563) ---------
    public static TableSync BillLine => new()
    {
        NobleTable = "tbl_billing_patient_test_detail",
        KeyColumns = ["id"],
        SelectList = "t.id, t.billid, t.testcode, t.testname, t.testamount, t.testtype, t.ref_amount",
        Apply = async (pg, rows, ct) =>
        {
            var vals = rows.Select(r => new object?[]
            {
                Conv.ToInt(r["id"]),
                Conv.ToInt(r["billid"]),
                Conv.Text(r["testcode"]),
                Conv.Text(r["testname"]),
                Conv.Text(r["testtype"]),
                Conv.Money(r["testamount"]),
                Conv.Money(r["ref_amount"]),
            }).ToList();

            await Upsert.RunAsync(pg, "bill_line",
                ["noble_id", "bill_noble_id", "test_code", "test_name", "test_type",
                 "amount", "ref_amount"],
                vals, ct);
        },
        Delete = (pg, ids, ct) => Upsert.DeleteAsync(pg, "bill_line", ids, ct),
    };

    // ---- receipt (Noble: tbl_billing_patient_amount_receipt, 21,740) --------
    //
    // Noble carries the live/void state in receive_status as a string, with
    // Telo layering telo_receipt_void on top. Folded into a nullable voided_at
    // so "is this receipt live" is one predicate instead of a join plus a
    // string comparison — the shape the balance calculation actually wants.
    public static TableSync Receipt => new()
    {
        NobleTable = "tbl_billing_patient_amount_receipt",
        KeyColumns = ["id"],
        SelectList = """
            t.id, t.bill_id, t.recd_date, t.amount, t.receivedby,
            t.receive_status, t.pay_mode, t.card_number
            """,
        Apply = async (pg, rows, ct) =>
        {
            var vals = rows.Select(r =>
            {
                var status = Conv.Text(r["receive_status"]);
                var voided = status is not null
                    && (status.Equals("V", StringComparison.OrdinalIgnoreCase)
                        || status.Contains("void", StringComparison.OrdinalIgnoreCase));
                return new object?[]
                {
                    Conv.ToInt(r["id"]),
                    Conv.ToInt(r["bill_id"]),
                    Conv.Money(r["amount"]) ?? 0m,
                    Conv.Text(r["pay_mode"]),
                    Conv.Text(r["card_number"]),
                    Conv.Text(r["receivedby"]),
                    Conv.Ts(r["recd_date"]),
                    // Noble does not record WHEN a receipt was voided, only
                    // that it was. Using the receipt date would invent a fact;
                    // the epoch marks "voided, time unknown" honestly.
                    voided ? (object?)new DateTimeOffset(1970, 1, 1, 0, 0, 0, TimeSpan.Zero) : null,
                    voided ? $"Voided in the LIS (status '{status}')" : null,
                };
            }).ToList();

            await Upsert.RunAsync(pg, "receipt",
                ["noble_id", "bill_noble_id", "amount", "pay_mode", "card_number",
                 "received_by", "received_at", "voided_at", "voided_reason"],
                vals, ct);
        },
        Delete = (pg, ids, ct) => Upsert.DeleteAsync(pg, "receipt", ids, ct),
    };

    // ---- account entry (Noble: tbl_med_mcc_account_detail, 550,894) ---------
    //
    // Noble stores a positive amount plus a debit_flag bit. Signing the amount
    // means a running balance is SUM(amount) rather than a CASE over the flag,
    // and no consumer can get the direction backwards.
    public static TableSync AccountEntry => new()
    {
        NobleTable = "tbl_med_mcc_account_detail",
        KeyColumns = ["id"],
        SelectList = """
            t.id, t.mcccode, t.credittype, t.deposittype, t.depositedate,
            t.amount, t.chequeorddnummber, t.Reason, t.debit_flag,
            t.addedby, t.addeddate
            """,
        Apply = async (pg, rows, ct) =>
        {
            var vals = rows.Select(r =>
            {
                var isDebit = Conv.Flag(r["debit_flag"]);
                var magnitude = Conv.Money(r["amount"]) ?? 0m;
                return new object?[]
                {
                    Conv.ToInt(r["id"]),
                    Conv.ToInt(r["mcccode"]),
                    isDebit ? "debit" : "credit",
                    isDebit ? -Math.Abs(magnitude) : Math.Abs(magnitude),
                    Conv.ToInt(r["credittype"]),
                    Conv.ToInt(r["deposittype"]),
                    Conv.Text(r["chequeorddnummber"]),
                    Conv.Text(r["Reason"]),
                    Conv.Ts(r["depositedate"]),
                    Conv.Origin(r["addedby"]),
                    Conv.CreatedAt(r["addeddate"], r["depositedate"]),
                };
            }).ToList();

            await Upsert.RunAsync(pg, "account_entry",
                ["noble_id", "centre_noble_id", "direction", "amount", "credit_type",
                 "deposit_type", "instrument_ref", "reason", "occurred_at",
                 "origin", "created_at"],
                vals, ct);
        },
        Delete = (pg, ids, ct) => Upsert.DeleteAsync(pg, "account_entry", ids, ct),
    };
}
