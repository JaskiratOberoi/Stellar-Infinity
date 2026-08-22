using System.Data;
using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;
using Infinity.Api.Data;
using Infinity.Api.Domain;
using Microsoft.Data.SqlClient;

namespace Infinity.Api.Reads;

/// <summary>One analyte inside a worksheet row's results array.</summary>
public sealed record TestResult(
    [property: JsonPropertyName("resultId")] int ResultId,
    [property: JsonPropertyName("testCode")] string? TestCode,
    [property: JsonPropertyName("testName")] string? TestName,
    [property: JsonPropertyName("testType")] string? TestType,
    [property: JsonPropertyName("value")] string? Value,
    [property: JsonPropertyName("unit")] string? Unit,
    [property: JsonPropertyName("normalRange")] string? NormalRange,
    [property: JsonPropertyName("abnormal")] bool Abnormal,
    [property: JsonPropertyName("authorized")] bool Authorized,
    [property: JsonPropertyName("comments")] string? Comments,
    [property: JsonPropertyName("departmentName")] string? DepartmentName,
    /// <summary>
    /// The catalogue's display name, for a row that carries none of its own.
    /// It is the TEST's name, shared by every row under that test, so it must
    /// not be printed in preference to <see cref="TestName"/>.
    /// </summary>
    [property: JsonPropertyName("reportTestName")] string? ReportTestName = null,
    /// <summary>How it was measured — CLIA, ELISA. A printed report names its method.</summary>
    [property: JsonPropertyName("method")] string? Method = null,
    /// <summary>Clinical significance, from the catalogue. Printed under the test.</summary>
    [property: JsonPropertyName("interpretation")] string? Interpretation = null,
    /// <summary>
    /// The profile this row belongs to, when it belongs to one. The real parent
    /// link — nesting was previously inferred from row order, which is right
    /// only while a profile's rows stay contiguous.
    /// </summary>
    [property: JsonPropertyName("profileId")] int? ProfileId = null,
    /// <summary>The tube it came from, e.g. "WB - EDTA".</summary>
    [property: JsonPropertyName("specimen")] string? Specimen = null,
    /// <summary>
    /// The catalogue row this result was measured against.
    ///
    /// Not display data. It is what the report's structure is rebuilt from: a
    /// multi-parameter test emits an untitled "report name" Head immediately
    /// before the real coded Head its Param rows hang off, and the only thing
    /// saying those two rows are one test is this id. It is also the key for
    /// the age-banded reference range and for the interpretation image.
    /// </summary>
    [property: JsonPropertyName("testId")] int? TestId = null,
    /// <summary>
    /// An interpretation held as a picture — the HBV and HCV graphs — inlined
    /// as a data URI. Some tests carry ONLY this and no interpretation text.
    /// </summary>
    [property: JsonPropertyName("interpretationImage")] string? InterpretationImage = null);

public sealed record WorksheetRow(
    string Sid,
    string? ClientCode,
    string? BusinessUnit,
    int Pid,
    string? PatientName,
    string? Sex,
    int? Age,
    string? AgeUnit,
    DateTimeOffset? SampleDrawn,
    DateTimeOffset? RegisteredAt,
    DateTimeOffset? LastModifiedAt,
    int? StatusCode,
    string? Status,
    string? TestNames,
    string? OrderNumber,
    string? BillNumber,
    string? ClinicalHistory,
    IReadOnlyList<TestResult> Results,
    // Report-only, and therefore defaulted: the worklist procedure does not
    // return these and its call site is unchanged. Only GetBySidAsync fills
    // them, because only a printed report has a place to put them.
    /// <summary>Referring doctor — the master row's name, else the typed one.</summary>
    string? RefDoctor = null,
    /// <summary>Referring customer — the master row's name, else the typed one.</summary>
    string? RefCustomer = null,
    /// <summary>Passport / travel ID, absent when the LIS backfilled it with the patient id.</summary>
    string? PassportNo = null,
    /// <summary>
    /// Date of birth, from Infinity's sidecar (the LIS keeps none). Null for a
    /// patient booked before the order form began storing it.
    /// </summary>
    DateOnly? Dob = null,
    /// <summary>Specimen, e.g. "WB - EDTA". List rows only.</summary>
    string? SampleType = null,
    /// <summary>1 EDTA · 2 fluoride · 3 serum · 4 urine · 5 the rest. List rows only.</summary>
    int? SpecimenRank = null);

public sealed record WorksheetPage(IReadOnlyList<WorksheetRow> Rows, int Count);

