using Infinity.Api.Data;
// The shared column readers live with the read repositories, deliberately in
// one place — see SqlReaderExtensions.
using Infinity.Api.Reads;

namespace Infinity.Api.Orders;

/// <summary>
/// The referring doctors and customers an order can be booked against.
/// </summary>
/// <remarks>
/// <para>
/// The write side has taken these since order entry was built — the create
/// procedure accepts an id, or a name it upserts — but nothing ever gave the
/// operator a way to pick one, so every Infinity order has been booked with no
/// referrer at all. This is the missing read.
/// </para>
/// <para>
/// SCOPED per centre since the roster screens landed: rosters are per-centre
/// in the LIS (pcc_code is the owning MCC unit) and both the legacy forms and
/// Telo filter their pickers to the selected centre. The first version handed
/// the whole network's roster to every account. Filtered in the browser after
/// that, exactly as the test catalogue is.
/// </para>
/// </remarks>
public sealed class ReferrerRepository(NobleConnectionFactory db, SqlRetry retry)
{
    /// <param name="Code">
    /// The lab's own code for the referrer. Shown beside the name because two
    /// doctors genuinely share a name and the code is what tells them apart.
    /// </param>
    public sealed record Referrer(int Id, string Code, string Name);

    public sealed record Referrers(
        IReadOnlyList<Referrer> Doctors,
        IReadOnlyList<Referrer> Customers);

    public async Task<Referrers> GetAsync(int mcc, CancellationToken ct = default)
    {
        return await retry.ExecuteAsync("orders.referrers", token =>
            db.QueryAsync("orders.referrers", async (conn, inner) =>
            {
                await using var cmd = db.CreateWriteCommand(conn, "dbo.usp_inf_order_referrers");
                cmd.Parameters.Add("@mcc", System.Data.SqlDbType.Int).Value = mcc;

                var doctors = new List<Referrer>();
                await using var r = await cmd.ExecuteReaderAsync(inner).ConfigureAwait(false);
                while (await r.ReadAsync(inner).ConfigureAwait(false))
                    doctors.Add(new Referrer(r.Int("id"), r.Str("code") ?? "", r.Str("name") ?? ""));

                var customers = new List<Referrer>();
                if (await r.NextResultAsync(inner).ConfigureAwait(false))
                {
                    while (await r.ReadAsync(inner).ConfigureAwait(false))
                        customers.Add(new Referrer(r.Int("id"), r.Str("code") ?? "", r.Str("name") ?? ""));
                }

                return new Referrers(doctors, customers);
            }, token), ct).ConfigureAwait(false);
    }
}
