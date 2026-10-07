using System.Data;
using Infinity.Api.Data;

namespace Infinity.Api.Reads;

/// <summary>The filters both the ledger and its summary take (script 181).</summary>
public sealed record SalesLedgerFilter(
    DateTime From, DateTime To, string? Client, int? Bu, string? Kind, string? Search, string? Source);

public sealed record SalesLedgerLine(
    DateTimeOffset SoldAt, int LineId, string Kind, int? ItemId, string? Code, string? Name, decimal Amount, int? Mrp,
    int Pid, string? Patient, string? ClientCode, string? ClientName, int? BuId, string? BuCode, string? Sid,
    string Source, string? ChargedBy);

public sealed record SalesTotals(int Lines, decimal Amount, int Clients, int Patients, int Days);
public sealed record SalesByDay(string Day, int Lines, decimal Amount, int Patients);
public sealed record SalesByBu(int? BuId, string? BuCode, string? BuName, int Lines, decimal Amount, int Clients);
public sealed record SalesByClient(string? ClientCode, string? ClientName, int Lines, decimal Amount, int Patients);
public sealed record SalesByKind(string Kind, int Lines, decimal Amount);
public sealed record SalesByItem(string Kind, string? Code, string? Name, int Lines, decimal Amount, decimal MinRate, decimal MaxRate, int Clients);
public sealed record SalesBySource(string Source, int Lines, decimal Amount);
public sealed record SalesByItemClientRate(string Kind, string? Code, string? Name, string? ClientCode, string? ClientName, decimal Rate, int Lines, decimal Amount);

public sealed record SalesSummary(
    SalesTotals Totals,
    IReadOnlyList<SalesByDay> ByDay,
    IReadOnlyList<SalesByBu> ByBusinessUnit,
    IReadOnlyList<SalesByClient> ByClient,
    IReadOnlyList<SalesByKind> ByKind,
    IReadOnlyList<SalesByItem> ByItem,
    IReadOnlyList<SalesBySource> BySource,
    IReadOnlyList<SalesByItemClientRate> ByItemClientRate);

/// <summary>
/// The company-wide sales ledger: every sale line in the lab's own
/// definition (see script 181), paged newest first, and the same lines
/// grouped for the dashboard.
/// </summary>
public sealed class SalesLedgerRepository(NobleConnectionFactory db, SqlRetry retry)
{
    /// <summary>Noble stores wall-clock IST; say so, or a UTC renderer shifts it.</summary>
    private static DateTimeOffset Ist(DateTime dt) =>
        new(DateTime.SpecifyKind(dt, DateTimeKind.Unspecified), TimeSpan.FromMinutes(330));

    private static void AddFilter(Microsoft.Data.SqlClient.SqlCommand cmd, SalesLedgerFilter f)
    {
        cmd.Parameters.Add("@from", SqlDbType.Date).Value = f.From.Date;
        cmd.Parameters.Add("@to", SqlDbType.Date).Value = f.To.Date;
        cmd.Parameters.Add("@client", SqlDbType.NVarChar, 100).Value = (object?)f.Client ?? DBNull.Value;
        cmd.Parameters.Add("@bu", SqlDbType.Int).Value = (object?)f.Bu ?? DBNull.Value;
        cmd.Parameters.Add("@kind", SqlDbType.NVarChar, 10).Value = (object?)f.Kind ?? DBNull.Value;
        cmd.Parameters.Add("@search", SqlDbType.NVarChar, 100).Value = (object?)f.Search ?? DBNull.Value;
        cmd.Parameters.Add("@source", SqlDbType.NVarChar, 10).Value = (object?)f.Source ?? DBNull.Value;
    }

    public Task<(IReadOnlyList<SalesLedgerLine> Rows, SalesTotals Totals)> LedgerAsync(
        SalesLedgerFilter f, int page, int pageSize, CancellationToken ct = default) =>
        retry.ExecuteAsync("sales.ledger", token =>
            db.QueryAsync("sales.ledger", async (conn, inner) =>
            {
                await using var cmd = NobleConnectionFactory.CreateCommand(conn, "dbo.usp_inf_sales_ledger");
                cmd.CommandType = CommandType.StoredProcedure;
                cmd.CommandTimeout = 120;
                AddFilter(cmd, f);
                cmd.Parameters.Add("@page", SqlDbType.Int).Value = page;
                cmd.Parameters.Add("@page_size", SqlDbType.Int).Value = pageSize;
                var rows = new List<SalesLedgerLine>();
                await using var r = await cmd.ExecuteReaderAsync(inner).ConfigureAwait(false);
                while (await r.ReadAsync(inner).ConfigureAwait(false))
                    rows.Add(new SalesLedgerLine(
                        Ist(r.GetDateTime(r.GetOrdinal("sold_at"))), r.Int("line_id"), r.Str("kind") ?? "Test", r.NullableInt("item_id"),
                        r.Str("code"), r.Str("name"), r.Dec("amount"), r.NullableInt("mrp"),
                        r.Int("pid"), r.Str("patient"), r.Str("client_code"), r.Str("client_name"), r.NullableInt("bu_id"), r.Str("bu_code"),
                        r.Str("sid"), r.Str("source") ?? "lis", r.Str("charged_by")));
                var totals = new SalesTotals(0, 0, 0, 0, (f.To.Date - f.From.Date).Days + 1);
                if (await r.NextResultAsync(inner).ConfigureAwait(false) && await r.ReadAsync(inner).ConfigureAwait(false))
                    totals = totals with { Lines = r.Int("lines"), Amount = r.Dec("amount"), Clients = r.Int("clients"), Patients = r.Int("patients") };
                return ((IReadOnlyList<SalesLedgerLine>)rows, totals);
            }, token), ct);