/// <summary>
/// A page of the worklist together with the size of the whole filtered set.
/// </summary>
/// <param name="Total">
/// Rows matching the filters, NOT rows in this page. Everything the client
/// needs to show "51-100 of 3,412" and to offer a last-page jump. A client that
/// has to infer "is there more?" from a full page gets it wrong whenever the
/// total is an exact multiple of the page size.
/// </param>
/// <summary>
/// The worklist filters beyond name/SID/status/dates — the rest of what the
/// legacy LIS worksheet offers. Every one narrows the result set; none can
/// reach outside the caller's client-code scope.
/// </summary>
/// <param name="ClientCode">
/// One centre. Applied IN ADDITION to the scope, so naming a code the user was
/// not granted matches nothing rather than granting access to it.
/// </param>
public sealed record WorksheetFilters(
    int? FromHour = null,
    int? ToHour = null,
    int? Pid = null,
    string? ClientCode = null,
    int? DepartmentId = null,
    int? BusinessUnitId = null,
    string? TestCode = null)
{
    public static readonly WorksheetFilters None = new();
}

/// <summary>Option lists for the worklist's dropdowns.</summary>
public sealed record LookupItem(int Id, string? Name);
/// <param name="IsActive">
/// A deactivated client can still be filtered on (it has history) but cannot
/// take a new order — the create procedure refuses it. Order entry hides them;
/// the worklist does not.
/// </param>
public sealed record ClientCodeItem(int Id, string Code, string? Name, bool IsActive);
/// <param name="Name">
/// The test's own name, so the filter can be searched by what the test is
/// called and not only by a code the operator would have to know already.
/// </param>
public sealed record TestItem(string Code, string? Name);
public sealed record WorksheetFilterOptions(
    IReadOnlyList<LookupItem> Departments,
    IReadOnlyList<LookupItem> BusinessUnits,
    IReadOnlyList<ClientCodeItem> ClientCodes,
    IReadOnlyList<TestItem> Tests);

/// <param name="AsOf">
/// The instant this page describes. Echoed back by the client on every later
/// page so that paging walks one fixed set — see 76_usp_inf_worksheet_list.sql
/// for what happens on a live LIS without it.
/// </param>
public sealed record WorksheetListPage(
    IReadOnlyList<WorksheetRow> Rows,
    int Total,
    int Page,
    int PageSize,
    DateTimeOffset AsOf)
{
    public int PageCount => PageSize > 0 ? (Total + PageSize - 1) / PageSize : 0;
}

/// <summary>
/// The LIS worksheet — one row per sample, with its results.
///
/// Infinity calls <c>dbo.usp_listec_worksheet_report_by_codes</c> DIRECTLY over
/// its own pool, rather than going through Telo's Listec HTTP service the way
/// Telo does. Same procedure, same rows, but no dependency on another stack's
/// container and one less network hop. Listec also has no authentication, so
/// not reaching for it keeps that surface out of Infinity entirely.
///
/// The by_codes variant (TVP of exact client codes) is used in preference to
/// the single <c>@client_code</c> LIKE variant, because report scope is a SET.
/// Telo issues one execution per client code; that does not survive an admin
/// with thousands of them.
/// </summary>
public sealed class ReportsRepository(NobleConnectionFactory db, SqlRetry retry)
{
    private static readonly JsonSerializerOptions ResultsJson = new()
    {
        PropertyNameCaseInsensitive = true,
    };

