using Npgsql;

namespace Stellar.Sync;

/// <summary>
/// The clinical core: registrations, samples, ordered tests, results, events.
///
/// These are the big tables — 3.4M registrations, 5.5M samples, 5.0M ordered
/// tests, 68.3M results — and unlike the masters they reference each other, so
/// the load order below matters. Foreign keys are STAGED (see 007_fk_staging)
/// and resolved by <see cref="Resolver"/> after each cycle rather than looked
/// up per row: at these volumes a per-row lookup is the difference between a
/// hash join and 5 million index probes.
/// </summary>
internal static class ClinicalTables
{
    /// <summary>
    /// Everything except <see cref="Result"/>, which is 68M rows and is run on
    /// its own schedule — see the note on that property.
    /// </summary>
    public static IReadOnlyList<TableSync> All =>
    [
        Registration,
        Sample,
        OrderedTest,
        SampleEvent,
    ];

    // ---- registration (Noble: tbl_med_mcc_patient_master, 3.4M) -------------
    //
    // One VISIT, not one person. person_id is left NULL here and populated by
    // the matcher later; see the header of 003_people_documents.sql.
    public static TableSync Registration => new()
    {
        NobleTable = "tbl_med_mcc_patient_master",
        KeyColumns = ["id"],
        SelectList = """
            t.id, t.mcc_code, t.initial, t.name, t.age, t.age_type, t.gender,
            t.sample_time, t.ref_doctor, t.ref_customer, t.ref_doctor_other,
            t.ref_customer_other, t.mobile_number, t.email, t.Clinical_History,
            t.order_number, t.bill_number, t.MRNID, t.Status, t.addedby, t.addeddate
            """,
        Apply = async (pg, rows, ct) =>
        {
            var vals = rows.Select(r => new object?[]
            {
                Conv.ToInt(r["id"]),
                Conv.ToInt(r["mcc_code"]),
                Conv.Text(r["initial"]),
                Conv.Text(r["name"]),
                Conv.Sex(r["gender"]),
                Conv.ToInt(r["age"]),
                Conv.AgeUnit(r["age_type"]),
                Conv.Text(r["mobile_number"]),
                Conv.Text(r["email"]),
                Conv.Text(r["Clinical_History"]),
                Conv.ToInt(r["ref_doctor"]),
                Conv.ToInt(r["ref_customer"]),
                Conv.Text(r["ref_doctor_other"]),
                Conv.Text(r["ref_customer_other"]),
                // sample_time carries the full timestamp; sample_date is the
                // same day at midnight and adds nothing.
                Conv.Ts(r["sample_time"]),
                Conv.Text(r["order_number"]),
                // Noble reuses this column for SRF/MRN identifiers, hence text.
                Conv.Text(r["bill_number"]),
                Conv.Text(r["MRNID"]),
                Conv.ToInt(r["Status"]),
                Conv.Origin(r["addedby"]),
                Conv.Ts(r["addeddate"]),
            }).ToList();

            await Upsert.RunAsync(pg, "registration",
                ["noble_id", "centre_noble_id", "title", "name", "sex", "age", "age_unit",
                 "mobile_number", "email", "clinical_history",
                 "ref_doctor_noble_id", "ref_customer_noble_id",
                 "referring_doctor_other", "referring_customer_other",
                 "sample_collected_at", "order_number", "bill_number_text", "mrn_id",
                 "status", "origin", "created_at"],
                vals, ct);
        },
        Delete = (pg, ids, ct) => Upsert.DeleteAsync(pg, "registration", ids, ct),
    };

