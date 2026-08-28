using System.Data;
using Infinity.Api.Data;
using Infinity.Api.Reads;
using Microsoft.Data.SqlClient;

namespace Infinity.Api.Orders;

public sealed record MrfItem(int Id, string Name, decimal Price, string? Unit);

public sealed record MrfLine(
    string ItemName, int OrderQty, int? ApprovedQty, int? IssuedQty,
    decimal Rate, string? DocketNumber, DateTimeOffset? IssuedAt);

public sealed record MrfRequest(
    int Id, DateTimeOffset? OrderedAt,
    /// <summary>1 open · 2 approved · 3 dispatched · 4 cancelled — the LIS's
    /// own vocabulary, carried as-is so the two platforms agree about state.</summary>
    int Status, string? ApprovedBy, IReadOnlyList<MrfLine> Lines);

public sealed record HelpRequest(
    int Id, int Mcc, string? ClientCode, string Category, string Subject, string? Detail,
    string Status, string? Response, string? RespondedBy, string? RaisedBy,
    DateTimeOffset? CreatedAt, DateTimeOffset? UpdatedAt);

public sealed record RequestResult(bool Ok, string? ErrorCode, string? Message, int? Id);

/// <summary>
/// The two client request channels.
///
/// MRF reads and writes the LIS's OWN inventory tables through the 132
/// procedures — the storekeeper's approval and dispatch workflow lives in the
/// legacy app and must keep seeing every request wherever it was typed.
/// Help requests are Infinity-native (see 133 for why the legacy storage was
/// not worth being compatible with).
/// </summary>
public sealed class ClientRequestRepository(NobleConnectionFactory db, SqlRetry retry)
{
    // ---- the consumables catalogue ------------------------------------------

    public Task<IReadOnlyList<MrfItem>> CatalogueAsync(CancellationToken ct = default) =>
        retry.ExecuteAsync("mrf.catalogue", token =>
            db.QueryAsync("mrf.catalogue", async (conn, inner) =>
            {
                await using var cmd = NobleConnectionFactory.CreateCommand(conn, """
                    SELECT p.id, p.product_name, price = ISNULL(p.price, 0), p.unitofmeasure
                    FROM dbo.tbl_inventory_vendor_product_master p
                    WHERE p.vendor_code = 1 AND ISNULL(p.isactive, 1) = 1
                    ORDER BY p.product_name;
                    """);
                var rows = new List<MrfItem>();
                await using var r = await cmd.ExecuteReaderAsync(CommandBehavior.SingleResult, inner).ConfigureAwait(false);
                while (await r.ReadAsync(inner).ConfigureAwait(false))
                {
                    rows.Add(new MrfItem(
                        r.Int("id"),
                        r.Str("product_name")?.Trim() ?? "",
                        r.Dec("price"),
                        r.Str("unitofmeasure")?.Trim()));
                }
                return (IReadOnlyList<MrfItem>)rows;
            }, token), ct);

    // ---- material requests ---------------------------------------------------

    public Task<IReadOnlyList<MrfRequest>> ListMrfAsync(int mcc, CancellationToken ct = default) =>
        retry.ExecuteAsync("mrf.list", token =>
            db.QueryAsync("mrf.list", async (conn, inner) =>
            {
                await using var cmd = NobleConnectionFactory.CreateCommand(conn, """
                    SELECT TOP (200)
                        m.id, m.order_date, m.order_status, m.approved_by,
                        item_name = ISNULL(p.product_name, CONCAT('Item #', f.item_code)),
                        f.order_qty, f.approved_qty, f.issued_qty,
                        rate = ISNULL(f.item_rate, 0),
                        f.docket_number, f.issued_date
                    FROM dbo.tbl_inventory_client_request_master m
                    LEFT JOIN dbo.tbl_inventory_client_request_form f ON f.request_id = m.id
                    LEFT JOIN dbo.tbl_inventory_vendor_product_master p ON p.id = f.item_code
                    WHERE m.pcc_id = @mcc
                    ORDER BY m.id DESC, f.id;
                    """);
                cmd.Parameters.Add("@mcc", SqlDbType.Int).Value = mcc;

                var byId = new Dictionary<int, (MrfRequest Req, List<MrfLine> Lines)>();
                var order = new List<int>();
                await using var r = await cmd.ExecuteReaderAsync(CommandBehavior.SingleResult, inner).ConfigureAwait(false);
                while (await r.ReadAsync(inner).ConfigureAwait(false))
                {
                    var id = r.Int("id");
                    if (!byId.TryGetValue(id, out var entry))
                    {
                        var lines = new List<MrfLine>();
                        entry = (new MrfRequest(
                            id,
                            Domain.NobleTime.ToIst(r.Date("order_date")),
                            r.NullableInt("order_status") ?? 1,
                            r.Str("approved_by")?.Trim(),
                            lines), lines);
                        byId[id] = entry;
                        order.Add(id);
                    }
                    if (r.Str("item_name") is { } itemName)
                    {
                        entry.Lines.Add(new MrfLine(
                            itemName,
                            r.NullableInt("order_qty") ?? 0,
                            r.NullableInt("approved_qty"),
                            r.NullableInt("issued_qty"),
                            r.Dec("rate"),
                            r.Str("docket_number")?.Trim(),
                            Domain.NobleTime.ToIst(r.Date("issued_date"))));
                    }
                }
                return (IReadOnlyList<MrfRequest>)order.Select(id => byId[id].Req).ToList();
            }, token), ct);

