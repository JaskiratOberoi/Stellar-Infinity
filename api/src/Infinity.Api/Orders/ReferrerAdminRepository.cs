using System.Data;
using Infinity.Api.Data;
using Infinity.Api.Reads;
using Microsoft.Data.SqlClient;

namespace Infinity.Api.Orders;

/// <summary>
/// Referrer roster management — the LIS's own per-centre masters
/// (tbl_med_mcc_doctors / tbl_med_mcc_customer), managed from Infinity the way
/// Pcc/Doctors.aspx and Pcc/Customers.aspx manage them from the legacy portal.
/// </summary>
/// <remarks>
/// The centre guard lives in the procedures: an update touches a row only when
/// it already belongs to the given centre, so this class never needs to trust
/// its callers about ownership. No delete exists anywhere in the chain — the
/// legacy hard delete throws on any referrer with billing history; deactivation
/// is the operation that works.
/// </remarks>
public sealed class ReferrerAdminRepository(NobleConnectionFactory db, SqlRetry retry)
{
    public sealed record RosterEntry(
        int Id, string Code, string Name, bool IsActive, DateTime? CreatedAt, string? CreatedBy);

    public sealed record Roster(
        IReadOnlyList<RosterEntry> Doctors,
        IReadOnlyList<RosterEntry> Customers);

    public sealed record StatRow(int? Id, string Name, int Bills, decimal Charges);

    public sealed record Stats(
        IReadOnlyList<StatRow> Doctors,
        IReadOnlyList<StatRow> Customers);

    public Task<Roster> ListAsync(int mcc, CancellationToken ct = default) =>
        retry.ExecuteAsync("referrers.list", token =>
            db.QueryAsync("referrers.list", async (conn, inner) =>
            {
                await using var cmd = db.CreateWriteCommand(conn, "dbo.usp_inf_referrer_list");
                cmd.Parameters.Add("@mcc", SqlDbType.Int).Value = mcc;

                await using var r = await cmd.ExecuteReaderAsync(inner).ConfigureAwait(false);
                var doctors = await ReadRosterAsync(r, inner).ConfigureAwait(false);
                IReadOnlyList<RosterEntry> customers = await r.NextResultAsync(inner).ConfigureAwait(false)
                    ? await ReadRosterAsync(r, inner).ConfigureAwait(false)
                    : [];
                return new Roster(doctors, customers);
            }, token), ct);

    public Task<RequestResult> SaveAsync(
        string kind, int? id, int mcc, string code, string name, bool active, int actor,
        CancellationToken ct = default) =>
        db.QueryAsync("referrers.save", async (conn, inner) =>
        {
            await using var cmd = db.CreateWriteCommand(conn, "dbo.usp_inf_referrer_save");
            cmd.Parameters.Add("@kind", SqlDbType.VarChar, 10).Value = kind;
            cmd.Parameters.Add("@id", SqlDbType.Int).Value = (object?)id ?? DBNull.Value;
            cmd.Parameters.Add("@mcc", SqlDbType.Int).Value = mcc;
            cmd.Parameters.Add("@code", SqlDbType.NVarChar, 100).Value = code;
            cmd.Parameters.Add("@name", SqlDbType.NVarChar, 200).Value = name;
            cmd.Parameters.Add("@active", SqlDbType.Bit).Value = active;
            cmd.Parameters.Add("@actor", SqlDbType.Int).Value = actor;

            await using var r = await cmd.ExecuteReaderAsync(CommandBehavior.SingleResult, inner)
                .ConfigureAwait(false);
            if (!await r.ReadAsync(inner).ConfigureAwait(false))
                return new RequestResult(false, "NO_RESULT", "The save reported nothing.", null);
            return new RequestResult(r.Bool("ok"), r.Str("error_code"), r.Str("message"), r.NullableInt("id"));
        }, ct);

    public Task<Stats> StatsAsync(int mcc, DateTime from, DateTime to, CancellationToken ct = default) =>
        retry.ExecuteAsync("referrers.stats", token =>
            db.QueryAsync("referrers.stats", async (conn, inner) =>
            {
                await using var cmd = db.CreateWriteCommand(conn, "dbo.usp_inf_referrer_stats");
                cmd.Parameters.Add("@mcc", SqlDbType.Int).Value = mcc;
                cmd.Parameters.Add("@from", SqlDbType.Date).Value = from.Date;
                cmd.Parameters.Add("@to", SqlDbType.Date).Value = to.Date;

                await using var r = await cmd.ExecuteReaderAsync(inner).ConfigureAwait(false);
                var doctors = await ReadStatsAsync(r, inner).ConfigureAwait(false);
                IReadOnlyList<StatRow> customers = await r.NextResultAsync(inner).ConfigureAwait(false)
                    ? await ReadStatsAsync(r, inner).ConfigureAwait(false)
                    : [];
                return new Stats(doctors, customers);
            }, token), ct);

    private static async Task<IReadOnlyList<RosterEntry>> ReadRosterAsync(
        SqlDataReader r, CancellationToken ct)
    {
        var rows = new List<RosterEntry>();
        while (await r.ReadAsync(ct).ConfigureAwait(false))
        {
            rows.Add(new RosterEntry(
                r.Int("id"), r.Str("code") ?? "", r.Str("name") ?? "",
                r.Bool("is_active"), r.Date("created_at"), r.Str("created_by")));
        }
        return rows;
    }

    private static async Task<IReadOnlyList<StatRow>> ReadStatsAsync(
        SqlDataReader r, CancellationToken ct)
    {
        var rows = new List<StatRow>();
        while (await r.ReadAsync(ct).ConfigureAwait(false))
        {
            rows.Add(new StatRow(
                r.NullableInt("id"), r.Str("name") ?? "", r.Int("bills"), r.Dec("charges")));
        }
        return rows;
    }
}
