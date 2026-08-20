using System.Data;
using Infinity.Api.Data;
using Infinity.Api.Reads;

namespace Infinity.Api.Orders;

/// <summary>One itemised sale line — a billable test, as the LIS counts them.</summary>
public sealed record SaleLine(
    /// <summary>Patient registration id (LIS regdno) — shown as PID.</summary>
    int RegdNo,
    string? PatientName,
    /// <summary>
    /// The sample (vailid) this test belongs to. The LIS has no test→sample FK;
    /// a sample carries a comma-delimited testcodes list, so this is the sample
    /// whose list contains the test's code. Null when not yet accessioned.
    /// </summary>
    string? Sid,
    string? SampleDate,
    int? Age,
    /// <summary>1 years, 2 months, 3 days.</summary>
    int? AgeType,
    /// <summary>1 male, 2 female.</summary>
    int? Gender,
    string? TestCode,
    string? TestName,
    decimal Amount,
    string? Doctor,
    string? Customer);

public sealed record SalesTotals(int SampleCount, decimal SaleAmount, int LineCount);

public sealed record SalesPage(
    IReadOnlyList<SaleLine> Rows, bool HasMore, int Page, int PageSize, SalesTotals Totals,
    /// <summary>Who this is — carried so a deep-linked page can title itself.</summary>
    string? ClientCode, string? ClientName);

/// <summary>
/// The Sales Data screen's numbers for one client — itemised billable test
/// lines and the header totals.
/// </summary>
/// <remarks>
/// <para>
/// A PORT OF TELO'S db/read/salesData.ts, queries kept line for line. Both
/// products show this screen against the same LIS and the definitions must not
/// drift: a "sale line" is a billable test
/// (<c>tbl_med_mcc_patient_tests.amount_checked = 1</c>) dated by the test's
/// <c>updateddate</c>; the sample count is distinct samples with
/// <c>sample_status &gt; 1</c> keyed by <c>modifieddate</c>. Those mirror the
/// LIS's own Sales/SalesDataforMcc.aspx (usp_sales_data_for_mcc101's List
/// branch and the sp_get_samples_count / sp_get_samples_amount totals), which
/// is what the lab reconciles against.
/// </para>
/// <para>
/// Fetches pageSize + 1 rows to detect a next page without a COUNT — the same
/// trade Telo makes; the true line count still arrives once via the totals.
/// Scope is the CALLER's responsibility, as with the ledger beside it.
/// </para>
/// </remarks>
public sealed class SalesRepository(NobleConnectionFactory db, SqlRetry retry)
{
    private const int MaxPageSize = 200;

    private const string ListSql = """
        SELECT
          p.id AS regdNo,
          p.name AS patientName,
          (SELECT TOP 1 s.vailid
             FROM dbo.tbl_med_mcc_patient_samples s
            WHERE s.patient_id = t.patient_id
              AND ',' + REPLACE(ISNULL(s.testcodes, ''), ' ', '') + ','
                  LIKE '%,' + t.test_code + ',%'
            ORDER BY s.id) AS sid,
          CONVERT(varchar(10), p.sample_date, 23) AS sampleDate,
          p.age AS age,
          p.age_type AS ageType,
          p.gender AS gender,
          t.test_code AS testCode,
          t.test_name AS testName,
          t.test_rate AS amount,
          COALESCE(doc.doctor_name, p.ref_doctor_other) AS doctor,
          COALESCE(cus.customer_name, p.ref_customer_other) AS customer
        FROM dbo.tbl_med_mcc_patient_tests t
        JOIN dbo.tbl_med_mcc_patient_master p ON p.id = t.patient_id
        LEFT JOIN dbo.tbl_med_mcc_doctors  doc ON doc.id = p.ref_doctor
        LEFT JOIN dbo.tbl_med_mcc_customer cus ON cus.id = p.ref_customer
        WHERE p.mcc_code = @mcc
          AND t.amount_checked = 1
          AND t.updateddate >= CAST(@from AS DATE)
          AND t.updateddate <  DATEADD(day, 1, CAST(@to AS DATE))
        ORDER BY t.updateddate DESC, p.id, t.test_code
        OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY;
        """;

