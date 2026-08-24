using System.Data;
using Infinity.Api.Data;
using Infinity.Api.Reads;
using Microsoft.Data.SqlClient;

namespace Infinity.Api.Orders;

/// <summary>A draft as the list draws it — everything but the payload.</summary>
public sealed record OrderDraft(
    int Id, int Mcc, string? PatientName, int Total, int Tubes, int Sids,
    string? LastError, DateTimeOffset? UpdatedAt);

/// <summary>
/// The queue of orders typed but not yet booked — see
/// 130_table_inf_order_draft.sql for why Infinity keeps its own rather than
/// writing into the LIS's temp_ tables.
///
/// Every method takes the caller's user id and every procedure filters on it.
/// A draft is private to its author, and an id belonging to someone else
/// simply does not match.
/// </summary>
public sealed class OrderDraftRepository(NobleConnectionFactory db, SqlRetry retry)
{
    /// <summary>The caller's queue for one client, oldest first.</summary>
    public Task<IReadOnlyList<OrderDraft>> ListAsync(
        int userId, int mcc, CancellationToken ct = default) =>
        retry.ExecuteAsync("draft.list", token =>
            db.QueryAsync("draft.list", async (conn, inner) =>
            {
                await using var cmd = NobleConnectionFactory.CreateCommand(conn, "dbo.usp_inf_order_draft_list");
                cmd.CommandType = CommandType.StoredProcedure;
                cmd.Parameters.Add("@user_id", SqlDbType.Int).Value = userId;
                cmd.Parameters.Add("@mcc_code", SqlDbType.Int).Value = mcc;

                var list = new List<OrderDraft>();
                await using var r = await cmd.ExecuteReaderAsync(inner).ConfigureAwait(false);
                while (await r.ReadAsync(inner).ConfigureAwait(false))
                {
                    list.Add(new OrderDraft(
                        r.GetInt32(r.GetOrdinal("id")),
                        r.GetInt32(r.GetOrdinal("mcc_code")),
                        r.Str("patient_name"),
                        r.GetInt32(r.GetOrdinal("total")),
                        r.GetInt32(r.GetOrdinal("tubes")),
                        r.GetInt32(r.GetOrdinal("sids")),
                        r.Str("last_error"),
                        r.Date("updated_at") is DateTime u
                            ? new DateTimeOffset(DateTime.SpecifyKind(u, DateTimeKind.Unspecified),
                                                 TimeSpan.FromMinutes(330))
                            : null));
                }
                return (IReadOnlyList<OrderDraft>)list;
            }, token), ct);

    /// <summary>One draft's stored request body, to load back into the form.</summary>
    public Task<string?> GetPayloadAsync(int userId, int id, CancellationToken ct = default) =>
        retry.ExecuteAsync("draft.get", token =>
            db.QueryAsync("draft.get", async (conn, inner) =>
            {
                await using var cmd = NobleConnectionFactory.CreateCommand(conn, "dbo.usp_inf_order_draft_get");
                cmd.CommandType = CommandType.StoredProcedure;
                cmd.Parameters.Add("@user_id", SqlDbType.Int).Value = userId;
                cmd.Parameters.Add("@id", SqlDbType.Int).Value = id;

                await using var r = await cmd.ExecuteReaderAsync(inner).ConfigureAwait(false);
                return await r.ReadAsync(inner).ConfigureAwait(false) ? r.Str("payload") : null;
            }, token), ct);

    /// <summary>Insert, or update when <paramref name="id"/> is given.</summary>
    public Task<(bool Ok, string? Error, int? Id)> SaveAsync(
        int userId, int mcc, string payload, string? patientName,
        int total, int tubes, int sids, int? id, CancellationToken ct = default) =>
        retry.ExecuteAsync("draft.save", token =>
            db.QueryAsync("draft.save", async (conn, inner) =>
            {
                await using var cmd = NobleConnectionFactory.CreateCommand(conn, "dbo.usp_inf_order_draft_save");
                cmd.CommandType = CommandType.StoredProcedure;
                cmd.Parameters.Add("@user_id", SqlDbType.Int).Value = userId;
                cmd.Parameters.Add("@mcc_code", SqlDbType.Int).Value = mcc;
                cmd.Parameters.Add("@payload", SqlDbType.NVarChar, -1).Value = payload;
                cmd.Parameters.Add("@patient_name", SqlDbType.NVarChar, 200).Value =
                    (object?)patientName ?? DBNull.Value;
                cmd.Parameters.Add("@total", SqlDbType.Int).Value = total;
                cmd.Parameters.Add("@tubes", SqlDbType.Int).Value = tubes;
                cmd.Parameters.Add("@sids", SqlDbType.Int).Value = sids;
                cmd.Parameters.Add("@id", SqlDbType.Int).Value = (object?)id ?? DBNull.Value;

                await using var r = await cmd.ExecuteReaderAsync(inner).ConfigureAwait(false);
                if (!await r.ReadAsync(inner).ConfigureAwait(false)) return (false, "No response.", (int?)null);

                var ok = r.GetBoolean(r.GetOrdinal("ok"));
                return (ok, ok ? null : r.Str("message"), r.NullableInt("id"));
            }, token), ct);

    public Task<bool> DeleteAsync(int userId, int id, CancellationToken ct = default) =>
        retry.ExecuteAsync("draft.delete", token =>
            db.QueryAsync("draft.delete", async (conn, inner) =>
            {
                await using var cmd = NobleConnectionFactory.CreateCommand(conn, "dbo.usp_inf_order_draft_delete");
                cmd.CommandType = CommandType.StoredProcedure;
                cmd.Parameters.Add("@user_id", SqlDbType.Int).Value = userId;
                cmd.Parameters.Add("@id", SqlDbType.Int).Value = id;

                await using var r = await cmd.ExecuteReaderAsync(inner).ConfigureAwait(false);
                return await r.ReadAsync(inner).ConfigureAwait(false) && r.GetBoolean(0);
            }, token), ct);

    /// <summary>Record why a submission left this draft behind.</summary>
    public Task MarkFailedAsync(int userId, int id, string error, CancellationToken ct = default) =>
        retry.ExecuteAsync("draft.fail", token =>
            db.QueryAsync("draft.fail", async (conn, inner) =>
            {
                await using var cmd = NobleConnectionFactory.CreateCommand(conn, "dbo.usp_inf_order_draft_fail");
                cmd.CommandType = CommandType.StoredProcedure;
                cmd.Parameters.Add("@user_id", SqlDbType.Int).Value = userId;
                cmd.Parameters.Add("@id", SqlDbType.Int).Value = id;
                cmd.Parameters.Add("@error", SqlDbType.NVarChar, 500).Value =
                    error.Length > 500 ? error[..500] : error;
                await cmd.ExecuteNonQueryAsync(inner).ConfigureAwait(false);
                return true;
            }, token), ct);
}