    /// <summary>
    /// Worksheet rows for the caller's report scope.
    /// </summary>
    /// <param name="clientCodes">
    /// Exact client codes. An EMPTY list means "every code" — that is how the
    /// procedure treats an empty TVP, and it is what we want for an admin whose
    /// scope is unrestricted. Callers must therefore never pass an empty list
    /// to mean "this user can see nothing"; the endpoint short-circuits that
    /// case before reaching here.
    /// </param>
    public async Task<WorksheetPage> ListAsync(
        IReadOnlyList<string> clientCodes,
        string fromDate,
        string toDate,
        string? patientName,
        string? sid,
        int? statusId,
        bool includeUnauthorized,
        int page,
        int pageSize,
        bool includeResults,
        CancellationToken ct = default)
    {
        var size = Math.Clamp(pageSize, 1, 200);

        return await retry.ExecuteAsync("reports.worksheet", token =>
            db.QueryAsync("reports.worksheet", async (conn, inner) =>
            {
                await using var cmd = db.CreateWriteCommand(conn, "dbo.usp_listec_worksheet_report_by_codes");
                // Not a write — but the worksheet scans a wide date range and
                // legitimately outruns the short read timeout on a busy server.

                var tvp = new DataTable();
                tvp.Columns.Add("code", typeof(string));
                foreach (var c in clientCodes.Where(c => !string.IsNullOrWhiteSpace(c))
                                             .Select(c => c.Trim().ToUpperInvariant())
                                             .Distinct(StringComparer.Ordinal))
                {
                    tvp.Rows.Add(c);
                }

                var codesParam = cmd.Parameters.AddWithValue("@client_codes", tvp);
                codesParam.SqlDbType = SqlDbType.Structured;
                codesParam.TypeName = "dbo.ClientCodeList";

                cmd.Parameters.Add("@from_date", SqlDbType.Date).Value = ParseDate(fromDate);
                cmd.Parameters.Add("@to_date", SqlDbType.Date).Value = ParseDate(toDate);
                cmd.Parameters.Add("@patient_name", SqlDbType.NVarChar, 400).Value =
                    string.IsNullOrWhiteSpace(patientName) ? DBNull.Value : patientName.Trim();
                cmd.Parameters.Add("@sid", SqlDbType.NVarChar, 100).Value =
                    string.IsNullOrWhiteSpace(sid) ? DBNull.Value : sid.Trim();
                cmd.Parameters.Add("@status_id", SqlDbType.Int).Value = (object?)statusId ?? DBNull.Value;
                cmd.Parameters.Add("@include_unauthorized", SqlDbType.Bit).Value = includeUnauthorized;
                cmd.Parameters.Add("@page", SqlDbType.Int).Value = Math.Max(page, 1);
                cmd.Parameters.Add("@page_size", SqlDbType.Int).Value = size;

                await using var reader = await cmd.ExecuteReaderAsync(CommandBehavior.SingleResult, inner)
                    .ConfigureAwait(false);

                var rows = new List<WorksheetRow>();
                while (await reader.ReadAsync(inner).ConfigureAwait(false))
                {
                    // results_json is ~1.5 KB per row. The list view never shows
                    // it, so dropping it there keeps a 200-row page from being a
                    // 300 KB response.
                    var results = includeResults
                        ? ParseResults(reader.Str("results_json"))
                        : [];

                    rows.Add(new WorksheetRow(
                        Sid: reader.Str("sid") ?? "",
                        ClientCode: reader.Str("client_code"),
                        BusinessUnit: reader.Str("business_unit"),
                        Pid: reader.Int("pid"),
                        PatientName: reader.Str("patient_name"),
                        Sex: reader.Str("sex"),
                        Age: reader.NullableInt("age"),
                        AgeUnit: reader.Str("age_unit"),
                        SampleDrawn: NobleTime.ToIst(reader.Date("sample_drawn")),
                        RegisteredAt: NobleTime.ToIst(reader.Date("regd_at")),
                        LastModifiedAt: NobleTime.ToIst(reader.Date("last_modified_at")),
                        StatusCode: reader.NullableInt("status_code"),
                        Status: reader.Str("status"),
                        TestNames: reader.Str("test_names_csv"),
                        OrderNumber: reader.Str("order_number"),
                        BillNumber: reader.Str("bill_number"),
                        ClinicalHistory: reader.Str("clinical_history"),
                        Results: results));
                }

                return new WorksheetPage(rows, rows.Count);
            }, token), ct).ConfigureAwait(false);
    }