    public Task<RequestResult> CreateMrfAsync(int mcc, int userId, string itemsJson, CancellationToken ct = default) =>
        db.QueryAsync("mrf.create", async (conn, inner) =>
        {
            await using var cmd = db.CreateWriteCommand(conn, "dbo.usp_inf_mrf_create");
            cmd.Parameters.Add("@mcc", SqlDbType.Int).Value = mcc;
            cmd.Parameters.Add("@userId", SqlDbType.Int).Value = userId;
            cmd.Parameters.Add("@itemsJson", SqlDbType.NVarChar, -1).Value = itemsJson;
            return await ReadResultAsync(cmd, inner).ConfigureAwait(false);
        }, ct);

    public Task<RequestResult> CancelMrfAsync(int mcc, int userId, int id, CancellationToken ct = default) =>
        db.QueryAsync("mrf.cancel", async (conn, inner) =>
        {
            await using var cmd = db.CreateWriteCommand(conn, "dbo.usp_inf_mrf_cancel");
            cmd.Parameters.Add("@mcc", SqlDbType.Int).Value = mcc;
            cmd.Parameters.Add("@userId", SqlDbType.Int).Value = userId;
            cmd.Parameters.Add("@id", SqlDbType.Int).Value = id;
            return await ReadResultAsync(cmd, inner).ConfigureAwait(false);
        }, ct);

    // ---- help requests -------------------------------------------------------

    /// <param name="mcc">Null lists every centre's — the LAB's view.</param>
    public Task<IReadOnlyList<HelpRequest>> ListHelpAsync(int? mcc, CancellationToken ct = default) =>
        retry.ExecuteAsync("help.list", token =>
            db.QueryAsync("help.list", async (conn, inner) =>
            {
                await using var cmd = NobleConnectionFactory.CreateCommand(conn, """
                    SELECT TOP (200)
                        h.id, h.mcc, u.MCCUnitCode AS client_code, h.category, h.subject, h.detail,
                        h.status, h.response,
                        responded_by = NULLIF(LTRIM(RTRIM(CONCAT(ru.firstname, ' ', ru.lastname))), ''),
                        raised_by = NULLIF(LTRIM(RTRIM(CONCAT(cu.firstname, ' ', cu.lastname))), ''),
                        h.created_at, h.updated_at
                    FROM dbo.inf_help_request h
                    LEFT JOIN dbo.tbl_med_mcc_unit_master u ON u.id = h.mcc
                    LEFT JOIN dbo.tbl_med_user_master ru ON ru.id = h.responded_by
                    LEFT JOIN dbo.tbl_med_user_master cu ON cu.id = h.user_id
                    WHERE (@mcc IS NULL OR h.mcc = @mcc)
                    ORDER BY CASE WHEN h.status = 'closed' THEN 1 ELSE 0 END, h.id DESC;
                    """);
                cmd.Parameters.Add("@mcc", SqlDbType.Int).Value = (object?)mcc ?? DBNull.Value;

                var rows = new List<HelpRequest>();
                await using var r = await cmd.ExecuteReaderAsync(CommandBehavior.SingleResult, inner).ConfigureAwait(false);
                while (await r.ReadAsync(inner).ConfigureAwait(false))
                {
                    rows.Add(new HelpRequest(
                        r.Int("id"), r.Int("mcc"), r.Str("client_code")?.Trim(),
                        r.Str("category") ?? "general",
                        r.Str("subject") ?? "", r.Str("detail"),
                        r.Str("status") ?? "open", r.Str("response"),
                        r.Str("responded_by"), r.Str("raised_by"),
                        Domain.NobleTime.ToIst(r.Date("created_at")),
                        Domain.NobleTime.ToIst(r.Date("updated_at"))));
                }
                return (IReadOnlyList<HelpRequest>)rows;
            }, token), ct);