    // ---- sample (Noble: tbl_med_mcc_patient_samples, 5.5M) ------------------
    //
    // Noble denormalises the ordered tests onto this row as three parallel
    // delimited strings (testcodes / testnames / testtypes, varchar(1000)).
    // They are deliberately NOT carried: ordered_test holds the same facts
    // relationally, and a truncated-at-1000-chars list is a bug waiting to be
    // parsed.
    public static TableSync Sample => new()
    {
        NobleTable = "tbl_med_mcc_patient_samples",
        KeyColumns = ["id"],
        SelectList = """
            t.id, t.patient_id, t.sampleid, t.vailid, t.sample_status,
            t.reject_comments, t.Sample_Comments, t.Sample_ClinicalHistory,
            t.report_type, t.department_id, t.business_unit_id, t.authorised_by,
            t.signature_id, t.mobile_number, t.modifieddate, t.lastmodified_date,
            t.addedby, t.addeddate
            """,
        Apply = async (pg, rows, ct) =>
        {
            var vals = rows
                // vailid is NOT NULL in Noble and unique by trigger, but a
                // blank one would collide with every other blank under our
                // unique index. Skip rather than abort the batch.
                .Where(r => Conv.Text(r["vailid"]) is not null)
                .Select(r => new object?[]
                {
                    Conv.ToInt(r["id"]),
                    Conv.Text(r["vailid"]),
                    Conv.ToInt(r["patient_id"]),
                    Conv.ToInt(r["sampleid"]),
                    Conv.ToInt(r["sample_status"]),
                    Conv.Text(r["reject_comments"]),
                    Conv.Text(r["Sample_Comments"]),
                    Conv.Text(r["Sample_ClinicalHistory"]),
                    Conv.ToInt(r["report_type"]),
                    Conv.Text(r["department_id"]),
                    Conv.ToInt(r["business_unit_id"]),
                    Conv.ToInt(r["authorised_by"]),
                    Conv.ToInt(r["signature_id"]),
                    Conv.Text(r["mobile_number"]),
                    Conv.Ts(r["modifieddate"]),        // Listec's "Registration Date"
                    Conv.Ts(r["lastmodified_date"]),   // Listec's "Report Date"
                    Conv.Origin(r["addedby"]),
                    Conv.Ts(r["addeddate"]),
                }).ToList();

            await Upsert.RunAsync(pg, "sample",
                ["noble_id", "sid", "registration_noble_id", "specimen_noble_id",
                 "status_id", "reject_comments", "comments", "clinical_history",
                 "report_type", "department_id", "business_unit_id",
                 "authorised_by_noble_id", "signature_id", "mobile_number",
                 "registered_at", "last_modified_at", "origin", "created_at"],
                vals, ct);
        },
        Delete = (pg, ids, ct) => Upsert.DeleteAsync(pg, "sample", ids, ct),
    };

    // ---- ordered test (Noble: tbl_med_mcc_patient_tests, 5.0M) --------------
    public static TableSync OrderedTest => new()
    {
        NobleTable = "tbl_med_mcc_patient_tests",
        KeyColumns = ["id"],
        SelectList = """
            t.id, t.patient_id, t.test_id, t.test_code, t.test_name, t.test_rate,
            t.test_type, t.amount_checked, t.comments, t.addedby, t.addeddate
            """,
        Apply = async (pg, rows, ct) =>
        {
            var vals = rows.Select(r => new object?[]
            {
                Conv.ToInt(r["id"]),
                Conv.ToInt(r["patient_id"]),
                Conv.ToInt(r["test_id"]),
                Conv.Text(r["test_code"]),
                Conv.Text(r["test_name"]),
                Conv.Text(r["test_type"]),
                Conv.Money(r["test_rate"]),
                Conv.Flag(r["amount_checked"]),
                Conv.Text(r["comments"]),
                Conv.Origin(r["addedby"]),
                Conv.Ts(r["addeddate"]),
            }).ToList();

            await Upsert.RunAsync(pg, "ordered_test",
                ["noble_id", "registration_noble_id", "test_noble_id", "test_code",
                 "test_name", "test_type", "rate", "amount_checked", "comments",
                 "origin", "created_at"],
                vals, ct);
        },
        Delete = (pg, ids, ct) => Upsert.DeleteAsync(pg, "ordered_test", ids, ct),
    };

    // ---- sample event (Noble: tbl_med_mcc_test_transactions, 5.5M) ----------
    //
    // WARNING, READ BEFORE TOUCHING THE MAPPING BELOW.
    //
    // This table has a column named `vailid` that does NOT contain a vial id.
    // It contains the PATIENT NAME - live rows read 'PRIYA W/O MOHIT',
    // 'RAMWATI', 'HIMANI'. The first version of this mapper trusted the name,
    // staged it as sample_vailid and tried to resolve it against sample.sid;
    // 4.9 million rows staged and exactly zero matched, which is how it was
    // caught. The real link to the rest of the schema is `patientid`, which is
    // a registration id.
    //
    // Noble's table also conflates an event log with a running account balance
    // (currentbalance / closingbalance recomputed per row). Only the event half
    // is taken; the money is account_entry's job, and duplicating a derived
    // balance is how two sources of truth start disagreeing.
    public static TableSync SampleEvent => new()
    {
        NobleTable = "tbl_med_mcc_test_transactions",
        KeyColumns = ["id"],
        SelectList = """
            t.id, t.mccid, t.transdate, t.userid, t.tname, t.vailid,
            t.patientid, t.description
            """,
        Apply = async (pg, rows, ct) =>
        {
            var vals = rows.Select(r => new object?[]
            {
                Conv.ToInt(r["id"]),
                // patientid, NOT vailid. See the note above: the column called
                // vailid on this table does not contain a vial id.
                Conv.ToInt(r["patientid"]),
                Conv.ToInt(r["mccid"]),
                Conv.Text(r["tname"]),
                Conv.Text(r["description"]),
                Conv.Ts(r["transdate"]),
            }).ToList();

            await Upsert.RunAsync(pg, "sample_event",
                ["noble_id", "registration_noble_id", "centre_noble_id", "test_name",
                 "description", "occurred_at"],
                vals, ct);
        },
        Delete = (pg, ids, ct) => Upsert.DeleteAsync(pg, "sample_event", ids, ct),
    };

