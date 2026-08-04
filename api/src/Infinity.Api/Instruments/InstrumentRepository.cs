using System.Data;
// Admin supplies GetOrdinalDateTimeOffset / GetOrdinalNullableBool;
// Auth supplies GetOrdinalString / GetOrdinalInt32 / GetOrdinalBool.
using Infinity.Api.Admin;
using Infinity.Api.Auth;
using Infinity.Api.Data;
using Microsoft.Data.SqlClient;

namespace Infinity.Api.Instruments;

public sealed class InstrumentRepository(NobleConnectionFactory db)
{
    /// <summary>
    /// Deposit one reading. Not retried: ingestion is non-idempotent and a
    /// retry after an ambiguous timeout would either double-apply or produce a
    /// phantom inbox row. A driver that does not get a response should replay
    /// deliberately, which the inbox supports.
    /// </summary>
    public Task<IngestOutcome> IngestAsync(
        int instrumentId, InstrumentReading reading, string? rawPayload, CancellationToken ct = default) =>
        db.QueryAsync("instrument.ingest", async (conn, inner) =>
        {
            await using var cmd = db.CreateWriteCommand(conn, "dbo.usp_inf_instrument_ingest");
            cmd.Parameters.Add("@instrument_id", SqlDbType.Int).Value = instrumentId;
            cmd.Parameters.Add("@sid", SqlDbType.NVarChar, 50).Value = reading.Sid ?? "";
            cmd.Parameters.Add("@test_code", SqlDbType.NVarChar, 50).Value = reading.TestCode ?? "";
            cmd.Parameters.Add("@value", SqlDbType.NVarChar, 400).Value = (object?)reading.Value ?? DBNull.Value;
            cmd.Parameters.Add("@unit", SqlDbType.NVarChar, 50).Value = (object?)reading.Unit ?? DBNull.Value;
            cmd.Parameters.Add("@flags", SqlDbType.NVarChar, 100).Value = (object?)reading.Flags ?? DBNull.Value;
            cmd.Parameters.Add("@measured_at", SqlDbType.DateTimeOffset).Value = (object?)reading.MeasuredAt ?? DBNull.Value;
            cmd.Parameters.Add("@sequence_no", SqlDbType.NVarChar, 50).Value = (object?)reading.SequenceNo ?? DBNull.Value;
            cmd.Parameters.Add("@raw_payload", SqlDbType.NVarChar, -1).Value = (object?)rawPayload ?? DBNull.Value;

            await using var r = await cmd.ExecuteReaderAsync(CommandBehavior.SingleResult, inner).ConfigureAwait(false);
            if (!await r.ReadAsync(inner).ConfigureAwait(false))
                return new IngestOutcome(0, "rejected", "The procedure returned no result.", null);

            return new IngestOutcome(
                Convert.ToInt64(r.GetValue(r.GetOrdinal("inbox_id"))),
                r.GetString(r.GetOrdinal("match_status")),
                r.IsDBNull(r.GetOrdinal("failure_reason")) ? null : r.GetString(r.GetOrdinal("failure_reason")),
                r.IsDBNull(r.GetOrdinal("result_id")) ? null : r.GetInt32(r.GetOrdinal("result_id")));
        }, ct);

