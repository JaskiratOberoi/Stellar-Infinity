using System.Data;
using Infinity.Api.Data;
using Infinity.Api.Reads;

namespace Infinity.Api.Orders;

/// <summary>One thing the lab bills for but never performs on the LIS.</summary>
/// <param name="Mrp">Rupees per unit. The AUTHORITATIVE price — see the remarks.</param>
/// <param name="OnlyWithPackages">
/// The master profiles this extra is sold with, when it is sold with some
/// and not others — the Smart Report and the HR health packages
/// (inf_smart_report_package, script 144). Null or empty: offered on any
/// order. The form offers it only when the cart carries one; placement
/// refuses it otherwise.
/// </param>
/// <param name="MiniWith">
/// The small profiles and single tests the extra is ALSO sold with, at
/// <paramref name="MiniMrp"/> instead of <paramref name="Mrp"/> — the Smart
/// Report's introductory ₹21 with a KFT, LFT, CBC, HbA1c and the like
/// (inf_smart_report_mini, script 148). B2B orders only. A cart that carries
/// a full package is priced by the package rule even when a mini profile is
/// also present.
/// </param>
public sealed record CustomTest(
    int Id, string Code, string Name, int Mrp, bool RequiresMrd, bool AllowQty,
    IReadOnlyList<int>? OnlyWithPackages = null,
    IReadOnlyList<MiniItem>? MiniWith = null,
    int? MiniMrp = null)
{
    /// <summary>True when the extra may be sold with these cart items.</summary>
    public bool OfferedWith(IEnumerable<CartItem> items, bool b2b) => PriceFor(items, b2b) is not null;

    /// <summary>
    /// What the extra costs on an order of these items, or null when it is
    /// not offered with them at all. The ONE place the tier is decided, so
    /// the form's chip, the 50% floor and the bill cannot disagree.
    /// </summary>
    public int? PriceFor(IEnumerable<CartItem> items, bool b2b)
    {
        if (OnlyWithPackages is not { Count: > 0 } need) return Mrp;
        var list = items as IReadOnlyCollection<CartItem> ?? items.ToList();
        if (list.Any(i => string.Equals(i.Kind, "master", StringComparison.OrdinalIgnoreCase) && need.Contains(i.Id)))
            return Mrp;
        if (b2b && MiniMrp is int mini && MiniWith is { Count: > 0 } minis
            && list.Any(i => minis.Any(m => string.Equals(m.Kind, i.Kind, StringComparison.OrdinalIgnoreCase) && m.Id == i.Id)))
            return mini;
        return null;
    }
}

/// <summary>A cart item kind ('profile' or 'test') and catalogue id an extra is sold with.</summary>
public sealed record MiniItem(string Kind, int Id);

/// <summary>
/// "Custom" tests — charged by the lab, not carried out by it.
/// </summary>
/// <remarks>
/// <para>
/// These live in <c>dbo.telo_custom_test</c>, are scoped to a client code, and
/// never link to tbl_med_test_master because there is no LIS test behind them.
/// The Smart Report (SMART-RPT, ₹99) is one: the lab charges for the booklet,
/// and nothing is measured for it.
/// </para>
/// <para>
/// <c>client_code = '*'</c> is the every-client sentinel, which is how the Smart
/// Report is offered network-wide. It cannot collide with a real MCCUnitCode.
/// </para>
/// <para>
/// Read from TELO's table rather than a copy. Both products sell the same
/// catalogue against the same LIS, and a second price list is two answers to
/// one question — a test priced ₹99 in one and ₹149 in the other, with the
/// patient's bill depending on which screen took the order.
/// </para>
/// <para>
/// Not cached: the set is tiny, edits are rare, and this is what an order is
/// BILLED at. Freshness beats a saved round trip when the number is money.
/// </para>
/// </remarks>
public sealed class CustomTestRepository(NobleConnectionFactory db, SqlRetry retry)
{
    /// <summary>
    /// Resolved through the unit master so the caller can pass the mcc id it
    /// already checked scope against, rather than carrying a code around.
    /// </summary>
    private const string Sql = """
        DECLARE @code NVARCHAR(50) =
            (SELECT LTRIM(RTRIM(MCCUnitCode)) FROM dbo.tbl_med_mcc_unit_master WHERE id = @mcc);

        SELECT id, code, name, mrp, requires_mrd, allow_qty
        FROM dbo.telo_custom_test
        WHERE is_active = 1 AND client_code IN (@code, N'*')
        ORDER BY name;

        -- The packages the Smart Report is sold with (144). Second result
        -- set, so the offer and its condition arrive together.
        SELECT master_profile_id FROM dbo.inf_smart_report_package;

        -- The mini profiles it is sold with at the introductory price (148).
        -- Third result set; the price rides with each row so raising it is
        -- an UPDATE here and nowhere else.
        SELECT kind, catalogue_id, mrp FROM dbo.inf_smart_report_mini;
        """;

