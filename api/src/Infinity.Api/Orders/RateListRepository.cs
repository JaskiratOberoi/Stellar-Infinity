using System.Data;
using Infinity.Api.Data;
using Infinity.Api.Reads;

namespace Infinity.Api.Orders;

/// <param name="ClientCount">
/// How many centres this list prices. Editing a rate re-prices all of them, so
/// this travels with every list rather than being available on request.
/// </param>
/// <param name="PricedTests">
/// Tests carrying a price here. The gap against the catalogue is what falls
/// through to MRP.
/// </param>
public sealed record RateList(int Id, string? Name, bool IsActive, int ClientCount, int PricedTests);

/// <param name="Rate">Null means no price in this list — the client is billed MRP.</param>
public sealed record RateListItem(
    int Id, string? Code, string? Name, string? DepartmentName, decimal? Mrp, decimal? Rate);

/// <param name="SeededCount">
/// Rows the procedure pre-populated the new list with. Surfaced because a list
/// that arrives with prices already in it behaves very differently from an
/// empty one, and the difference is invisible otherwise.
/// </param>
public sealed record CreateRateListResult(
    bool Ok, string? ErrorCode, string? Message, int? RateTypeId, int SeededCount);

/// <summary>
/// Rate lists: what a client is charged, and the only place in Infinity that
/// can change it.
///
/// TESTS ONLY. usp_telo_set_rate writes tbl_med_test_rates_with_pcc_type and
/// nothing else, so profiles and master profiles cannot be priced through here.
/// The catalogue prices all three kinds, which makes the asymmetry easy to trip
/// over — hence the note on <see cref="SetRateAsync"/> and the banner on the
/// screen.
///
/// Neither write carries an origin marker: a rate list is configuration, not a
/// transaction, so there is nothing to attribute to a platform and Telo's
/// procedures are called unchanged.
/// </summary>
public sealed class RateListRepository(NobleConnectionFactory db, SqlRetry retry)
{
    public Task<IReadOnlyList<RateList>> ListAsync(string? search, CancellationToken ct = default) =>
        retry.ExecuteAsync("rates.lists", token =>
            db.QueryAsync("rates.lists", async (conn, inner) =>
            {
                await using var cmd = db.CreateWriteCommand(conn, "dbo.usp_inf_rate_lists");
                cmd.Parameters.Add("@search", SqlDbType.NVarChar, 100).Value =
                    string.IsNullOrWhiteSpace(search) ? DBNull.Value : search.Trim();

                await using var r = await cmd.ExecuteReaderAsync(CommandBehavior.SingleResult, inner)
                    .ConfigureAwait(false);

                var rows = new List<RateList>();
                while (await r.ReadAsync(inner).ConfigureAwait(false))
                {
                    rows.Add(new RateList(
                        r.Int("id"),
                        r.Str("name"),
                        (r.NullableInt("isActive") ?? 0) == 1,
                        r.NullableInt("clientCount") ?? 0,
                        r.NullableInt("pricedTests") ?? 0));
                }
                return (IReadOnlyList<RateList>)rows;
            }, token), ct);

    public Task<Paged<RateListItem>> ItemsAsync(
        int rateTypeId, string? search, string? filter, int page, int pageSize,
        CancellationToken ct = default) =>
        retry.ExecuteAsync("rates.items", token =>
            db.QueryAsync("rates.items", async (conn, inner) =>
            {
                var (p, size) = Paged<RateListItem>.Clamp(page, pageSize, 100);

                await using var cmd = db.CreateWriteCommand(conn, "dbo.usp_inf_rate_list_items");
                cmd.Parameters.Add("@rate_type_id", SqlDbType.Int).Value = rateTypeId;
                cmd.Parameters.Add("@search", SqlDbType.NVarChar, 100).Value =
                    string.IsNullOrWhiteSpace(search) ? DBNull.Value : search.Trim();
                cmd.Parameters.Add("@filter", SqlDbType.VarChar, 10).Value =
                    filter is "priced" or "unpriced" ? filter : DBNull.Value;
                cmd.Parameters.Add("@page", SqlDbType.Int).Value = p;
                cmd.Parameters.Add("@page_size", SqlDbType.Int).Value = size;

                await using var r = await cmd.ExecuteReaderAsync(CommandBehavior.SingleResult, inner)
                    .ConfigureAwait(false);

                var rows = new List<RateListItem>();
                var total = 0;
                while (await r.ReadAsync(inner).ConfigureAwait(false))
                {
                    if (rows.Count == 0) total = r.NullableInt("total_count") ?? 0;

                    rows.Add(new RateListItem(
                        r.Int("id"), r.Str("code"), r.Str("name"), r.Str("departmentName"),
                        r.NullableDec("mrp"), r.NullableDec("rate")));
                }

                return new Paged<RateListItem>(rows, total, p, size);
            }, token), ct);

    /// <summary>
    /// Create a rate list. Not retried — a replay would make a second list with
    /// the same name, and nothing downstream distinguishes them.
    /// </summary>
    public Task<CreateRateListResult> CreateAsync(
        int userId, string name, CancellationToken ct = default) =>
        db.QueryAsync("rates.create", async (conn, inner) =>
        {
            await using var cmd = db.CreateWriteCommand(conn, "dbo.usp_telo_create_rate_list");
            cmd.Parameters.Add("@name", SqlDbType.NVarChar, 50).Value = name.Trim();
            cmd.Parameters.Add("@userId", SqlDbType.Int).Value = userId;

            await using var r = await cmd.ExecuteReaderAsync(inner).ConfigureAwait(false);

            if (await r.ReadAsync(inner).ConfigureAwait(false))
            {
                return new CreateRateListResult(
                    (r.NullableInt("ok") ?? 0) == 1,
                    r.Str("error_code"), r.Str("message"), r.NullableInt("rate_type_id"),
                    r.NullableInt("seeded_count") ?? 0);
            }

            return new CreateRateListResult(false, "NO_RESULT", "The procedure returned nothing.", null, 0);
        }, ct);

    /// <summary>
    /// Set one test's price in one list.
    ///
    /// Safe to repeat: the procedure upserts to an absolute price rather than
    /// adjusting one, so a replay lands on the same number. Still not retried
    /// automatically — it re-prices every client on the list, and that is not a
    /// thing to do twice by accident.
    ///
    /// TESTS ONLY: there is no equivalent for profiles or master profiles.
    /// </summary>
    public Task SetRateAsync(int rateTypeId, int testMasterId, int price, CancellationToken ct = default) =>
        db.QueryAsync("rates.set", async (conn, inner) =>
        {
            await using var cmd = db.CreateWriteCommand(conn, "dbo.usp_telo_set_rate");
            cmd.Parameters.Add("@rateTypeId", SqlDbType.Int).Value = rateTypeId;
            cmd.Parameters.Add("@testMasterId", SqlDbType.Int).Value = testMasterId;
            cmd.Parameters.Add("@price", SqlDbType.Int).Value = price;

            await cmd.ExecuteNonQueryAsync(inner).ConfigureAwait(false);
            return 0;
        }, ct);
}
