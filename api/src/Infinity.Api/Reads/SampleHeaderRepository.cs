using System.Data;
using Infinity.Api.Data;
using Infinity.Api.Domain;
using Microsoft.Data.SqlClient;

namespace Infinity.Api.Reads;

/// <summary>
/// First read module, ported from Telo's db/read/sampleHeader.ts.
///
/// Why an exact-match query matters: the equivalent question used to be
/// answered through the Listec worksheet procedure, whose SID filter is a
/// leading-wildcard <c>vailid LIKE '%sid%'</c> — unindexable — and which builds
/// a JSON payload of every result row for every matched sample. Callers handed
/// it a decade-wide date window, so opening one report preview ran several full
/// scans of the samples table. This answers the same question with a single
/// indexed equality predicate and no JSON work.
///
/// The <c>sample_status &gt; 1</c> predicate mirrors the worksheet procedure's
/// visibility rule (a merely-registered sample is not reportable). Keep it, so
/// swapping data sources never changes which samples are visible.
/// </summary>
public sealed class SampleHeaderRepository(NobleConnectionFactory db, SqlRetry retry)
{
    /// <summary>Defensive cap — a SID should be unique, but Noble has no constraint saying so.</summary>
    private const int MaxRows = 5;

    private const string Sql = """
        SELECT TOP (@top)
            S.vailid                    AS sid,
            P.id                        AS pid,
            P.name                      AS patient_name,
            CASE P.gender WHEN 1 THEN 'Male' ELSE 'Female' END AS sex,
            P.age                       AS age,
            CASE P.age_type
                WHEN 1 THEN 'Year(s)'
                WHEN 2 THEN 'Month(s)'
                WHEN 3 THEN 'Day(s)'
                ELSE 'Unknown'
            END                         AS age_unit,
            U.MCCUnitCode               AS client_code,
            BU.BusinessUnitCode         AS business_unit,
            P.sample_time               AS sample_drawn,
            S.modifieddate              AS regd_at,
            S.lastmodified_date         AS last_modified_at,
            STAT.status                 AS status,
            P.bill_number               AS bill_number,
            S.Sample_ClinicalHistory    AS clinical_history
        FROM dbo.tbl_med_mcc_patient_samples S
        INNER JOIN dbo.tbl_med_mcc_patient_master P
            ON S.patient_id = P.id
        INNER JOIN dbo.tbl_med_mcc_unit_master U
            ON P.mcc_code = U.id
        LEFT JOIN dbo.tbl_med_business_unit_master BU
            ON BU.id = S.business_unit_id
        LEFT JOIN dbo.tbl_med_mcc_patient_samples_status_master STAT
            ON STAT.id = S.sample_status
        WHERE S.vailid = @sid
          AND S.sample_status > 1
        ORDER BY S.modifieddate DESC
        """;

    /// <summary>
    /// Every reportable sample row for an exact SID (normally one).
    /// Unlike Telo, dates are returned as real <see cref="DateTimeOffset"/>
    /// values carrying +05:30 rather than IST wall-clock stamped 'Z'. The driver
    /// hands back Unspecified DateTimes untouched, so no CONVERT-to-string
    /// workaround is needed and the encoding never depends on container TZ.
    /// </summary>
    public Task<IReadOnlyList<SampleHeader>> GetAllAsync(string sid, CancellationToken ct = default)
    {
        var target = (sid ?? "").Trim();
        if (target.Length == 0) return Task.FromResult<IReadOnlyList<SampleHeader>>([]);

        return retry.ExecuteAsync("sampleHeader.getAll", token =>
            db.QueryAsync("sampleHeader.getAll", async (conn, inner) =>
            {
                await using var cmd = NobleConnectionFactory.CreateCommand(conn, Sql);
                cmd.Parameters.Add("@sid", SqlDbType.NVarChar, 50).Value = target;
                cmd.Parameters.Add("@top", SqlDbType.Int).Value = MaxRows;

                // Deliberately NOT SequentialAccess: it would force every future
                // edit to this mapping to preserve strict column order, for no
                // measurable gain on a 14-column row.
                await using var reader = await cmd.ExecuteReaderAsync(
                    CommandBehavior.SingleResult, inner).ConfigureAwait(false);

                var rows = new List<SampleHeader>(1);
                while (await reader.ReadAsync(inner).ConfigureAwait(false))
                {
                    rows.Add(Map(reader));
                }

                return (IReadOnlyList<SampleHeader>)rows;
            }, token), ct);
    }

    /// <summary>The single header for a SID (newest if it ever duplicated), or null.</summary>
    public async Task<SampleHeader?> GetAsync(string sid, CancellationToken ct = default)
    {
        var rows = await GetAllAsync(sid, ct).ConfigureAwait(false);
        return rows.Count > 0 ? rows[0] : null;
    }

    /// <summary>
    /// Ordinal-based mapping — no reflection, no column-name lookups per row.
    /// Ordinals are read once and must stay in step with the SELECT list above.
    /// </summary>
    private static SampleHeader Map(SqlDataReader r) => new(
        Sid: r.GetString(0),
        Pid: r.GetInt64Flexible(1),
        PatientName: r.GetStringOrNull(2),
        Sex: r.GetStringOrNull(3),
        Age: r.GetInt32OrNull(4),
        AgeUnit: r.GetStringOrNull(5),
        ClientCode: r.GetStringOrNull(6),
        BusinessUnit: r.GetStringOrNull(7),
        SampleDrawn: NobleTime.ToIst(r.GetDateTimeOrNull(8)),
        RegisteredAt: NobleTime.ToIst(r.GetDateTimeOrNull(9)),
        LastModifiedAt: NobleTime.ToIst(r.GetDateTimeOrNull(10)),
        Status: r.GetStringOrNull(11),
        BillNumber: r.GetStringOrNull(12),
        ClinicalHistory: r.GetStringOrNull(13));
}

/// <summary>
/// Null-tolerant readers. Noble's legacy columns are inconsistently typed and
/// widely nullable — an id may be int or bigint, an "age" may arrive as a
/// string — so read defensively rather than trusting the schema.
/// </summary>
internal static class SqlDataReaderExtensions
{
    public static string? GetStringOrNull(this SqlDataReader r, int i) =>
        r.IsDBNull(i) ? null : r.GetValue(i)?.ToString();

    public static DateTime? GetDateTimeOrNull(this SqlDataReader r, int i) =>
        r.IsDBNull(i) ? null : r.GetDateTime(i);

    public static int? GetInt32OrNull(this SqlDataReader r, int i)
    {
        if (r.IsDBNull(i)) return null;
        var v = r.GetValue(i);
        return v switch
        {
            int n => n,
            short s => s,
            byte b => b,
            long l => (int)l,
            decimal d => (int)d,
            string s when int.TryParse(s, out var p) => p,
            _ => null,
        };
    }

    public static long GetInt64Flexible(this SqlDataReader r, int i)
    {
        var v = r.GetValue(i);
        return v switch
        {
            long l => l,
            int n => n,
            short s => s,
            byte b => b,
            decimal d => (long)d,
            string s when long.TryParse(s, out var p) => p,
            _ => 0L,
        };
    }
}