    public Task<SalesSummary> SummaryAsync(SalesLedgerFilter f, CancellationToken ct = default) =>
        retry.ExecuteAsync("sales.summary", token =>
            db.QueryAsync("sales.summary", async (conn, inner) =>
            {
                await using var cmd = NobleConnectionFactory.CreateCommand(conn, "dbo.usp_inf_sales_summary");
                cmd.CommandType = CommandType.StoredProcedure;
                cmd.CommandTimeout = 120;
                AddFilter(cmd, f);
                await using var r = await cmd.ExecuteReaderAsync(inner).ConfigureAwait(false);

                var totals = new SalesTotals(0, 0, 0, 0, 0);
                if (await r.ReadAsync(inner).ConfigureAwait(false))
                    totals = new SalesTotals(r.Int("lines"), r.Dec("amount"), r.Int("clients"), r.Int("patients"), r.Int("days"));

                var byDay = new List<SalesByDay>();
                await r.NextResultAsync(inner).ConfigureAwait(false);
                while (await r.ReadAsync(inner).ConfigureAwait(false))
                    byDay.Add(new SalesByDay(r.GetDateTime(r.GetOrdinal("day")).ToString("yyyy-MM-dd"), r.Int("lines"), r.Dec("amount"), r.Int("patients")));

                var byBu = new List<SalesByBu>();
                await r.NextResultAsync(inner).ConfigureAwait(false);
                while (await r.ReadAsync(inner).ConfigureAwait(false))
                    byBu.Add(new SalesByBu(r.NullableInt("bu_id"), r.Str("bu_code"), r.Str("bu_name"), r.Int("lines"), r.Dec("amount"), r.Int("clients")));

                var byClient = new List<SalesByClient>();
                await r.NextResultAsync(inner).ConfigureAwait(false);
                while (await r.ReadAsync(inner).ConfigureAwait(false))
                    byClient.Add(new SalesByClient(r.Str("client_code"), r.Str("client_name"), r.Int("lines"), r.Dec("amount"), r.Int("patients")));

                var byKind = new List<SalesByKind>();
                await r.NextResultAsync(inner).ConfigureAwait(false);
                while (await r.ReadAsync(inner).ConfigureAwait(false))
                    byKind.Add(new SalesByKind(r.Str("kind") ?? "Test", r.Int("lines"), r.Dec("amount")));

                var byItem = new List<SalesByItem>();
                await r.NextResultAsync(inner).ConfigureAwait(false);
                while (await r.ReadAsync(inner).ConfigureAwait(false))
                    byItem.Add(new SalesByItem(r.Str("kind") ?? "Test", r.Str("code"), r.Str("name"), r.Int("lines"), r.Dec("amount"),
                                               r.Dec("min_rate"), r.Dec("max_rate"), r.Int("clients")));

                var bySource = new List<SalesBySource>();
                await r.NextResultAsync(inner).ConfigureAwait(false);
                while (await r.ReadAsync(inner).ConfigureAwait(false))
                    bySource.Add(new SalesBySource(r.Str("source") ?? "lis", r.Int("lines"), r.Dec("amount")));

                var byIcr = new List<SalesByItemClientRate>();
                await r.NextResultAsync(inner).ConfigureAwait(false);
                while (await r.ReadAsync(inner).ConfigureAwait(false))
                    byIcr.Add(new SalesByItemClientRate(r.Str("kind") ?? "Test", r.Str("code"), r.Str("name"), r.Str("client_code"), r.Str("client_name"),
                                                        r.Dec("rate"), r.Int("lines"), r.Dec("amount")));

                return new SalesSummary(totals, byDay, byBu, byClient, byKind, byItem, bySource, byIcr);
            }, token), ct);
}