    /// <summary>
    /// A page of the worklist, with every filter applied in SQL and the size of
    /// the whole filtered set returned alongside.
    ///
    /// Calls Infinity's own <c>dbo.usp_inf_worksheet_list</c> rather than the
    /// legacy procedure. See 76_usp_inf_worksheet_list.sql: the legacy one takes
    /// a single status, returns no total, and orders by a non-unique key, all
    /// three of which make a paged worklist under-report what exists.
    /// </summary>
    /// <param name="statusIds">
    /// Statuses to include. Empty or null means every status. This is what lets
    /// the "pending only" view be a real filter instead of the client hiding
    /// rows it has already been given.
    /// </param>
    /// <param name="filters">
    /// The rest of the legacy worksheet's filter set. Every field narrows;
    /// none can widen what <paramref name="clientCodes"/> already allows.
    /// </param>
    public async Task<WorksheetListPage> ListPageAsync(
        IReadOnlyList<string> clientCodes,
        string fromDate,
        string toDate,
        string? patientName,
        string? sid,
        IReadOnlyList<int>? statusIds,
        WorksheetFilters filters,
        int page,
        int pageSize,
        DateTime? asOf,
        CancellationToken ct = default)
    {
        var size = Math.Clamp(pageSize, 1, 1000);
        var pageNo = Math.Max(page, 1);

        // Resolved HERE rather than left to the procedure's default, so that a
        // page with no rows still reports the snapshot it used. Reading it off a
        // returned column works only when a column comes back.
        //
        // Truncated to the second, and that is not cosmetic. SQL Server's
        // DATETIME has ~3.33 ms granularity, so a full-precision .NET instant
        // sent as a parameter is ROUNDED on arrival — while the value handed
        // back to the client keeps its sub-second part. Echoing that slightly
        // different instant on the next page moved the boundary by a couple of
        // milliseconds and let a newly registered sample into a set that was
        // supposed to be frozen: the total drifted by one between two requests
        // that were meant to be identical. Truncating DOWN makes the value the
        // client echoes exactly the value the query used.
        var snapshot = TruncateToSecond(asOf ?? NobleTime.NowForNoble());

        return await retry.ExecuteAsync("reports.worklist", token =>
            db.QueryAsync("reports.worklist", async (conn, inner) =>
            {
                await using var cmd = db.CreateWriteCommand(conn, "dbo.usp_inf_worksheet_list");
                // Not a write — but the worklist scans a date range on a live
                // server and legitimately outruns the short read timeout.

                var tvp = new DataTable();
                tvp.Columns.Add("code", typeof(string));
                foreach (var c in clientCodes.Where(c => !string.IsNullOrWhiteSpace(c))
                                             .Select(c => c.Trim().ToUpperInvariant())
                                             .Distinct(StringComparer.Ordinal))
                {
                    tvp.Rows.Add(c);
                }

                var codesParam = cmd.Parameters.AddWithValue("@client_codes", tvp);
                codesParam.SqlDbType = SqlDbType.Structured;
                codesParam.TypeName = "dbo.ClientCodeList";

                cmd.Parameters.Add("@from_date", SqlDbType.Date).Value = ParseDate(fromDate);
                cmd.Parameters.Add("@to_date", SqlDbType.Date).Value = ParseDate(toDate);
                cmd.Parameters.Add("@patient_name", SqlDbType.NVarChar, 200).Value =
                    string.IsNullOrWhiteSpace(patientName) ? DBNull.Value : patientName.Trim();
                cmd.Parameters.Add("@sid", SqlDbType.NVarChar, 50).Value =
                    string.IsNullOrWhiteSpace(sid) ? DBNull.Value : sid.Trim();
                cmd.Parameters.Add("@status_ids", SqlDbType.VarChar, 200).Value =
                    statusIds is { Count: > 0 }
                        ? string.Join(',', statusIds.Distinct())
                        : (object)DBNull.Value;
                // Hours are clamped rather than rejected: an out-of-range hour
                // is a malformed request, and the sane reading of one is the
                // full day, never an empty worklist.
                cmd.Parameters.Add("@from_hour", SqlDbType.TinyInt).Value =
                    (byte)Math.Clamp(filters.FromHour ?? 0, 0, 24);
                cmd.Parameters.Add("@to_hour", SqlDbType.TinyInt).Value =
                    (byte)Math.Clamp(filters.ToHour ?? 24, 0, 24);
                cmd.Parameters.Add("@pid", SqlDbType.Int).Value =
                    (object?)filters.Pid ?? DBNull.Value;
                cmd.Parameters.Add("@client_code", SqlDbType.NVarChar, 50).Value =
                    string.IsNullOrWhiteSpace(filters.ClientCode)
                        ? DBNull.Value : filters.ClientCode.Trim().ToUpperInvariant();
                cmd.Parameters.Add("@department_id", SqlDbType.Int).Value =
                    (object?)filters.DepartmentId ?? DBNull.Value;
                cmd.Parameters.Add("@business_unit_id", SqlDbType.Int).Value =
                    (object?)filters.BusinessUnitId ?? DBNull.Value;
                cmd.Parameters.Add("@test_code", SqlDbType.NVarChar, 50).Value =
                    string.IsNullOrWhiteSpace(filters.TestCode)
                        ? DBNull.Value : filters.TestCode.Trim();

                cmd.Parameters.Add("@page", SqlDbType.Int).Value = pageNo;
                cmd.Parameters.Add("@page_size", SqlDbType.Int).Value = size;
                cmd.Parameters.Add("@as_of", SqlDbType.DateTime).Value = snapshot;

                await using var reader = await cmd.ExecuteReaderAsync(CommandBehavior.SingleResult, inner)
                    .ConfigureAwait(false);

                var rows = new List<WorksheetRow>();
                var total = 0;

                while (await reader.ReadAsync(inner).ConfigureAwait(false))
                {
                    // COUNT(*) OVER() repeats on every row; reading it once is
                    // enough, and a page with no rows leaves it at zero, which
                    // is the right answer for "nothing matched".
                    if (rows.Count == 0) total = reader.NullableInt("total_count") ?? 0;

                    rows.Add(new WorksheetRow(
                        Sid: reader.Str("sid") ?? "",
                        ClientCode: reader.Str("client_code"),
                        BusinessUnit: reader.Str("business_unit"),
                        Pid: reader.Int("pid"),
                        PatientName: reader.Str("patient_name"),
                        Sex: reader.Str("sex"),
                        Age: reader.NullableInt("age"),
                        AgeUnit: reader.Str("age_unit"),
                        SampleDrawn: NobleTime.ToIst(reader.Date("sample_drawn")),
                        RegisteredAt: NobleTime.ToIst(reader.Date("regd_at")),
                        LastModifiedAt: NobleTime.ToIst(reader.Date("last_modified_at")),
                        StatusCode: reader.NullableInt("status_code"),
                        Status: reader.Str("status"),
                        TestNames: reader.Str("test_names_csv"),
                        OrderNumber: reader.Str("order_number"),
                        BillNumber: reader.Str("bill_number"),
                        ClinicalHistory: reader.Str("clinical_history"),
                        // The list never renders results, and the procedure does
                        // not fetch them: that per-row FOR JSON subquery was the
                        // reason large pages were expensive.
                        Results: [],
                        // Tolerant on purpose: these two columns arrive with a
                        // procedure redeploy, and the API must not 500 against
                        // the old procedure in the window between the two.
                        SampleType: TryStr(reader, "sample_type"),
                        SpecimenRank: TryInt(reader, "specimen_rank")));
                }

                return new WorksheetListPage(rows, total, pageNo, size, NobleTime.ToIst(snapshot));
            }, token), ct).ConfigureAwait(false);
    }

