using System.Data;
using Infinity.Api.Data;
using Infinity.Api.Domain;
using Infinity.Api.Reads;
using Microsoft.Data.SqlClient;

namespace Infinity.Api.Worksheet;

/// <summary>
/// Reads for the result-entry screen.
///
/// One procedure call returns the sample header, its analyte rows with live
/// reference ranges, and the auto-authorization rules in force — three result
/// sets over one connection. The legacy screen issues four database round-trips
/// PER GRID ROW inside RowDataBound (GetEditPatientInfo four times, plus
/// GetTestAuthenticate and GetTestHasGraph), which on a twenty-analyte panel is
/// well over a hundred queries to paint one page.
/// </summary>
public sealed class WorksheetRepository(NobleConnectionFactory db, SqlRetry retry)
{
    public async Task<WorksheetSample?> GetSampleAsync(
        IReadOnlyList<string> clientCodes, string sid, CancellationToken ct = default)
    {
        return await retry.ExecuteAsync("worksheet.sample", token =>
            db.QueryAsync("worksheet.sample", async (conn, inner) =>
            {
                await using var cmd = db.CreateWriteCommand(conn, "dbo.usp_inf_worksheet_sample");
                cmd.Parameters.Add("@sid", SqlDbType.NVarChar, 50).Value = sid.Trim();
                AddClientCodes(cmd, clientCodes);

                await using var reader = await cmd.ExecuteReaderAsync(inner).ConfigureAwait(false);

                // ---- 1. header ----
                if (!await reader.ReadAsync(inner).ConfigureAwait(false)) return null;

                var header = new WorksheetSampleHeader(
                    Sid: reader.Str("sid") ?? sid,
                    Pid: reader.Int("pid"),
                    PatientName: reader.Str("patient_name"),
                    Sex: reader.Str("sex"),
                    Age: reader.NullableInt("age"),
                    AgeUnit: reader.Str("age_unit"),
                    ClientCode: reader.Str("client_code"),
                    ShortName: reader.Str("short_name"),
                    OrderNumber: reader.Str("order_number"),
                    BillNumber: reader.Str("bill_number"),
                    SampleDrawn: NobleTime.ToIst(reader.Date("sample_drawn")),
                    RegisteredAt: NobleTime.ToIst(reader.Date("registered_at")),
                    LastModifiedAt: NobleTime.ToIst(reader.Date("last_modified_at")),
                    StatusCode: reader.NullableInt("status_code"),
                    Status: reader.Str("status"),
                    SampleComments: reader.Str("sample_comments"),
                    SampleClinicalHistory: reader.Str("sample_clinical_history"),
                    PatientClinicalHistory: reader.Str("patient_clinical_history"),
                    RejectComments: reader.Str("reject_comments"),
                    AuthorisedBy: reader.NullableInt("authorised_by"),
                    AuthorisedByUsername: reader.Str("authorised_by_username"),
                    SignatureId: reader.NullableInt("signature_id"),
                    SignatoryName: reader.Str("signatory_name"),
                    SignatoryDesignation: reader.Str("signatory_designation"),
                    IsEditable: reader.Bit("is_editable"),
                    NeedsReopen: reader.Bit("needs_reopen"),
                    IsRejected: reader.Bit("is_rejected"),
                    // StrOpt, not Str: these four are new in the same change as
                    // the procedure that returns them, and the API image and the
                    // SQL deploy separately. Str would throw for the whole
                    // worksheet in the window where the old procedure is still
                    // in the database.
                    Title: reader.StrOpt("title"),
                    ReferringDoctor: reader.StrOpt("ref_doctor"),
                    ReferringCustomer: reader.StrOpt("ref_customer"),
                    SampleType: reader.StrOpt("sample_type"));

                // ---- 2. analyte rows ----
                var rows = new List<WorksheetResultRow>();
                if (await reader.NextResultAsync(inner).ConfigureAwait(false))
                {
                    while (await reader.ReadAsync(inner).ConfigureAwait(false))
                    {
                        rows.Add(new WorksheetResultRow(
                            ResultId: reader.Int("result_id"),
                            TestId: reader.NullableInt("testid"),
                            ParamId: reader.NullableInt("paramid"),
                            TestCode: reader.Str("testcode"),
                            TestName: reader.Str("testname"),
                            TestType: reader.Str("testtype"),
                            Value: reader.Str("value"),
                            Unit: reader.Str("unit"),
                            NormalRange: reader.Str("normal_range"),
                            RangeLow: reader.NullableDec("range_low"),
                            RangeHigh: reader.NullableDec("range_high"),
                            Abnormal: reader.Bit("abnormal"),
                            Authorized: reader.Bit("authorized"),
                            Comments: reader.Str("comments"),
                            ProfileId: reader.NullableInt("profile_id"),
                            MasterProfileId: reader.NullableInt("master_profile_id"),
                            MachineName: reader.Str("machine_name"),
                            EnteredBy: reader.Str("addedby"),
                            EnteredAt: NobleTime.ToIst(reader.Date("addeddate")),
                            UpdatedBy: reader.Str("updatedby"),
                            UpdatedAt: NobleTime.ToIst(reader.Date("updateddate")),
                            HasAttachment: reader.Bit("has_attachment"),
                            DepartmentCode: reader.Str("department_code"),
                            DepartmentName: reader.Str("department_name"),
                            DepartmentId: reader.NullableInt("department_id"),
                            CodedOptions: SplitCodedOptions(reader.Str("coded_options")),
                            IsNumericRange: reader.Bit("is_numeric_range"),
                            AutoAuthEligible: false));   // filled in below
                    }
                }

                // ---- 3. auto-authorization rules ----
                var rules = new List<AutoAuthRuleInForce>();
                if (await reader.NextResultAsync(inner).ConfigureAwait(false))
                {
                    while (await reader.ReadAsync(inner).ConfigureAwait(false))
                    {
                        rules.Add(new AutoAuthRuleInForce(
                            ScopeType: reader.Str("scope_type") ?? "",
                            ScopeKey: reader.Str("scope_key") ?? "",
                            ScopeLabel: reader.Str("scope_label"),
                            RequireInRange: reader.Bit("require_in_range"),
                            AllowOutOfRange: reader.Bit("allow_out_of_range"),
                            NumericOnly: reader.Bit("numeric_only")));
                    }
                }

                return new WorksheetSample(header, MarkAutoAuthEligible(rows, rules), rules);
            }, token), ct).ConfigureAwait(false);
    }