    /// <summary>
    /// Deposit one imported cell. Same procedure, same inbox, same matcher as
    /// an instrument reading — only the source differs. The sequence number is
    /// derived from the batch and cell so re-uploading the same file is caught
    /// as a duplicate rather than applied twice.
    /// </summary>
    public Task<IngestOutcome> IngestImportedAsync(
        Guid batchId,
        string fileName,
        ImportCell cell,
        int importedBy,
        CancellationToken ct = default) =>
        db.QueryAsync("import.ingest", async (conn, inner) =>
        {
            await using var cmd = db.CreateWriteCommand(conn, "dbo.usp_inf_instrument_ingest");
            cmd.Parameters.Add("@instrument_id", SqlDbType.Int).Value = DBNull.Value;
            cmd.Parameters.Add("@sid", SqlDbType.NVarChar, 50).Value = cell.Sid;
            cmd.Parameters.Add("@test_code", SqlDbType.NVarChar, 50).Value = cell.TestCode;
            cmd.Parameters.Add("@value", SqlDbType.NVarChar, 400).Value = cell.Value;
            cmd.Parameters.Add("@unit", SqlDbType.NVarChar, 50).Value = DBNull.Value;
            cmd.Parameters.Add("@flags", SqlDbType.NVarChar, 100).Value = DBNull.Value;
            cmd.Parameters.Add("@measured_at", SqlDbType.DateTimeOffset).Value = DBNull.Value;
            // Content fingerprint, so re-uploading the SAME value for the same
            // sample and analyte is caught as a duplicate, while a corrected
            // value is a genuinely new reading and applies. Hashed rather than
            // concatenated because SID+code+value routinely exceeds 50 chars,
            // and a truncated key would collide two different results.
            cmd.Parameters.Add("@sequence_no", SqlDbType.NVarChar, 50).Value = ContentKey(cell);
            cmd.Parameters.Add("@raw_payload", SqlDbType.NVarChar, -1).Value =
                $"row {cell.RowNumber}: {cell.Sid},{cell.TestCode},{cell.Value}";
            cmd.Parameters.Add("@source", SqlDbType.VarChar, 16).Value = "import";
            cmd.Parameters.Add("@imported_by", SqlDbType.Int).Value = importedBy;
            cmd.Parameters.Add("@batch_id", SqlDbType.UniqueIdentifier).Value = batchId;
            cmd.Parameters.Add("@source_name", SqlDbType.NVarChar, 260).Value = fileName;

            await using var r = await cmd.ExecuteReaderAsync(CommandBehavior.SingleResult, inner).ConfigureAwait(false);
            if (!await r.ReadAsync(inner).ConfigureAwait(false))
                return new IngestOutcome(0, "rejected", "The procedure returned no result.", null);

            return new IngestOutcome(
                Convert.ToInt64(r.GetValue(r.GetOrdinal("inbox_id"))),
                r.GetString(r.GetOrdinal("match_status")),
                r.IsDBNull(r.GetOrdinal("failure_reason")) ? null : r.GetString(r.GetOrdinal("failure_reason")),
                r.IsDBNull(r.GetOrdinal("result_id")) ? null : r.GetInt32(r.GetOrdinal("result_id")));
        }, ct);