    /// <summary>
    /// Drop sub-second precision so a DATETIME round trip is lossless.
    /// Truncates rather than rounds: the snapshot may only ever move earlier,
    /// never later, or echoing it could widen the window it was meant to pin.
    /// </summary>
    private static DateTime TruncateToSecond(DateTime t) =>
        new(t.Ticks - (t.Ticks % TimeSpan.TicksPerSecond), t.Kind);

    /// <summary>
    /// The option lists behind the worklist's dropdowns, in one round trip.
    ///
    /// The client-code list is scoped to what the caller may already see: the
    /// roster of centres is the lab's customer list, and a user restricted to
    /// two of them has no business being handed a dropdown naming all of them.
    /// Departments and business units are reference data and are not scoped.
    /// </summary>
    public async Task<WorksheetFilterOptions> GetFilterOptionsAsync(
        IReadOnlyList<string> clientCodes, CancellationToken ct = default)
    {
        return await retry.ExecuteAsync("reports.filters", token =>
            db.QueryAsync("reports.filters", async (conn, inner) =>
            {
                await using var cmd = db.CreateWriteCommand(conn, "dbo.usp_inf_worksheet_filters");

                var tvp = new DataTable();
                tvp.Columns.Add("code", typeof(string));
                foreach (var c in clientCodes.Where(c => !string.IsNullOrWhiteSpace(c))
                                             .Select(c => c.Trim().ToUpperInvariant())
                                             .Distinct(StringComparer.Ordinal))
                {
                    tvp.Rows.Add(c);
                }

                var codesParam = cmd.Parameters.AddWithValue("@client_codes", tvp);
                codesParam.SqlDbType = SqlDbType.Structured;
                codesParam.TypeName = "dbo.ClientCodeList";

                await using var r = await cmd.ExecuteReaderAsync(inner).ConfigureAwait(false);

                var departments = new List<LookupItem>();
                while (await r.ReadAsync(inner).ConfigureAwait(false))
                    departments.Add(new LookupItem(r.Int("id"), r.Str("name")));

                var units = new List<LookupItem>();
                if (await r.NextResultAsync(inner).ConfigureAwait(false))
                {
                    while (await r.ReadAsync(inner).ConfigureAwait(false))
                        units.Add(new LookupItem(r.Int("id"), r.Str("name")));
                }

                var codes = new List<ClientCodeItem>();
                if (await r.NextResultAsync(inner).ConfigureAwait(false))
                {
                    while (await r.ReadAsync(inner).ConfigureAwait(false))
                        codes.Add(new ClientCodeItem(
                            r.Int("id"), r.Str("code") ?? "", r.Str("name"),
                            // Convert.ToInt32 handles the BIT; a dedicated Bit()
                            // helper lives in the Worksheet namespace and
                            // importing it here would invert the dependency.
                            (r.NullableInt("is_active") ?? 0) == 1));
                }

                var tests = new List<TestItem>();
                if (await r.NextResultAsync(inner).ConfigureAwait(false))
                {
                    while (await r.ReadAsync(inner).ConfigureAwait(false))
                        tests.Add(new TestItem(r.Str("code") ?? "", r.Str("name")));
                }

                return new WorksheetFilterOptions(departments, units, codes, tests);
            }, token), ct).ConfigureAwait(false);
    }