    /// <summary>Active custom tests offered to one client.</summary>
    public async Task<IReadOnlyList<CustomTest>> ForMccAsync(
        int mcc, CancellationToken ct = default)
    {
        if (mcc <= 0) return [];

        return await retry.ExecuteAsync("orders.customTests", token =>
            db.QueryAsync("orders.customTests", async (conn, inner) =>
            {
                await using var cmd = NobleConnectionFactory.CreateCommand(conn, Sql);
                cmd.Parameters.Add("@mcc", SqlDbType.Int).Value = mcc;

                var rows = new List<CustomTest>();
                await using var r = await cmd.ExecuteReaderAsync(inner).ConfigureAwait(false);
                while (await r.ReadAsync(inner).ConfigureAwait(false))
                {
                    rows.Add(new CustomTest(
                        Id: r.Int("id"),
                        Code: (r.Str("code") ?? string.Empty).Trim(),
                        Name: (r.Str("name") ?? string.Empty).Trim(),
                        Mrp: r.NullableInt("mrp") ?? 0,
                        RequiresMrd: r.Bool("requires_mrd"),
                        AllowQty: r.Bool("allow_qty")));
                }

                var packages = new List<int>();
                if (await r.NextResultAsync(inner).ConfigureAwait(false))
                {
                    while (await r.ReadAsync(inner).ConfigureAwait(false)) packages.Add(r.GetInt32(0));
                }
                // The mini tier: the items and ONE price. The table carries a
                // price per row so a single item could differ, but the offer
                // is one introductory price; the lowest wins if they ever do.
                var minis = new List<MiniItem>();
                int? miniMrp = null;
                if (await r.NextResultAsync(inner).ConfigureAwait(false))
                {
                    while (await r.ReadAsync(inner).ConfigureAwait(false))
                    {
                        minis.Add(new MiniItem((r.Str("kind") ?? string.Empty).Trim().ToLowerInvariant(), r.Int("catalogue_id")));
                        var price = r.Int("mrp");
                        miniMrp = miniMrp is int m ? Math.Min(m, price) : price;
                    }
                }
                // The Smart Report is the one extra with a condition. An empty
                // list would mean "with nothing", so it is left unconditioned
                // only when the table is empty — which it is not seeded to be.
                if (packages.Count > 0)
                {
                    for (var i = 0; i < rows.Count; i++)
                    {
                        if (string.Equals(rows[i].Code, Reports.SmartReportAccessRepository.SmartReportCode, StringComparison.OrdinalIgnoreCase))
                            rows[i] = rows[i] with
                            {
                                OnlyWithPackages = packages,
                                MiniWith = minis.Count > 0 ? minis : null,
                                MiniMrp = minis.Count > 0 ? miniMrp : null,
                            };
                    }
                }
                return (IReadOnlyList<CustomTest>)rows;
            }, token), ct).ConfigureAwait(false);
    }

    /// <summary>
    /// Re-resolve one custom test for a client, server-side, at order time.
    /// </summary>
    /// <remarks>
    /// The price the browser posted is never trusted: it decides what a patient
    /// is charged, and a caller that could set it would be setting the bill.
    /// Returns null when the id is not an active custom test FOR THAT CLIENT,
    /// which also stops one client's order billing another's private test.
    /// </remarks>
    public async Task<CustomTest?> ResolveAsync(
        int id, int mcc, CancellationToken ct = default)
    {
        if (id <= 0) return null;
        var all = await ForMccAsync(mcc, ct).ConfigureAwait(false);
        return all.FirstOrDefault(t => t.Id == id);
    }
}
