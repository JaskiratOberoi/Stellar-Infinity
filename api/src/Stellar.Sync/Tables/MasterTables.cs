using Npgsql;

namespace Stellar.Sync;

/// <summary>
/// The slow-moving reference tables, and the order they must load in.
///
/// Order is a real constraint, not a preference: `test` references
/// `specimen_type`, `lab_user` references `centre`, and the FK resolution in
/// each mapper is a lookup by noble_id that returns NULL if the parent has not
/// arrived yet. Loading out of order does not fail — it silently produces
/// nulls — so the ordering here is load-bearing and the list is the schedule.
/// </summary>
internal static class MasterTables
{
    public static IReadOnlyList<TableSync> All =>
    [
        Centre,
        SpecimenType,
        SampleStatus,
        Test,
        LabUser,
        Doctor,
        Customer,
    ];

    // ---- centre --------------------------------------------------------------
    public static TableSync Centre => new()
    {
        NobleTable = "tbl_med_mcc_unit_master",
        KeyColumns = ["id"],
        SelectList = """
            t.id, t.MCCUnitCode, t.MCCUnitName, t.short_name, t.address, t.Area,
            t.city, t.stateid, t.country, t.zip, t.phone, t.email, t.ContactPerson,
            t.BusinessUnitCode, t.RateType, t.RateTypeBilling, t.creditlimit,
            t.IsActive, t.NeedHeader, t.NeedDateTime, t.smsfaciltiy
            """,
        Apply = async (pg, rows, ct) =>
        {
            var vals = rows
                // A centre with no code cannot be referenced by anything and
                // would break the unique index. Noble has a handful.
                .Where(r => Conv.Text(r["MCCUnitCode"]) is not null)
                .Select(r => new object?[]
                {
                    Conv.ToInt(r["id"]),
                    Conv.Text(r["MCCUnitCode"]),
                    Conv.Text(r["MCCUnitName"]) ?? "(unnamed)",
                    Conv.Text(r["short_name"]),
                    Conv.Text(r["address"]),
                    Conv.Text(r["Area"]),
                    Conv.Text(r["city"]),
                    Conv.ToInt(r["stateid"]),
                    Conv.Text(r["country"]),
                    Conv.Text(r["zip"]),
                    Conv.Text(r["phone"]),
                    Conv.Text(r["email"]),
                    Conv.Text(r["ContactPerson"]),
                    Conv.ToInt(r["BusinessUnitCode"]),
                    Conv.ToInt(r["RateType"]),
                    Conv.ToInt(r["RateTypeBilling"]),
                    Conv.Money(r["creditlimit"]),
                    Conv.Flag(r["IsActive"]),
                    Conv.Flag(r["NeedHeader"]),
                    Conv.Flag(r["NeedDateTime"]),
                    Conv.Flag(r["smsfaciltiy"]),
                }).ToList();

            await Upsert.RunAsync(pg, "centre",
                ["noble_id", "code", "name", "short_name", "address", "area", "city",
                 "state_id", "country", "zip", "phone", "email", "contact_person",
                 "business_unit_id", "rate_type", "rate_type_billing", "credit_limit",
                 "is_active", "needs_header", "needs_date_time", "sms_enabled"],
                vals, ct);
        },
        Delete = (pg, ids, ct) => Upsert.DeleteAsync(pg, "centre", ids, ct),
    };

    // ---- specimen type -------------------------------------------------------
    public static TableSync SpecimenType => new()
    {
        NobleTable = "tbl_med_sample_master",
        KeyColumns = ["id"],
        SelectList = "t.id, t.Sampletype, t.IsActive",
        Apply = async (pg, rows, ct) =>
        {
            var vals = rows.Select(r => new object?[]
            {
                Conv.ToInt(r["id"]),
                Conv.Text(r["Sampletype"]) ?? "(unnamed)",
                Conv.Flag(r["IsActive"]),
            }).ToList();

            await Upsert.RunAsync(pg, "specimen_type",
                ["noble_id", "name", "is_active"], vals, ct);
        },
        Delete = (pg, ids, ct) => Upsert.DeleteAsync(pg, "specimen_type", ids, ct),
    };

