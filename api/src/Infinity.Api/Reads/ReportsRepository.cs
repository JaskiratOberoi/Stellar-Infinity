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
    [property: JsonPropertyName("departmentName")] string? DepartmentName);

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
    IReadOnlyList<TestResult> Results);

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
    public async Task<WorksheetListPage> ListPageAsync(
        IReadOnlyList<string> clientCodes,
        string fromDate,
        string toDate,
        string? patientName,
        string? sid,
        IReadOnlyList<int>? statusIds,
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
        var snapshot = asOf ?? NobleTime.NowForNoble();

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
                        Results: []));
                }

                return new WorksheetListPage(rows, total, pageNo, size, NobleTime.ToIst(snapshot));
            }, token), ct).ConfigureAwait(false);
    }

    /// <summary>
    /// One SID with its full results. Scope is enforced by the caller passing
    /// the user's client codes — the procedure filters on them, so an
    /// out-of-scope SID simply returns no rows.
    /// </summary>
    public async Task<WorksheetRow?> GetBySidAsync(
        IReadOnlyList<string> clientCodes, string sid, CancellationToken ct = default)
    {
        // The procedure requires a date window. A SID lookup should not depend
        // on the operator guessing when the sample was drawn, so search wide.
        var page = await ListAsync(
            clientCodes,
            fromDate: "2015-01-01",
            toDate: DateTimeOffset.UtcNow.ToOffset(NobleTime.IstOffset).AddDays(1).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
            patientName: null,
            sid: sid,
            statusId: null,
            includeUnauthorized: true,
            page: 1,
            pageSize: 5,
            includeResults: true,
            ct).ConfigureAwait(false);

        return page.Rows.FirstOrDefault(r => string.Equals(r.Sid, sid.Trim(), StringComparison.OrdinalIgnoreCase))
               ?? page.Rows.FirstOrDefault();
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
                    DepartmentName: GetString(el, "department_name")));
            }

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