    /// <summary>Short stable fingerprint of one imported cell's content.</summary>
    private static string ContentKey(ImportCell cell)
    {
        var bytes = System.Text.Encoding.UTF8.GetBytes(
            $"{cell.Sid.Trim().ToUpperInvariant()}|{cell.TestCode.Trim().ToUpperInvariant()}|{cell.Value.Trim()}");
        return "imp:" + Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(bytes))[..32];
    }

    public Task<IReadOnlyList<Instrument>> ListAsync(CancellationToken ct = default) =>
        db.QueryAsync("instrument.list", async (conn, inner) =>
        {
            await using var cmd = new SqlCommand("dbo.usp_inf_instrument_list", conn)
            {
                CommandType = CommandType.StoredProcedure,
            };

            await using var r = await cmd.ExecuteReaderAsync(CommandBehavior.SingleResult, inner).ConfigureAwait(false);
            var list = new List<Instrument>();
            while (await r.ReadAsync(inner).ConfigureAwait(false))
            {
                list.Add(new Instrument(
                    r.GetOrdinalInt32("id") ?? 0,
                    r.GetOrdinalString("code") ?? "",
                    r.GetOrdinalString("name") ?? "",
                    r.GetOrdinalInt32("department_id"),
                    r.GetOrdinalBool("is_active"),
                    r.GetOrdinalString("api_key_hint"),
                    r.GetOrdinalDateTimeOffset("created_at"),
                    r.GetOrdinalDateTimeOffset("last_seen_at"),
                    r.GetOrdinalInt32("pending") ?? 0,
                    r.GetOrdinalInt32("applied_24h") ?? 0));
            }
            return (IReadOnlyList<Instrument>)list;
        }, ct);

    public Task<UpsertInstrumentResult> UpsertAsync(
        UpsertInstrumentRequest req, string? apiKeyHash, string? hint, int actor, CancellationToken ct = default) =>
        db.QueryAsync("instrument.upsert", async (conn, inner) =>
        {
            await using var cmd = db.CreateWriteCommand(conn, "dbo.usp_inf_instrument_upsert");
            cmd.Parameters.Add("@code", SqlDbType.NVarChar, 20).Value = req.Code;
            cmd.Parameters.Add("@name", SqlDbType.NVarChar, 200).Value = req.Name;
            cmd.Parameters.Add("@apiKeyHash", SqlDbType.NVarChar, 200).Value = (object?)apiKeyHash ?? DBNull.Value;
            cmd.Parameters.Add("@apiKeyHint", SqlDbType.NVarChar, 8).Value = (object?)hint ?? DBNull.Value;
            cmd.Parameters.Add("@departmentId", SqlDbType.Int).Value = (object?)req.DepartmentId ?? DBNull.Value;
            cmd.Parameters.Add("@isActive", SqlDbType.Bit).Value = req.IsActive;
            cmd.Parameters.Add("@actor", SqlDbType.Int).Value = actor;

            await using var r = await cmd.ExecuteReaderAsync(CommandBehavior.SingleResult, inner).ConfigureAwait(false);
            if (!await r.ReadAsync(inner).ConfigureAwait(false))
                return new UpsertInstrumentResult(false, "INTERNAL", "The operation returned no result.", null);

            return new UpsertInstrumentResult(
                r.GetOrdinalBool("ok"),
                r.GetOrdinalString("error_code"),
                r.GetOrdinalString("message"),
                r.GetOrdinalInt32("instrument_id"));
        }, ct);

    public Task<InboxPage> InboxAsync(
        string? status, int? instrumentId, string? sid, int top, CancellationToken ct = default) =>
        db.QueryAsync("instrument.inbox", async (conn, inner) =>
        {
            await using var cmd = new SqlCommand("dbo.usp_inf_instrument_inbox", conn)
            {
                CommandType = CommandType.StoredProcedure,
            };
            cmd.Parameters.Add("@status", SqlDbType.VarChar, 12).Value = (object?)status ?? DBNull.Value;
            cmd.Parameters.Add("@instrumentId", SqlDbType.Int).Value = (object?)instrumentId ?? DBNull.Value;
            cmd.Parameters.Add("@sid", SqlDbType.NVarChar, 50).Value = (object?)sid ?? DBNull.Value;
            cmd.Parameters.Add("@top", SqlDbType.Int).Value = top;

            await using var r = await cmd.ExecuteReaderAsync(CommandBehavior.SingleResult, inner).ConfigureAwait(false);
            var list = new List<InboxMessage>();
            var total = 0;
            while (await r.ReadAsync(inner).ConfigureAwait(false))
            {
                list.Add(new InboxMessage(
                    Convert.ToInt64(r.GetValue(r.GetOrdinal("id"))),
                    r.GetOrdinalInt32("instrument_id") ?? 0,
                    r.GetOrdinalString("instrument_code"),
                    r.GetOrdinalString("sid"),
                    r.GetOrdinalString("test_code"),
                    r.GetOrdinalString("value"),
                    r.GetOrdinalString("unit"),
                    r.GetOrdinalString("flags"),
                    r.GetOrdinalDateTimeOffset("measured_at"),
                    r.GetOrdinalString("sequence_no"),
                    r.GetOrdinalString("parse_status") ?? "",
                    r.GetOrdinalString("match_status") ?? "",
                    r.GetOrdinalString("failure_reason"),
                    r.GetOrdinalInt32("result_id"),
                    r.GetOrdinalDateTimeOffset("received_at") ?? default,
                    r.GetOrdinalDateTimeOffset("applied_at"),
                    r.GetOrdinalInt32("attempts") ?? 0,
                    r.GetOrdinalString("source") ?? "instrument",
                    r.GetOrdinalString("source_name")));
                total = r.GetOrdinalInt32("total_count") ?? total;
            }
            return new InboxPage(list, total);
        }, ct);

    public Task<IngestOutcome> ReplayAsync(long inboxId, int actor, CancellationToken ct = default) =>
        db.QueryAsync("instrument.replay", async (conn, inner) =>
        {
            await using var cmd = db.CreateWriteCommand(conn, "dbo.usp_inf_instrument_replay");
            cmd.Parameters.Add("@inboxId", SqlDbType.BigInt).Value = inboxId;
            cmd.Parameters.Add("@actor", SqlDbType.Int).Value = actor;

            await using var r = await cmd.ExecuteReaderAsync(CommandBehavior.SingleResult, inner).ConfigureAwait(false);
            if (!await r.ReadAsync(inner).ConfigureAwait(false))
                return new IngestOutcome(inboxId, "rejected", "Replay returned no result.", null);

            return new IngestOutcome(
                Convert.ToInt64(r.GetValue(r.GetOrdinal("inbox_id"))),
                r.GetString(r.GetOrdinal("match_status")),
                r.IsDBNull(r.GetOrdinal("failure_reason")) ? null : r.GetString(r.GetOrdinal("failure_reason")),
                r.IsDBNull(r.GetOrdinal("result_id")) ? null : r.GetInt32(r.GetOrdinal("result_id")));
        }, ct);
}