    // ---- sample status -------------------------------------------------------
    // The one table whose Noble id IS the stellar PK: the codes are asserted
    // against all over the platform (3 = rejected, 7/8/9 = signed out), so
    // renumbering them behind a surrogate would be actively harmful.
    public static TableSync SampleStatus => new()
    {
        NobleTable = "tbl_med_mcc_patient_samples_status_master",
        KeyColumns = ["id"],
        SelectList = "t.id, t.status, t.status_desc",
        Apply = async (pg, rows, ct) =>
        {
            foreach (var r in rows)
            {
                var id = Conv.ToInt(r["id"]);
                if (id is null) continue;
                await using var cmd = new NpgsqlCommand("""
                    INSERT INTO stellar.sample_status (id, name, description, is_terminal)
                    VALUES (@id, @name, @desc, @term)
                    ON CONFLICT (id) DO UPDATE
                    SET name = EXCLUDED.name,
                        description = EXCLUDED.description,
                        is_terminal = EXCLUDED.is_terminal,
                        updated_at = now()
                    """, pg);
                cmd.Parameters.AddWithValue("@id", id.Value);
                cmd.Parameters.AddWithValue("@name", (object?)Conv.Text(r["status"]) ?? "(unnamed)");
                cmd.Parameters.AddWithValue("@desc", (object?)Conv.Text(r["status_desc"]) ?? DBNull.Value);
                // Derived once, here, instead of in every consumer's WHERE clause.
                cmd.Parameters.AddWithValue("@term", id is 3 or 7 or 8 or 9);
                await cmd.ExecuteNonQueryAsync(ct);
            }
        },
        // Never deleted in practice, and a delete would orphan every sample
        // pointing at it. Left as a no-op deliberately.
        Delete = (_, _, _) => Task.CompletedTask,
    };

    // ---- test catalogue ------------------------------------------------------
    public static TableSync Test => new()
    {
        NobleTable = "tbl_med_test_master",
        KeyColumns = ["id"],
        SelectList = """
            t.id, t.TestCode, t.Testname, t.ReportTestname, t.shortname, t.cap_code,
            t.DepartmentId, t.SampleId, t.Method, t.TAT, t.Price_CT, t.MRP, t.OrderNo,
            t.ReportTypeId, t.Has_Parameters, t.Has_graph, t.Nabl_Logo,
            CAST(t.Interpretation AS NVARCHAR(MAX)) AS Interpretation,
            t.ReportNormalRanges, t.IsActive
            """,
        Apply = async (pg, rows, ct) =>
        {
            var vals = rows
                .Where(r => Conv.Text(r["TestCode"]) is not null)
                .Select(r => new object?[]
                {
                    Conv.ToInt(r["id"]),
                    Conv.Text(r["TestCode"]),
                    Conv.Text(r["Testname"]) ?? "(unnamed)",
                    Conv.Text(r["ReportTestname"]),
                    Conv.Text(r["shortname"]),
                    Conv.Text(r["cap_code"]),
                    Conv.ToInt(r["DepartmentId"]),
                    Conv.ToInt(r["SampleId"]),      // resolved below
                    Conv.Text(r["Method"]),
                    Conv.ToInt(r["TAT"]),
                    Conv.Money(r["Price_CT"]),
                    Conv.Money(r["MRP"]),
                    Conv.ToInt(r["OrderNo"]),
                    Conv.ToInt(r["ReportTypeId"]),
                    Conv.Flag(r["Has_Parameters"]),
                    Conv.Flag(r["Has_graph"]),
                    Conv.Flag(r["Nabl_Logo"]),
                    Conv.Text(r["Interpretation"]),
                    Conv.Text(r["ReportNormalRanges"]),
                    Conv.Flag(r["IsActive"]),
                }).ToList();

            await Upsert.RunAsync(pg, "test",
                ["noble_id", "code", "name", "report_name", "short_name", "cap_code",
                 "department_id", "specimen_noble_id", "method", "tat_hours",
                 "price_ct", "mrp", "order_no", "report_type_id", "has_parameters",
                 "has_graph", "nabl_logo", "interpretation", "report_normal_ranges",
                 "is_active"],
                vals, ct);

            // Resolve the specimen FK in one statement after the batch, rather
            // than a lookup per row on the way in.
            await using var fk = new NpgsqlCommand("""
                UPDATE stellar.test t
                SET specimen_type_id = s.id
                FROM stellar.specimen_type s
                WHERE s.noble_id = t.specimen_noble_id
                  AND t.specimen_type_id IS DISTINCT FROM s.id
                """, pg);
            await fk.ExecuteNonQueryAsync(ct);
        },
        Delete = (pg, ids, ct) => Upsert.DeleteAsync(pg, "test", ids, ct),
    };