    /// <summary>The sample's audit history, newest first, paged in full.</summary>
    public Task<Paged<ResultAuditRow>> GetAuditAsync(
        string sid, int page, int pageSize, CancellationToken ct = default) =>
        retry.ExecuteAsync("worksheet.audit", token =>
            db.QueryAsync("worksheet.audit", async (conn, inner) =>
            {
                var (p, size) = Paged<ResultAuditRow>.Clamp(page, pageSize, 200);

                await using var cmd = db.CreateWriteCommand(conn, "dbo.usp_inf_result_audit_read");
                cmd.Parameters.Add("@sid", SqlDbType.NVarChar, 50).Value = sid.Trim();
                cmd.Parameters.Add("@page", SqlDbType.Int).Value = p;
                cmd.Parameters.Add("@page_size", SqlDbType.Int).Value = size;

                await using var reader = await cmd.ExecuteReaderAsync(CommandBehavior.SingleResult, inner)
                    .ConfigureAwait(false);

                var list = new List<ResultAuditRow>();
                var total = 0;
                while (await reader.ReadAsync(inner).ConfigureAwait(false))
                {
                    if (list.Count == 0) total = reader.NullableInt("total_count") ?? 0;

                    list.Add(new ResultAuditRow(
                        Id: reader.Long("id"),
                        ResultId: reader.NullableInt("result_id"),
                        TestName: reader.Str("testname"),
                        TestCode: reader.Str("testcode"),
                        Action: reader.Str("action") ?? "",
                        Field: reader.Str("field"),
                        OldValue: reader.Str("old_value"),
                        NewValue: reader.Str("new_value"),
                        Reason: reader.Str("reason"),
                        ActorUsername: reader.Str("actor_username"),
                        ActorIp: reader.Str("actor_ip"),
                        Source: reader.Str("source") ?? "ui",
                        OccurredAt: reader.Offset("occurred_at") ?? default));
                }

                return new Paged<ResultAuditRow>(list, total, p, size);
            }, token), ct);

