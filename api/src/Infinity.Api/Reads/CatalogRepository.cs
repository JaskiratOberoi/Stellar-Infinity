using System.Data;
using Infinity.Api.Data;
using Microsoft.Data.SqlClient;

namespace Infinity.Api.Reads;

/// <param name="Kind">test | profile | master</param>
/// <param name="Rate">
/// What this client would actually be billed. Null means the item has no price
/// for them at all — not zero.
/// </param>
/// <param name="RateSource">
/// special | ratelist | mrp | none. Surfaced rather than hidden: a B2B item
/// quietly falling through to MRP is a margin leak, and naming the tier is what
/// makes it visible before the order is placed rather than after invoicing.
/// </param>
public sealed record CatalogItem(
    string Kind,
    int Id,
    string? Code,
    string? Name,
    string? DepartmentName,
    decimal? Mrp,
    decimal? Rate,
    string RateSource);

/// <summary>
/// The test catalogue, priced for one client.
///
/// Phase 1 of bringing Telo's ordering pipeline across. A cart cannot be built
/// without knowing what each item costs this client, so this comes first.
///
/// Calls Infinity's own <c>dbo.usp_inf_catalog_search</c>, which mirrors the
/// tier order of <c>usp_telo_resolve_rate</c> — see
/// 78_usp_inf_catalog_search.sql for why it is set-based here and for the
/// column-naming trap in the rate-list tables.
/// </summary>
public sealed class CatalogRepository(NobleConnectionFactory db, SqlRetry retry)
{
    public Task<Paged<CatalogItem>> SearchAsync(
        int? mcc,
        string? search,
        string? kind,
        int page,
        int pageSize,
        CancellationToken ct = default) =>
        retry.ExecuteAsync("catalog.search", token =>
            db.QueryAsync("catalog.search", async (conn, inner) =>
            {
                var (p, size) = Paged<CatalogItem>.Clamp(page, pageSize, 100);

                await using var cmd = db.CreateWriteCommand(conn, "dbo.usp_inf_catalog_search");
                // Not a write — but this unions three master tables and resolves
                // rates per row, which outruns the short read timeout on a busy
                // server the first time the plan is compiled.

                cmd.Parameters.Add("@mcc", SqlDbType.Int).Value = (object?)mcc ?? DBNull.Value;
                cmd.Parameters.Add("@search", SqlDbType.NVarChar, 100).Value =
                    string.IsNullOrWhiteSpace(search) ? DBNull.Value : search.Trim();
                cmd.Parameters.Add("@kind", SqlDbType.VarChar, 10).Value =
                    kind is "test" or "profile" or "master" ? kind : DBNull.Value;
                cmd.Parameters.Add("@page", SqlDbType.Int).Value = p;
                cmd.Parameters.Add("@page_size", SqlDbType.Int).Value = size;

                await using var r = await cmd.ExecuteReaderAsync(CommandBehavior.SingleResult, inner)
                    .ConfigureAwait(false);

                var rows = new List<CatalogItem>();
                var total = 0;

                while (await r.ReadAsync(inner).ConfigureAwait(false))
                {
                    if (rows.Count == 0) total = r.NullableInt("total_count") ?? 0;

                    rows.Add(new CatalogItem(
                        Kind: r.Str("kind") ?? "test",
                        Id: r.Int("id"),
                        Code: r.Str("code"),
                        Name: r.Str("name"),
                        DepartmentName: r.Str("department_name"),
                        Mrp: r.NullableDec("mrp"),
                        Rate: r.NullableDec("rate"),
                        RateSource: r.Str("rate_source") ?? "none"));
                }

                return new Paged<CatalogItem>(rows, total, p, size);
            }, token), ct);
}