    /// <summary>
    /// One SID with its full results. Scope is enforced by the caller passing
    /// the user's client codes — the procedure filters on them, so an
    /// out-of-scope SID simply returns no rows.
    /// </summary>
    /// <summary>
    /// One report, by exact SID.
    /// </summary>
    /// <remarks>
    /// <para>
    /// This used to call <see cref="ListAsync"/> — the paged SEARCH — over a
    /// window of <c>2015-01-01</c> to tomorrow, because that procedure demands a
    /// date range and a SID lookup should not depend on the operator guessing
    /// when the sample was drawn. Opening one report therefore swept a decade of
    /// samples, and the search procedure matches a SID with
    /// <c>vailid LIKE '%…%'</c>, which cannot seek. Measured at a flat 13–14
    /// seconds per open in the API's own db.slow log.
    /// </para>
    /// <para>
    /// The LIKE is right where it lives: it powers the worksheet's SID search,
    /// where typing "9388" must find 09388225 — and that procedure is shared
    /// with Telo, so it is not Infinity's to narrow. The mistake was using a
    /// search to do a lookup. <c>usp_inf_report_by_sid</c> is the lookup: an
    /// equality predicate on a unique key, no date window, same projection.
    /// </para>
    /// </remarks>
    public async Task<WorksheetRow?> GetBySidAsync(
        IReadOnlyList<string> clientCodes, string sid, CancellationToken ct = default)
    {
        var target = (sid ?? string.Empty).Trim();
        if (target.Length == 0) return null;

        return await retry.ExecuteAsync("reports.bySid", token =>
            db.QueryAsync("reports.bySid", async (conn, inner) =>
            {
                await using var cmd = db.CreateWriteCommand(conn, "dbo.usp_inf_report_by_sid");

                var tvp = new DataTable();
                tvp.Columns.Add("code", typeof(string));
                foreach (var c in clientCodes.Where(c => !string.IsNullOrWhiteSpace(c))
                                             .Select(c => c.Trim().ToUpperInvariant())
                                             .Distinct(StringComparer.Ordinal))
                {
                    tvp.Rows.Add(c);
                }

                var codesParam = cmd.Parameters.AddWithValue("@client_codes", tvp);
                codesParam.SqlDbType = SqlDbType.Structured;
                codesParam.TypeName = "dbo.ClientCodeList";

                cmd.Parameters.Add("@sid", SqlDbType.NVarChar, 100).Value = target;
                cmd.Parameters.Add("@include_unauthorized", SqlDbType.Bit).Value = true;

                await using var reader = await cmd.ExecuteReaderAsync(CommandBehavior.SingleResult, inner)
                    .ConfigureAwait(false);

                if (!await reader.ReadAsync(inner).ConfigureAwait(false)) return null;

                return new WorksheetRow(
                    Sid: reader.Str("sid") ?? "",
                    ClientCode: reader.Str("client_code"),
                    BusinessUnit: reader.Str("business_unit"),
                    Pid: reader.Int("pid"),
                    PatientName: reader.Str("patient_name"),
                    Sex: reader.Str("sex"),
                    Age: reader.NullableInt("age"),
                    AgeUnit: reader.Str("age_unit"),
                    SampleDrawn: NobleTime.ToIst(reader.Date("sample_drawn")),
                    RegisteredAt: NobleTime.ToIst(reader.Date("regd_at")),
                    LastModifiedAt: NobleTime.ToIst(reader.Date("last_modified_at")),
                    StatusCode: reader.NullableInt("status_code"),
                    Status: reader.Str("status"),
                    TestNames: reader.Str("test_names_csv"),
                    OrderNumber: reader.Str("order_number"),
                    BillNumber: reader.Str("bill_number"),
                    ClinicalHistory: reader.Str("clinical_history"),
                    Results: ParseResults(reader.Str("results_json")),
                    RefDoctor: reader.Str("ref_doctor"),
                    RefCustomer: reader.Str("ref_customer"),
                    PassportNo: reader.Str("passport_no"),
                    Dob: reader.Date("date_of_birth") is DateTime dob ? DateOnly.FromDateTime(dob) : null);
            }, token), ct).ConfigureAwait(false);
    }

