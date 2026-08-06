using System.Data;
using Infinity.Api.Caching;
using Infinity.Api.Data;
using Infinity.Api.Reads;
using Microsoft.Data.SqlClient;

namespace Infinity.Api.Reports;

/// <summary>
/// The balance-based report lock, ported from Telo.
/// </summary>
/// <remarks>
/// <para>
/// A report is not released while money is owed. Two billing models, two rules:
/// </para>
/// <list type="bullet">
/// <item><b>B2C</b> — the patient has their OWN per-patient bill. Locked while
/// that bill's balance is above zero. The client wallet is deliberately NOT
/// consulted: B2C payments never post to the LIS client account, so its balance
/// is a permanent phantom negative and reading it would lock every B2C report
/// forever.</item>
/// <item><b>B2B</b> — no per-patient bill, because Noble bills the client's
/// wallet in bulk. Locked once the wallet drops BELOW the client's allowed
/// floor.</item>
/// </list>
/// <para>
/// The floor is <c>tbl_med_mcc_unit_master.creditlimit</c>, stored as a NEGATIVE
/// number: -2500 means "may owe up to ₹2,500". Only negative values count as an
/// allowance — NULL, zero and positive all mean no allowance, matching the LIS.
/// The amount reported as due is the amount OVER the floor, not the whole
/// balance, because that is what has to be paid to release the report.
/// </para>
/// <para>
/// <c>PerminentUnlock</c> on the client overrides everything, exactly as the
/// legacy LIS treats it.
/// </para>
/// <para>
/// This is a revenue rule, not a security boundary — scope is what decides who
/// may see a report. It is checked AFTER scope for that reason: whether a
/// report is locked must not be a way to discover that it exists.
/// </para>
/// </remarks>
public sealed class ReportLockRepository(
    NobleConnectionFactory db,
    SqlRetry retry,
    InfinityCache cache,
    SampleHeaderRepository headers)
{
    public sealed record ReportLock(bool Locked, string? Reason, decimal DueAmount)
    {
        public static readonly ReportLock Unlocked = new(false, null, 0m);
    }

    /// <summary>
    /// Cached briefly: opening one report hits this from the viewer, the graph
    /// probe and the download within a second or two, and they should share one
    /// computation. The trade is a window of up to a minute in both directions —
    /// a just-cleared balance can stay locked, a just-arisen one can leak a view.
    /// Telo makes the same trade at the same duration.
    /// </summary>
    private static readonly TimeSpan CacheFor = TimeSpan.FromSeconds(60);

    public async Task<ReportLock> GetAsync(string sid, CancellationToken ct = default)
    {
        var target = (sid ?? string.Empty).Trim();
        if (target.Length == 0) return ReportLock.Unlocked;

        var key = $"inf:report:lock:{target}";

        var hit = await cache.GetAsync(key, ct).ConfigureAwait(false);
        if (hit is not null)
        {
            try
            {
                var cached = System.Text.Json.JsonSerializer.Deserialize<ReportLock>(hit);
                if (cached is not null) return cached;
            }
            catch (System.Text.Json.JsonException)
            {
                // A poisoned entry must not take the download with it; fall
                // through and recompute.
            }
        }

        // The sample header resolves patient and client for this SID.
        // Deliberately not the worksheet procedure: its SID filter is a leading
        // wildcard over an unbounded window, which is a table scan per call —
        // Telo hit exactly that and moved off it.
        var header = await headers.GetAsync(target, ct).ConfigureAwait(false);
        var result = header is null
            ? ReportLock.Unlocked
            : await ComputeAsync(header.Pid, header.ClientCode, ct).ConfigureAwait(false);

        await cache.SetAsync(key, System.Text.Json.JsonSerializer.Serialize(result), CacheFor, ct)
                   .ConfigureAwait(false);
        return result;
    }

    private async Task<ReportLock> ComputeAsync(long pid, string? clientCode, CancellationToken ct)
    {
        var code = (clientCode ?? string.Empty).Trim().ToUpperInvariant();

        return await retry.ExecuteAsync("reports.lock", token =>
            db.QueryAsync("reports.lock", async (conn, inner) =>
            {
                decimal patientDue = 0m;
                var hasOwnBill = false;

                if (pid > 0)
                {
                    // medid compared as a STRING on purpose. The obvious
                    // TRY_CONVERT(INT, medid) = @pid wraps the COLUMN in a
                    // function and forces a scan of the billing table on every
                    // report open; both the LIS and Telo write medid as a plain
                    // int-as-string, so string equality selects the same rows and
                    // an index on medid can seek.
                    await using var bill = NobleConnectionFactory.CreateCommand(conn,
                        """
                        SELECT SUM(CASE WHEN ISNULL(Balance, 0) > 0 THEN Balance ELSE 0 END) AS due,
                               COUNT(*) AS bills
                        FROM dbo.tbl_billing_patient_detail
                        WHERE medid = @pid;
                        """);
                    // VarChar, not NVarChar: a varchar column promoted to nvarchar
                    // for the comparison is the same index-defeating mistake by
                    // another route.
                    bill.Parameters.Add("@pid", SqlDbType.VarChar, 50).Value =
                        pid.ToString(System.Globalization.CultureInfo.InvariantCulture);

                    await using var r = await bill.ExecuteReaderAsync(inner).ConfigureAwait(false);
                    if (await r.ReadAsync(inner).ConfigureAwait(false))
                    {
                        patientDue = r.IsDBNull(0) ? 0m : Convert.ToDecimal(r.GetValue(0));
                        hasOwnBill = !r.IsDBNull(1) && r.GetInt32(1) > 0;
                    }
                }

                if (patientDue > 0m) return new ReportLock(true, "patient", patientDue);

                // Only when the patient has no bill of their own does the client
                // wallet decide. Checking it for a B2C patient would read a
                // balance their payments never post to.
                if (hasOwnBill || code.Length == 0) return ReportLock.Unlocked;

                await using var wallet = NobleConnectionFactory.CreateCommand(conn,
                    """
                    SELECT a.currentbalance, u.creditlimit, u.PerminentUnlock
                    FROM dbo.tbl_med_mcc_unit_master u
                    LEFT JOIN dbo.tbl_med_mcc_account_master a ON a.mcccode = u.id
                    WHERE UPPER(u.MCCUnitCode) = @code;
                    """);
                wallet.Parameters.Add("@code", SqlDbType.VarChar, 50).Value = code;

                await using var w = await wallet.ExecuteReaderAsync(inner).ConfigureAwait(false);
                if (!await w.ReadAsync(inner).ConfigureAwait(false)) return ReportLock.Unlocked;

                if (!w.IsDBNull(2) && Convert.ToBoolean(w.GetValue(2))) return ReportLock.Unlocked;

                var balance = w.IsDBNull(0) ? 0m : Convert.ToDecimal(w.GetValue(0));
                var limit = w.IsDBNull(1) ? 0m : Convert.ToDecimal(w.GetValue(1));
                var floor = limit < 0m ? limit : 0m;

                return balance < floor
                    ? new ReportLock(true, "client", floor - balance)
                    : ReportLock.Unlocked;
            }, token), ct).ConfigureAwait(false);
    }
}