    // ---- lab user ------------------------------------------------------------
    public static TableSync LabUser => new()
    {
        NobleTable = "tbl_med_user_master",
        KeyColumns = ["id"],
        // password is deliberately not selected — see the schema comment on
        // lab_user. Copying a credential store into a second system is not a
        // thing to do by accident.
        SelectList = """
            t.id, t.Username, t.firstname, t.lastname, t.Email, t.Phone,
            t.employee_id, t.usertypeid, t.Business_Unit_id, t.PCC_Id, t.IsActive
            """,
        Apply = async (pg, rows, ct) =>
        {
            var vals = rows
                .Where(r => Conv.Text(r["Username"]) is not null)
                .Select(r => new object?[]
                {
                    Conv.ToInt(r["id"]),
                    Conv.Text(r["Username"]),
                    Conv.Text(r["firstname"]),
                    Conv.Text(r["lastname"]),
                    Conv.Text(r["Email"]),
                    Conv.Text(r["Phone"]),
                    Conv.Text(r["employee_id"]),
                    Conv.ToInt(r["usertypeid"]),
                    Conv.ToInt(r["Business_Unit_id"]),
                    Conv.ToInt(r["PCC_Id"]),
                    Conv.Flag(r["IsActive"]),
                }).ToList();

            await Upsert.RunAsync(pg, "lab_user",
                ["noble_id", "username", "first_name", "last_name", "email", "phone",
                 "employee_id", "usertype_id", "business_unit_id", "centre_noble_id",
                 "is_active"],
                vals, ct);

            await using var fk = new NpgsqlCommand("""
                UPDATE stellar.lab_user u
                SET centre_id = c.id
                FROM stellar.centre c
                WHERE c.noble_id = u.centre_noble_id
                  AND u.centre_id IS DISTINCT FROM c.id
                """, pg);
            await fk.ExecuteNonQueryAsync(ct);
        },
        Delete = (pg, ids, ct) => Upsert.DeleteAsync(pg, "lab_user", ids, ct),
    };

    // ---- referrers -----------------------------------------------------------
    // Two Noble tables with identical column lists fold into one stellar table
    // discriminated by `kind`, so the conflict target is (kind, noble_id) and
    // the generic Upsert (which keys on noble_id alone) cannot be used.
    public static TableSync Doctor => Referrer("tbl_med_mcc_doctors", "doctor", "doctor_code", "doctor_name");
    public static TableSync Customer => Referrer("tbl_med_mcc_customer", "customer", "customer_code", "customer_name");