    public Task<RequestResult> CreateHelpAsync(
        int mcc, int userId, string category, string subject, string? detail, CancellationToken ct = default) =>
        db.QueryAsync("help.create", async (conn, inner) =>
        {
            await using var cmd = NobleConnectionFactory.CreateCommand(conn, """
                INSERT INTO dbo.inf_help_request (mcc, user_id, category, subject, detail)
                OUTPUT INSERTED.id
                VALUES (@mcc, @user, @cat, @subject, @detail);
                """);
            cmd.Parameters.Add("@mcc", SqlDbType.Int).Value = mcc;
            cmd.Parameters.Add("@user", SqlDbType.Int).Value = userId;
            cmd.Parameters.Add("@cat", SqlDbType.VarChar, 20).Value = category;
            cmd.Parameters.Add("@subject", SqlDbType.NVarChar, 200).Value = subject;
            cmd.Parameters.Add("@detail", SqlDbType.NVarChar, 2000).Value = (object?)detail ?? DBNull.Value;
            var id = Convert.ToInt32(await cmd.ExecuteScalarAsync(inner).ConfigureAwait(false));
            return new RequestResult(true, null, null, id);
        }, ct);

    /// <summary>
    /// A status/response change. The CLIENT may close its own ticket (nothing
    /// else); the LAB may set any status and attach a response. The caller
    /// decides which of those it is enforcing; @mcc scopes the client path.
    /// </summary>
    public Task<RequestResult> UpdateHelpAsync(
        int id, int? mcc, string status, string? response, int? respondedBy, CancellationToken ct = default) =>
        db.QueryAsync("help.update", async (conn, inner) =>
        {
            await using var cmd = NobleConnectionFactory.CreateCommand(conn, """
                UPDATE dbo.inf_help_request
                SET status = @status,
                    response = COALESCE(@response, response),
                    responded_by = COALESCE(@by, responded_by),
                    updated_at = SYSDATETIME()
                WHERE id = @id AND (@mcc IS NULL OR mcc = @mcc);
                SELECT @@ROWCOUNT;
                """);
            cmd.Parameters.Add("@id", SqlDbType.Int).Value = id;
            cmd.Parameters.Add("@mcc", SqlDbType.Int).Value = (object?)mcc ?? DBNull.Value;
            cmd.Parameters.Add("@status", SqlDbType.VarChar, 20).Value = status;
            cmd.Parameters.Add("@response", SqlDbType.NVarChar, 2000).Value = (object?)response ?? DBNull.Value;
            cmd.Parameters.Add("@by", SqlDbType.Int).Value = (object?)respondedBy ?? DBNull.Value;
            var n = Convert.ToInt32(await cmd.ExecuteScalarAsync(inner).ConfigureAwait(false));
            return n == 1
                ? new RequestResult(true, null, null, id)
                : new RequestResult(false, "NOT_FOUND", "No such request for this centre.", null);
        }, ct);

    private static async Task<RequestResult> ReadResultAsync(SqlCommand cmd, CancellationToken ct)
    {
        await using var r = await cmd.ExecuteReaderAsync(CommandBehavior.SingleResult, ct).ConfigureAwait(false);
        if (!await r.ReadAsync(ct).ConfigureAwait(false))
            return new RequestResult(false, "NO_RESULT", "The procedure returned nothing.", null);
        int? id = null;
        for (var i = 0; i < r.FieldCount; i++)
            if (r.GetName(i) == "id" && !r.IsDBNull(i)) id = r.GetInt32(i);
        return new RequestResult(r.Bool("ok"), r.Str("error_code"), r.Str("message"), id);
    }
}
