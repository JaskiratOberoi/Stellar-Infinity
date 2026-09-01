using System.Data;
using Infinity.Api.Data;

namespace Infinity.Api.Reports;

/// <summary>
/// The per-sample clinical-history PDF a collection centre attaches AFTER the
/// order exists — the port of the LIS's Sample Status upload
/// (Pcc/SampleStatus.aspx), stored where the lab tech's worksheet already
/// looks (Worksheet/clihis.ashx: filene = SID, filetype = 'HISTORY' in
/// dbo.tbl_med_mcc_patient_clinicaldata). Writing to the same keying means
/// the LIS worksheet shows an Infinity upload with no LIS change at all.
///
/// Every predicate here keys filene = @sid AND filetype = 'HISTORY' exactly —
/// the same table stores report QR codes with the two columns swapped
/// (quirk #27), and a widened match would serve or delete those.
/// </summary>
public sealed class ClinicalHistoryRepository(NobleConnectionFactory db, SqlRetry retry)
{
    /// <summary>Which of these SIDs carry an attached history PDF.</summary>
    public async Task<HashSet<string>> ExistsManyAsync(
        IReadOnlyList<string> sids, CancellationToken ct = default)
    {
        var found = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        if (sids.Count == 0) return found;

        return await retry.ExecuteAsync("reports.clihis.flags", token =>
            db.QueryAsync("reports.clihis.flags", async (conn, inner) =>
            {
                var list = string.Join(",", sids.Select((_, i) => "@s" + i.ToString(System.Globalization.CultureInfo.InvariantCulture)));
                var sql = $"""
                    SELECT DISTINCT filene
                    FROM dbo.tbl_med_mcc_patient_clinicaldata
                    WHERE filetype = 'HISTORY' AND filene IN ({list});
                    """;
                await using var cmd = NobleConnectionFactory.CreateCommand(conn, sql);
                for (var i = 0; i < sids.Count; i++)
                    cmd.Parameters.Add("@s" + i.ToString(System.Globalization.CultureInfo.InvariantCulture), SqlDbType.NVarChar, 50).Value = sids[i];
                await using var r = await cmd.ExecuteReaderAsync(inner).ConfigureAwait(false);
                while (await r.ReadAsync(inner).ConfigureAwait(false))
                {
                    if (!await r.IsDBNullAsync(0, inner).ConfigureAwait(false))
                        found.Add(r.GetString(0).Trim());
                }
                return found;
            }, token), ct).ConfigureAwait(false);
    }

    /// <summary>The PDF bytes, or null when the sample carries none.</summary>
    public async Task<byte[]?> GetAsync(string sid, CancellationToken ct = default)
    {
        return await retry.ExecuteAsync("reports.clihis.get", token =>
            db.QueryAsync("reports.clihis.get", async (conn, inner) =>
            {
                const string sql = """
                    SELECT TOP 1 binary_data
                    FROM dbo.tbl_med_mcc_patient_clinicaldata
                    WHERE filene = @sid AND filetype = 'HISTORY'
                    ORDER BY id DESC;
                    """;
                await using var cmd = NobleConnectionFactory.CreateCommand(conn, sql);
                cmd.Parameters.Add("@sid", SqlDbType.NVarChar, 50).Value = sid;
                var v = await cmd.ExecuteScalarAsync(inner).ConfigureAwait(false);
                return v is byte[] { Length: > 0 } bytes ? bytes : null;
            }, token), ct).ConfigureAwait(false);
    }

    /// <summary>Attach or replace. False when the SID names no sample.</summary>
    public async Task<(bool Ok, string? Error)> SetAsync(
        string sid, byte[] pdf, int actor, CancellationToken ct = default)
    {
        return await db.QueryAsync("reports.clihis.set", async (conn, inner) =>
        {
            await using var cmd = db.CreateWriteCommand(conn, "dbo.usp_inf_clinical_history_set");
            cmd.Parameters.Add("@sid", SqlDbType.NVarChar, 50).Value = sid;
            cmd.Parameters.Add("@pdf", SqlDbType.VarBinary, -1).Value = pdf;
            cmd.Parameters.Add("@actor", SqlDbType.Int).Value = actor;
            await using var r = await cmd.ExecuteReaderAsync(inner).ConfigureAwait(false);
            if (!await r.ReadAsync(inner).ConfigureAwait(false)) return (false, "No response.");
            var ok = r.GetBoolean(r.GetOrdinal("ok"));
            var err = await r.IsDBNullAsync(r.GetOrdinal("error"), inner).ConfigureAwait(false)
                ? null : r.GetString(r.GetOrdinal("error"));
            return (ok, err);
        }, ct).ConfigureAwait(false);
    }

    /// <summary>Remove. True regardless of whether a file was there.</summary>
    public async Task<bool> DeleteAsync(string sid, int actor, CancellationToken ct = default)
    {
        return await db.QueryAsync("reports.clihis.delete", async (conn, inner) =>
        {
            await using var cmd = db.CreateWriteCommand(conn, "dbo.usp_inf_clinical_history_delete");
            cmd.Parameters.Add("@sid", SqlDbType.NVarChar, 50).Value = sid;
            cmd.Parameters.Add("@actor", SqlDbType.Int).Value = actor;
            await using var r = await cmd.ExecuteReaderAsync(inner).ConfigureAwait(false);
            return await r.ReadAsync(inner).ConfigureAwait(false) && r.GetBoolean(r.GetOrdinal("ok"));
        }, ct).ConfigureAwait(false);
    }
}