    private static TableSync Referrer(string table, string kind, string codeCol, string nameCol) => new()
    {
        NobleTable = table,
        KeyColumns = ["id"],
        SelectList = $"""
            t.id, t.{codeCol} AS code, t.{nameCol} AS name, t.address, t.area,
            t.city, t.stateid, t.country, t.zip, t.phone, t.email,
            t.contact_person, t.pcc_code, t.IsActive
            """,
        Apply = async (pg, rows, ct) =>
        {
            foreach (var r in rows)
            {
                await using var cmd = new NpgsqlCommand("""
                    INSERT INTO stellar.referrer
                        (kind, noble_id, code, name, address, area, city, state_id,
                         country, zip, phone, email, contact_person, centre_id, is_active)
                    VALUES (@kind::stellar.referrer_kind, @nid, @code, @name, @addr, @area,
                            @city, @state, @country, @zip, @phone, @email, @contact,
                            (SELECT id FROM stellar.centre WHERE noble_id = @pcc), @active)
                    ON CONFLICT (kind, noble_id) WHERE noble_id IS NOT NULL
                    DO UPDATE SET
                        code = EXCLUDED.code, name = EXCLUDED.name,
                        address = EXCLUDED.address, area = EXCLUDED.area,
                        city = EXCLUDED.city, state_id = EXCLUDED.state_id,
                        country = EXCLUDED.country, zip = EXCLUDED.zip,
                        phone = EXCLUDED.phone, email = EXCLUDED.email,
                        contact_person = EXCLUDED.contact_person,
                        centre_id = EXCLUDED.centre_id, is_active = EXCLUDED.is_active,
                        updated_at = now()
                    """, pg);
                cmd.Parameters.AddWithValue("@kind", kind);
                cmd.Parameters.AddWithValue("@nid", (object?)Conv.ToInt(r["id"]) ?? DBNull.Value);
                cmd.Parameters.AddWithValue("@code", (object?)Conv.Text(r["code"]) ?? DBNull.Value);
                cmd.Parameters.AddWithValue("@name", (object?)Conv.Text(r["name"]) ?? "(unnamed)");
                cmd.Parameters.AddWithValue("@addr", (object?)Conv.Text(r["address"]) ?? DBNull.Value);
                cmd.Parameters.AddWithValue("@area", (object?)Conv.Text(r["area"]) ?? DBNull.Value);
                cmd.Parameters.AddWithValue("@city", (object?)Conv.Text(r["city"]) ?? DBNull.Value);
                cmd.Parameters.AddWithValue("@state", (object?)Conv.ToInt(r["stateid"]) ?? DBNull.Value);
                cmd.Parameters.AddWithValue("@country", (object?)Conv.Text(r["country"]) ?? DBNull.Value);
                cmd.Parameters.AddWithValue("@zip", (object?)Conv.Text(r["zip"]) ?? DBNull.Value);
                cmd.Parameters.AddWithValue("@phone", (object?)Conv.Text(r["phone"]) ?? DBNull.Value);
                cmd.Parameters.AddWithValue("@email", (object?)Conv.Text(r["email"]) ?? DBNull.Value);
                cmd.Parameters.AddWithValue("@contact", (object?)Conv.Text(r["contact_person"]) ?? DBNull.Value);
                cmd.Parameters.AddWithValue("@pcc", (object?)Conv.ToInt(r["pcc_code"]) ?? DBNull.Value);
                cmd.Parameters.AddWithValue("@active", Conv.Flag(r["IsActive"]));
                await cmd.ExecuteNonQueryAsync(ct);
            }
        },
        Delete = async (pg, ids, ct) =>
        {
            if (ids.Count == 0) return;
            await using var cmd = new NpgsqlCommand(
                "DELETE FROM stellar.referrer WHERE kind = @kind::stellar.referrer_kind AND noble_id = ANY(@ids)", pg);
            cmd.Parameters.AddWithValue("@kind", kind);
            cmd.Parameters.AddWithValue("@ids", ids.ToArray());
            await cmd.ExecuteNonQueryAsync(ct);
        },
    };
}