    // ---- result (Noble: tbl_med_mcc_patient_test_result, 68.3M) -------------
    //
    // NOT in All. 68 million rows is a load measured in hours, not minutes, and
    // it should be started deliberately (--tables result) rather than as a side
    // effect of a routine sync pass. Once snapshotted it tails like anything
    // else and costs nothing.
    //
    // created_at comes from Noble's addeddate, NOT now(). It is the partition
    // key AND half the conflict target, so it has to be stable: if it were the
    // wall clock, re-syncing a row would insert a duplicate into a different
    // monthly partition instead of updating the original.
    public static TableSync Result => new()
    {
        NobleTable = "tbl_med_mcc_patient_test_result",
        KeyColumns = ["id"],
        SelectList = """
            t.id, t.vailid, t.testid, t.testcode, t.testname, t.paramid,
            t.profile_id, t.master_profile_id, t.level_id, t.testtype,
            CAST(t.value AS NVARCHAR(MAX)) AS value, t.testunit,
            t.testnormal_range, CAST(t.comments AS NVARCHAR(MAX)) AS comments,
            t.abnormal, t.auth, t.attachment, t.hasparameters,
            t.machine_name, t.tat, t.addedby, t.addeddate
            """,
        Apply = async (pg, rows, ct) =>
        {
            var vals = rows.Select(r => new object?[]
            {
                Conv.ToInt(r["id"]),
                Conv.Text(r["vailid"]),
                Conv.ToInt(r["testid"]),
                Conv.Text(r["testcode"]),
                Conv.Text(r["testname"]),
                Conv.ToInt(r["paramid"]),
                Conv.ToInt(r["profile_id"]),
                Conv.ToInt(r["master_profile_id"]),
                Conv.ToInt(r["level_id"]),
                Conv.Text(r["testtype"]),
                Conv.Text(r["value"]),
                Conv.Text(r["testunit"]),
                Conv.Text(r["testnormal_range"]),
                Conv.Text(r["comments"]),
                Conv.Flag(r["abnormal"]),
                Conv.Flag(r["auth"]),
                Conv.Flag(r["attachment"]),
                Conv.Flag(r["hasparameters"]),
                Conv.Text(r["machine_name"]),
                Conv.Ts(r["tat"]),
                Conv.Origin(r["addedby"]),
                // Fallback matters: ~10% of Noble's result rows predate the
                // addeddate column being populated, and a NULL partition key
                // is rejected outright.
                Conv.Ts(r["addeddate"]) ?? new DateTimeOffset(2019, 1, 1, 0, 0, 0, TimeSpan.Zero),
            }).ToList();

            await Upsert.RunAsync(pg, "result",
                ["noble_id", "sample_vailid", "test_noble_id", "test_code", "test_name",
                 "param_id", "profile_id", "master_profile_id", "level_id", "test_type",
                 "value", "unit", "normal_range", "comments", "is_abnormal",
                 "is_authorised", "has_attachment", "has_parameters", "machine_name",
                 "tat", "origin", "created_at"],
                vals, ct, conflict: "noble_id, created_at");
        },
        Delete = async (pg, ids, ct) =>
        {
            if (ids.Count == 0) return;
            // No created_at to narrow by, so this hits every partition. Deletes
            // on results are rare enough that the scan is acceptable.
            await using var cmd = new NpgsqlCommand(
                "DELETE FROM stellar.result WHERE noble_id = ANY(@ids)", pg);
            cmd.Parameters.AddWithValue("@ids", ids.ToArray());
            await cmd.ExecuteNonQueryAsync(ct);
        },
    };
}