    /// <summary>
    /// Flag the rows a configured rule would sign automatically, so the screen
    /// can say so BEFORE the technologist saves. The legacy "Check" button
    /// auto-ticks authorization with no indication that it has done so, which is
    /// how in-range results came to be released without anyone deciding to.
    ///
    /// This mirrors the resolution order in usp_inf_result_save — test beats
    /// profile beats department — but it is display only. The procedure decides.
    /// </summary>
    private static IReadOnlyList<WorksheetResultRow> MarkAutoAuthEligible(
        List<WorksheetResultRow> rows, List<AutoAuthRuleInForce> rules)
    {
        if (rules.Count == 0) return rows;

        for (var i = 0; i < rows.Count; i++)
        {
            var r = rows[i];
            if (r.TestType is not ("Test" or "Param")) continue;

            var rule = rules.FirstOrDefault(x => Matches(x, r));
            if (rule is null) continue;

            // A row with no numeric bounds can never satisfy an in-range rule.
            var eligible = !rule.NumericOnly || r.IsNumericRange;
            if (eligible) rows[i] = r with { AutoAuthEligible = true };
        }

        return rows;
    }

    private static bool Matches(AutoAuthRuleInForce rule, WorksheetResultRow row) => rule.ScopeType switch
    {
        "test" => string.Equals(rule.ScopeKey, row.TestCode, StringComparison.OrdinalIgnoreCase),
        "profile" => int.TryParse(rule.ScopeKey, out var p) && (p == row.ProfileId || p == row.MasterProfileId),
        "department" => int.TryParse(rule.ScopeKey, out var d) && d == row.DepartmentId,
        _ => false,
    };

    /// <summary>
    /// Coded-result options, comma separated. Noble carries them in a
    /// VARCHAR(12) column named mobile_number, so anything past twelve
    /// characters was already truncated in the database — splitting here cannot
    /// recover it, and the UI falls back to a free-text box when the list looks
    /// unusable.
    /// </summary>
    private static IReadOnlyList<string> SplitCodedOptions(string? raw) =>
        string.IsNullOrWhiteSpace(raw)
            ? []
            : raw.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

    internal static void AddClientCodes(SqlCommand cmd, IReadOnlyList<string> clientCodes)
    {
        var tvp = new DataTable();
        tvp.Columns.Add("code", typeof(string));
        foreach (var c in clientCodes.Where(c => !string.IsNullOrWhiteSpace(c))
                                     .Select(c => c.Trim().ToUpperInvariant())
                                     .Distinct(StringComparer.Ordinal))
        {
            tvp.Rows.Add(c);
        }

        var p = cmd.Parameters.AddWithValue("@client_codes", tvp);
        p.SqlDbType = SqlDbType.Structured;
        p.TypeName = "dbo.ClientCodeList";
    }
}

/// <summary>
/// Readers the worksheet needs that the shared set does not carry.
/// Kept internal to this namespace so they cannot collide with
/// <see cref="SqlReaderExtensions"/> at a call site that has both in scope.
/// </summary>
internal static class WorksheetReaderExtensions
{
    public static bool Bit(this SqlDataReader r, string column)
    {
        var i = r.GetOrdinal(column);
        if (r.IsDBNull(i)) return false;
        var v = r.GetValue(i);
        return v switch
        {
            bool b => b,
            int n => n != 0,
            byte b => b != 0,
            short s => s != 0,
            _ => false,
        };
    }

    public static long Long(this SqlDataReader r, string column)
    {
        var i = r.GetOrdinal(column);
        return r.IsDBNull(i) ? 0L : Convert.ToInt64(r.GetValue(i));
    }

    public static decimal? NullableDec(this SqlDataReader r, string column)
    {
        var i = r.GetOrdinal(column);
        return r.IsDBNull(i) ? null : Convert.ToDecimal(r.GetValue(i));
    }

    /// <summary>
    /// Reads a DATETIMEOFFSET. The audit columns are genuinely offset-aware —
    /// unlike Noble's legacy datetimes, which are IST wall-clock with no zone
    /// and must go through NobleTime.ToIst instead.
    /// </summary>
    public static DateTimeOffset? Offset(this SqlDataReader r, string column)
    {
        var i = r.GetOrdinal(column);
        if (r.IsDBNull(i)) return null;
        var v = r.GetValue(i);
        return v switch
        {
            DateTimeOffset dto => dto,
            DateTime dt => NobleTime.ToIst(dt),
            _ => null,
        };
    }
}
