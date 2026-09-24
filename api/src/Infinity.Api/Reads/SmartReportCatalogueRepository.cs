using System.Data;
using Infinity.Api.Data;

namespace Infinity.Api.Reads;

/// <summary>One catalogue item the Smart Report is sold with.</summary>
/// <param name="Kind">test | profile | package.</param>
/// <param name="IsNew">Added to the list within the last 24 hours — the client home marks it.</param>
public sealed record SmartCatalogueItem(string Kind, string Code, string Name, DateTimeOffset? AddedAt, bool IsNew);

public sealed record SmartTierPrice(string Tier, int ListMrp, int? OfferMrp);

/// <summary>
/// The Smart Report's coverage as a client sees it: which single tests,
/// profiles and packages carry the booklet, at which tier, and what is new.
/// </summary>
/// <param name="OfferUntil">Last day of the introductory offer, when one is in force.</param>
public sealed record SmartCatalogue(
    IReadOnlyList<SmartCatalogueItem> Items,
    IReadOnlyList<SmartTierPrice> Tiers,
    DateOnly? OfferUntil,
    string? OfferNote);

/// <summary>
/// Reads the three lists the Smart Report is sold against
/// (inf_smart_report_mini for tests and profiles, inf_smart_report_package for
/// packages) with their catalogue names, the tier prices (inf_smart_report_tier)
/// and the offers in force (inf_smart_report_offer). For the client home's
/// coverage panel, so a centre can see what to order the booklet with.
/// </summary>
/// <remarks>
/// Only ACTIVE catalogue rows are listed: the Anemia Profile sits on the
/// list against the day it is reactivated, and until then a centre cannot
/// order it, so showing it would be a promise the order form breaks. "New"
/// is the list's own created_at, not the catalogue's — it marks a test
/// joining the booklet, which is the news a centre cares about.
/// </remarks>
public sealed class SmartReportCatalogueRepository(NobleConnectionFactory db, SqlRetry retry)
{
    private const string Sql = """
        DECLARE @since DATETIME2 = DATEADD(HOUR, -24, SYSUTCDATETIME());

        SELECT kind, code, name, added_at, is_new
        FROM (
            SELECT N'test' AS kind, LTRIM(RTRIM(t.TestCode)) AS code, LTRIM(RTRIM(t.Testname)) AS name,
                   m.created_at AS added_at, CASE WHEN m.created_at >= @since THEN 1 ELSE 0 END AS is_new
            FROM dbo.inf_smart_report_mini m
            JOIN dbo.tbl_med_test_master t ON t.id = m.catalogue_id
            WHERE m.kind = N'test' AND t.IsActive = 1
            UNION ALL
            SELECT N'profile', LTRIM(RTRIM(p.Profile_Code)), LTRIM(RTRIM(p.Profile_Name)),
                   m.created_at, CASE WHEN m.created_at >= @since THEN 1 ELSE 0 END
            FROM dbo.inf_smart_report_mini m
            JOIN dbo.tbl_med_test_profile_master p ON p.id = m.catalogue_id
            WHERE m.kind = N'profile' AND p.IsActive = 1
            UNION ALL
            SELECT N'package', LTRIM(RTRIM(k.Master_Profile_Code)), LTRIM(RTRIM(k.Master_Profile_Name)),
                   s.created_at, CASE WHEN s.created_at >= @since THEN 1 ELSE 0 END
            FROM dbo.inf_smart_report_package s
            JOIN dbo.tbl_med_test_master_profile_master k ON k.id = s.master_profile_id
            WHERE k.IsActive = 1
        ) x
        ORDER BY CASE kind WHEN N'test' THEN 0 WHEN N'profile' THEN 1 ELSE 2 END, is_new DESC, name;

        SELECT t.tier, t.list_mrp, o.offer_mrp, o.offer_until, o.note
        FROM dbo.inf_smart_report_tier t
        LEFT JOIN dbo.inf_smart_report_offer o
               ON o.tier = t.tier AND o.offer_until >= CAST(GETDATE() AS DATE)
        ORDER BY t.list_mrp;
        """;

    public async Task<SmartCatalogue> GetAsync(CancellationToken ct = default)
    {
        return await retry.ExecuteAsync("smart.catalogue", token =>
            db.QueryAsync("smart.catalogue", async (conn, inner) =>
            {
                await using var cmd = NobleConnectionFactory.CreateCommand(conn, Sql);
                var items = new List<SmartCatalogueItem>();
                await using var r = await cmd.ExecuteReaderAsync(inner).ConfigureAwait(false);
                while (await r.ReadAsync(inner).ConfigureAwait(false))
                {
                    var added = r.IsDBNull(r.GetOrdinal("added_at")) ? (DateTime?)null : r.GetDateTime(r.GetOrdinal("added_at"));
                    items.Add(new SmartCatalogueItem(
                        Kind: r.Str("kind") ?? "test",
                        Code: r.Str("code") ?? string.Empty,
                        Name: r.Str("name") ?? string.Empty,
                        AddedAt: added is DateTime d ? new DateTimeOffset(DateTime.SpecifyKind(d, DateTimeKind.Utc)) : null,
                        IsNew: r.Int("is_new") == 1));
                }

                var tiers = new List<SmartTierPrice>();
                DateOnly? until = null;
                string? note = null;
                if (await r.NextResultAsync(inner).ConfigureAwait(false))
                {
                    while (await r.ReadAsync(inner).ConfigureAwait(false))
                    {
                        var offer = r.NullableInt("offer_mrp");
                        tiers.Add(new SmartTierPrice(r.Str("tier") ?? string.Empty, r.Int("list_mrp"), offer));
                        if (offer is not null && r.Date("offer_until") is DateTime u)
                        {
                            var day = DateOnly.FromDateTime(u);
                            if (until is null || day < until) { until = day; note = r.Str("note"); }
                        }
                    }
                }
                return new SmartCatalogue(items, tiers, until, note);
            }, token), ct).ConfigureAwait(false);
    }
}