    private const string TotalsSql = """
        SELECT
          (SELECT COUNT(DISTINCT s.vailid)
             FROM dbo.tbl_med_mcc_patient_samples s
             JOIN dbo.tbl_med_mcc_patient_master p ON p.id = s.patient_id
            WHERE p.mcc_code = @mcc
              AND s.sample_status > 1
              AND s.modifieddate >= CAST(@from AS DATE)
              AND s.modifieddate <  DATEADD(day, 1, CAST(@to AS DATE))) AS sampleCount,
          (SELECT SUM(t.test_rate)
             FROM dbo.tbl_med_mcc_patient_tests t
             JOIN dbo.tbl_med_mcc_patient_master p ON p.id = t.patient_id
            WHERE p.mcc_code = @mcc
              AND t.amount_checked = 1
              AND t.updateddate >= CAST(@from AS DATE)
              AND t.updateddate <  DATEADD(day, 1, CAST(@to AS DATE))) AS saleAmount,
          (SELECT COUNT(*)
             FROM dbo.tbl_med_mcc_patient_tests t
             JOIN dbo.tbl_med_mcc_patient_master p ON p.id = t.patient_id
            WHERE p.mcc_code = @mcc
              AND t.amount_checked = 1
              AND t.updateddate >= CAST(@from AS DATE)
              AND t.updateddate <  DATEADD(day, 1, CAST(@to AS DATE))) AS lineCount;

        SELECT code = LTRIM(RTRIM(MCCUnitCode)), name = LTRIM(RTRIM(MCCUnitName))
        FROM dbo.tbl_med_mcc_unit_master WHERE id = @mcc;
        """;

    /// <summary>Lines + totals for one client in an IST-calendar-day window.</summary>
    public async Task<SalesPage> GetAsync(
        int mcc, string from, string to, int page, int pageSize, CancellationToken ct = default)
    {
        var p = Math.Max(1, page);
        var size = Math.Max(1, Math.Min(pageSize, MaxPageSize));

        return await retry.ExecuteAsync("accounts.sales", token =>
            db.QueryAsync("accounts.sales", async (conn, inner) =>
            {
                // One batch, two result sets — the screen always shows both.
                await using var cmd = NobleConnectionFactory.CreateCommand(conn, ListSql + "\n" + TotalsSql);
                cmd.Parameters.Add("@mcc", SqlDbType.Int).Value = mcc;
                cmd.Parameters.Add("@from", SqlDbType.VarChar, 10).Value = from;
                cmd.Parameters.Add("@to", SqlDbType.VarChar, 10).Value = to;
                cmd.Parameters.Add("@offset", SqlDbType.Int).Value = (p - 1) * size;
                cmd.Parameters.Add("@limit", SqlDbType.Int).Value = size + 1;

                var rows = new List<SaleLine>();
                await using var r = await cmd.ExecuteReaderAsync(inner).ConfigureAwait(false);
                while (await r.ReadAsync(inner).ConfigureAwait(false))
                {
                    rows.Add(new SaleLine(
                        RegdNo: r.Int("regdNo"),
                        PatientName: r.Str("patientName"),
                        Sid: r.Str("sid"),
                        SampleDate: r.Str("sampleDate"),
                        Age: r.NullableInt("age"),
                        AgeType: r.NullableInt("ageType"),
                        Gender: r.NullableInt("gender"),
                        TestCode: r.Str("testCode"),
                        TestName: r.Str("testName"),
                        Amount: r.Dec("amount"),
                        Doctor: r.Str("doctor"),
                        Customer: r.Str("customer")));
                }

                var totals = new SalesTotals(0, 0m, 0);
                if (await r.NextResultAsync(inner).ConfigureAwait(false)
                    && await r.ReadAsync(inner).ConfigureAwait(false))
                {
                    totals = new SalesTotals(
                        SampleCount: r.NullableInt("sampleCount") ?? 0,
                        SaleAmount: r.Dec("saleAmount"),
                        LineCount: r.NullableInt("lineCount") ?? 0);
                }

                string? code = null, name = null;
                if (await r.NextResultAsync(inner).ConfigureAwait(false)
                    && await r.ReadAsync(inner).ConfigureAwait(false))
                {
                    code = r.Str("code");
                    name = r.Str("name");
                }

                var hasMore = rows.Count > size;
                if (hasMore) rows.RemoveAt(rows.Count - 1);
                return new SalesPage(rows, hasMore, p, size, totals, code, name);
            }, token), ct).ConfigureAwait(false);
    }
}