    /// <summary>
    /// Put a set of SIDs into the order the LIS prints them in.
    /// </summary>
    /// <remarks>
    /// <para>
    /// A merged report has to come out in the LIS's sequence, because the same
    /// patient's reports are read side by side with the ones the LIS produced.
    /// GET_PATIENT_REPORT_PAT_ID — the procedure behind the LIS's own complete
    /// report — ends in <c>ORDER BY tbl_med_mcc_patient_test_result.id asc</c>,
    /// so the LIS orders a patient's whole report by the identity of the RESULT
    /// ROWS: oldest work first, regardless of when a sample was registered.
    /// </para>
    /// <para>
    /// A sample is therefore placed by its EARLIEST result id, which is where
    /// that sample's block begins in the LIS's own listing. Ordering by
    /// registration time instead is close but not the same — a sample
    /// registered later can be resulted first — and the reporting list is
    /// newest-first, which is the reverse of what the LIS prints.
    /// </para>
    /// <para>
    /// A SID with no results yet has no place in that sequence; those keep
    /// their given order and follow at the end rather than being dropped.
    /// </para>
    /// </remarks>
    public async Task<IReadOnlyList<string>> OrderAsLisAsync(
        IReadOnlyList<string> sids, CancellationToken ct = default)
    {
        if (sids.Count <= 1) return sids;

        var seq = await retry.ExecuteAsync("reports.lisOrder", token =>
            db.QueryAsync("reports.lisOrder", async (conn, inner) =>
            {
                var names = string.Join(",", sids.Select((_, i) => "@s" + i.ToString(System.Globalization.CultureInfo.InvariantCulture)));
                await using var cmd = NobleConnectionFactory.CreateCommand(conn, $"""
                    SELECT r.vailid,
                           seq = MIN(r.id),
                           pat = MIN(s.patient_id),
                           spec = MIN(CASE
                               WHEN UPPER(SM.Sampletype) LIKE '%EDTA%' THEN 1
                               WHEN UPPER(SM.Sampletype) LIKE '%NAF%'
                                 OR UPPER(SM.Sampletype) LIKE '%FLUORIDE%'
                                 OR UPPER(SM.Sampletype) LIKE '%FLOURIDE%' THEN 2
                               WHEN UPPER(SM.Sampletype) LIKE '%SERUM%' THEN 3
                               WHEN UPPER(SM.Sampletype) LIKE '%URINE%' THEN 4
                               ELSE 5
                           END)
                    FROM dbo.tbl_med_mcc_patient_test_result r
                    LEFT JOIN dbo.tbl_med_mcc_patient_samples s ON s.vailid = r.vailid
                    LEFT JOIN dbo.tbl_med_sample_master SM ON SM.id = s.sampleid
                    WHERE r.vailid IN ({names})
                    GROUP BY r.vailid;
                    """);
                for (var i = 0; i < sids.Count; i++)
                {
                    cmd.Parameters.Add("@s" + i.ToString(System.Globalization.CultureInfo.InvariantCulture),
                                       SqlDbType.NVarChar, 50).Value = sids[i];
                }

                var map = new Dictionary<string, (long Seq, long Pat, int Spec)>(StringComparer.OrdinalIgnoreCase);
                await using var r = await cmd.ExecuteReaderAsync(inner).ConfigureAwait(false);
                while (await r.ReadAsync(inner).ConfigureAwait(false))
                {
                    var v = r.Str("vailid");
                    if (v is null || await r.IsDBNullAsync(1, inner).ConfigureAwait(false)) continue;
                    map[v.Trim()] = (
                        Convert.ToInt64(r.GetValue(1)),
                        r.NullableInt("pat") ?? long.MaxValue,
                        r.NullableInt("spec") ?? 5);
                }
                return map;
            }, token), ct).ConfigureAwait(false);

        /*
         * Patients stay contiguous (a multi-patient batch must not interleave
         * every EDTA tube first), and WITHIN a patient the tubes walk the
         * bench's order — EDTA, fluoride, serum, urine, the rest — with the
         * LIS result sequence breaking ties, exactly as it ordered everything
         * before specimen rank existed. A patient's place in the batch is
         * their earliest sequence, so the batch as a whole still reads
         * chronologically. Anything with no results follows behind.
         */
        var patientFirst = seq.Values
            .GroupBy(v => v.Pat)
            .ToDictionary(g => g.Key, g => g.Min(v => v.Seq));

        return sids
            .Select((sid, i) => (sid, i, has: seq.TryGetValue(sid.Trim(), out var v), v))
            .OrderBy(x => x.has ? 0 : 1)
            .ThenBy(x => x.has ? patientFirst[x.v.Pat] : x.i)
            .ThenBy(x => x.has ? x.v.Spec : 0)
            .ThenBy(x => x.has ? x.v.Seq : x.i)
            .Select(x => x.sid)
            .ToList();
    }

