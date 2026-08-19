using System.Data;
using Infinity.Api.Data;
using Infinity.Api.Reads;

namespace Infinity.Api.Reports;

/// <summary>
/// Who is entitled to a Smart Report.
/// </summary>
/// <remarks>
/// <para>
/// The Smart Report is a PAID extra, not a view of a report anyone can ask for.
/// It is sold as a custom test — <c>SMART-RPT</c>, ₹99, offered network-wide —
/// and a patient is entitled to one only where their order actually included
/// it. The record of that purchase is <c>dbo.telo_custom_test_order</c>, keyed
/// on the LIS patient id.
/// </para>
/// <para>
/// Read-only, and deliberately Telo's table rather than a copy: Telo sells the
/// same test against the same LIS, and a second ledger of who bought what is
/// two answers to one question — a patient who paid in Telo would be refused in
/// Infinity, or worse, the reverse. Ported from Telo's db/read/customTests.ts
/// (pidsWithSmartReport / sidHasSmartReport).
/// </para>
/// <para>
/// Two shapes, for the two places the question gets asked: in bulk for the
/// reporting LIST (one indexed query for a page of rows, so the button can be
/// drawn only where it means something), and singly for the routes that SERVE
/// the thing. The hidden button is a courtesy; the per-SID check is the
/// enforcement, because a hidden control is a suggestion and a URL is not.
/// </para>
/// </remarks>
public sealed class SmartReportAccessRepository(NobleConnectionFactory db, SqlRetry retry)
{
    /// <summary>The custom-test code the Smart Report is sold under.</summary>
    public const string SmartReportCode = "SMART-RPT";

    /// <summary>
    /// A page of the reporting list can be a hundred rows; asking per row would
    /// be a hundred round trips to decide whether to draw a button. Capped so a
    /// pathological page cannot build an unbounded IN list.
    /// </summary>
    private const int MaxPids = 1000;

    /// <summary>
    /// Of these patient ids, the ones whose order included the Smart Report.
    /// </summary>
    public async Task<HashSet<int>> PidsWithSmartReportAsync(
        IReadOnlyCollection<int> pids, CancellationToken ct = default)
    {
        var ids = pids.Where(p => p > 0).Distinct().Take(MaxPids).ToArray();
        if (ids.Length == 0) return [];

        return await retry.ExecuteAsync("reports.smartPids", token =>
            db.QueryAsync("reports.smartPids", async (conn, inner) =>
            {
                var list = string.Join(",", ids.Select((_, i) => "@p" + i.ToString(System.Globalization.CultureInfo.InvariantCulture)));
                await using var cmd = NobleConnectionFactory.CreateCommand(conn, $"""
                    SELECT DISTINCT patient_id
                    FROM dbo.telo_custom_test_order
                    WHERE code = @code AND patient_id IN ({list});
                    """);
                cmd.Parameters.Add("@code", SqlDbType.NVarChar, 50).Value = SmartReportCode;
                for (var i = 0; i < ids.Length; i++)
                    cmd.Parameters.Add("@p" + i.ToString(System.Globalization.CultureInfo.InvariantCulture), SqlDbType.Int).Value = ids[i];

                var found = new HashSet<int>();
                await using var r = await cmd.ExecuteReaderAsync(inner).ConfigureAwait(false);
                while (await r.ReadAsync(inner).ConfigureAwait(false))
                {
                    if (r.NullableInt("patient_id") is int pid) found.Add(pid);
                }
                return found;
            }, token), ct).ConfigureAwait(false);
    }

    /// <summary>
    /// Did the patient behind this SID buy the Smart Report? The gate on every
    /// route that serves one.
    /// </summary>
    public async Task<bool> SidHasSmartReportAsync(string sid, CancellationToken ct = default)
    {
        var target = (sid ?? string.Empty).Trim();
        if (target.Length == 0) return false;

        return await retry.ExecuteAsync("reports.smartSid", token =>
            db.QueryAsync("reports.smartSid", async (conn, inner) =>
            {
                await using var cmd = NobleConnectionFactory.CreateCommand(conn, """
                    SELECT TOP 1 1
                    FROM dbo.tbl_med_mcc_patient_samples s
                    JOIN dbo.telo_custom_test_order o ON o.patient_id = s.patient_id
                    WHERE s.vailid = @sid AND o.code = @code;
                    """);
                cmd.Parameters.Add("@sid", SqlDbType.NVarChar, 50).Value = target;
                cmd.Parameters.Add("@code", SqlDbType.NVarChar, 50).Value = SmartReportCode;

                var hit = await cmd.ExecuteScalarAsync(inner).ConfigureAwait(false);
                return hit is not null and not DBNull;
            }, token), ct).ConfigureAwait(false);
    }
}