    /// <summary>A column that may not exist yet — null instead of a throw.</summary>
    private static string? TryStr(System.Data.Common.DbDataReader r, string name)
    {
        try { var v = r[name]; return v is DBNull ? null : ((string)v).Trim(); }
        catch (IndexOutOfRangeException) { return null; }
    }

    private static int? TryInt(System.Data.Common.DbDataReader r, string name)
    {
        try { var v = r[name]; return v is DBNull ? null : Convert.ToInt32(v); }
        catch (IndexOutOfRangeException) { return null; }
    }

    private static IReadOnlyList<TestResult> ParseResults(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return [];

        try
        {
            using var doc = JsonDocument.Parse(json);
            var list = new List<TestResult>();

            foreach (var el in doc.RootElement.EnumerateArray())
            {
                list.Add(new TestResult(
                    ResultId: GetInt(el, "result_id"),
                    TestCode: GetString(el, "test_code"),
                    TestName: GetString(el, "test_name"),
                    TestType: GetString(el, "test_type"),
                    Value: GetString(el, "value"),
                    Unit: GetString(el, "unit"),
                    NormalRange: GetString(el, "normal_range"),
                    Abnormal: GetBool(el, "abnormal"),
                    Authorized: GetBool(el, "authorized"),
                    Comments: GetString(el, "comments"),
                    DepartmentName: GetString(el, "department_name"),
                    ReportTestName: GetString(el, "report_test_name"),
                    Method: GetString(el, "method"),
                    Interpretation: GetString(el, "interpretation"),
                    ProfileId: GetNullableInt(el, "profile_id"),
                    Specimen: GetString(el, "specimen"),
                    TestId: GetNullableInt(el, "test_id")));
            }

            // Restore DOCUMENT order.
            //
            // usp_listec_worksheet_report_by_codes sorts by testtype first
            // (Head, then Profile, then Test, then everything else), which
            // hoists every section heading to the top of the array and leaves
            // the analytes in one undifferentiated run below them — so a CBC
            // rendered as "Complete Blood Count / Automated 5 Part Analyzer /
            // Differential Counts %" stacked at the top, followed by forty
            // unlabelled values.
            //
            // result_id ascending IS the report's true order: the LIS creates
            // these rows in reading order (WorksheetClass.GetTestsBySampleId
            // writes each heading immediately before the analytes it
            // introduces), so the identity column preserves it exactly.
            //
            // Sorted here rather than by changing the procedure because that
            // procedure is shared with Telo, and a presentation fix should not
            // be a migration against an object another system reads.
            list.Sort((a, b) => a.ResultId.CompareTo(b.ResultId));

            return list;
        }
        catch (JsonException)
        {
            // A malformed payload for one sample must not fail the whole page.
            // Telo's Listec client makes the same call (returns [] on parse
            // failure) rather than propagating.
            return [];
        }
    }

    private static string? GetString(JsonElement e, string name) =>
        e.TryGetProperty(name, out var v) && v.ValueKind is not JsonValueKind.Null ? v.ToString() : null;

    private static int GetInt(JsonElement e, string name) =>
        e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetInt32() : 0;

    /// <summary>
    /// Absent and zero are different here: profile_id 0 is "not in a profile"
    /// in the legacy data just as null is, and both must read as no parent
    /// rather than as profile number zero.
    /// </summary>
    private static int? GetNullableInt(JsonElement e, string name) =>
        e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number && v.GetInt32() > 0
            ? v.GetInt32() : null;

    private static bool GetBool(JsonElement e, string name) =>
        e.TryGetProperty(name, out var v) && v.ValueKind switch
        {
            JsonValueKind.True => true,
            JsonValueKind.Number => v.GetInt32() != 0,
            _ => false,
        };

    private static DateTime ParseDate(string s) =>
        DateTime.TryParseExact(s, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var d)
            ? d
            : DateTime.UtcNow.Date;
}
