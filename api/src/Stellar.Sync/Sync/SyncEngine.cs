using Microsoft.Data.SqlClient;
using Npgsql;

namespace Stellar.Sync;

/// <summary>
/// Snapshot then tail, per table.
///
/// The two phases are separated by a version number, and getting that boundary
/// right is the whole correctness argument:
///
///   1. Read CHANGE_TRACKING_CURRENT_VERSION() and remember it.
///   2. Bulk-copy the table. Writes happening DURING this are not lost — they
///      are recorded by Change Tracking against versions above the mark.
///   3. Tail from the remembered version. The overlap is re-applied, which is
///      harmless because every apply is an idempotent upsert keyed on
///      noble_id.
///
/// Reading the version AFTER the snapshot instead would open a window in which
/// a change is neither in the copy nor in the tail — a permanent, silent hole.
/// Reading it before costs a few redundant upserts and cannot lose anything.
/// </summary>
internal sealed class SyncEngine(
    string nobleConn,
    string pgConn,
    ILogger<SyncEngine> log)
{
    private const int SnapshotBatch = 5_000;
    private const int ChangeBatch = 5_000;

    /// <summary>
    /// What one pass did. <paramref name="Failures"/> is what a scripted
    /// <c>--once</c> run has to see: a pass keeps going when a table throws, so
    /// the process exits 0 either way and a wrapper reading only the exit code
    /// would call a pass that applied nothing a success — as one did on
    /// 2026-08-23, reporting "load finished OK" for a result snapshot that had
    /// failed on its first batch.
    /// </summary>
    public sealed record SyncOutcome(int Rows, int Failures);

    public async Task<SyncOutcome> RunAsync(IReadOnlyList<TableSync> tables, CancellationToken ct)
    {
        await using var sql = new SqlConnection(nobleConn);
        await sql.OpenAsync(ct);
        await using var pg = new NpgsqlConnection(pgConn);
        await pg.OpenAsync(ct);

        var total = 0;
        var failures = 0;
        foreach (var t in tables)
        {
            ct.ThrowIfCancellationRequested();
            try
            {
                total += await SyncTableAsync(sql, pg, t, ct);
                await ClearErrorAsync(pg, t.NobleTable, ct);
            }
            catch (Exception ex)
            {
                // One table failing must not stop the rest: a mapper bug on a
                // rarely-used table should not stall the clinical core.
                log.LogError(ex, "sync failed for {Table}", t.NobleTable);
                await RecordErrorAsync(pg, t.NobleTable, ex.Message, ct);
                failures++;
            }
        }

        // After every cycle, not inside any table's Apply. See Resolver for why
        // — doing it per-table left 3,590 rows permanently unresolved when
        // their parent table failed on the run that loaded them.
        await Resolver.RunAsync(pg, log, ct);

        return new SyncOutcome(total, failures);
    }

    private async Task<int> SyncTableAsync(
        SqlConnection sql, NpgsqlConnection pg, TableSync t, CancellationToken ct)
    {
        var (lastVersion, snapshotDone) = await ReadWatermarkAsync(pg, t.NobleTable, ct);

        if (!snapshotDone)
        {
            var mark = await ScalarLongAsync(sql, "SELECT CHANGE_TRACKING_CURRENT_VERSION()", ct);
            log.LogInformation("{Table}: snapshot starting at CT version {Version}", t.NobleTable, mark);
            var copied = await SnapshotAsync(sql, pg, t, ct);
            await CompleteSnapshotAsync(pg, t.NobleTable, mark, copied, ct);
            log.LogInformation("{Table}: snapshot complete, {Rows} rows", t.NobleTable, copied);
            return copied;
        }

        return await TailAsync(sql, pg, t, lastVersion, ct);
    }

    // ---- phase 1: snapshot ---------------------------------------------------

    private async Task<int> SnapshotAsync(
        SqlConnection sql, NpgsqlConnection pg, TableSync t, CancellationToken ct)
    {
        int? afterId = null;
        var copied = 0;

        // Keyset pagination, not OFFSET: OFFSET re-scans everything it skips,
        // so a 68M-row table would spend most of the load re-reading its own
        // prefix. Ordering by the PK and remembering the last id is O(1) per
        // page.
        while (true)
        {
            var batch = new List<Dictionary<string, object?>>(SnapshotBatch);
            await using (var cmd = new SqlCommand(t.SnapshotSql(afterId, SnapshotBatch), sql))
            {
                cmd.CommandTimeout = 600;
                cmd.Parameters.AddWithValue("@batch", SnapshotBatch);
                if (afterId is not null) cmd.Parameters.AddWithValue("@afterId", afterId.Value);

                await using var r = await cmd.ExecuteReaderAsync(ct);
                while (await r.ReadAsync(ct)) batch.Add(SqlReaderMap.Row(r));
            }

            if (batch.Count == 0) break;

            await t.Apply(pg, batch, ct);
            copied += batch.Count;
            afterId = Conv.ToInt(batch[^1][t.KeyColumns[0]]);
            if (afterId is null) break;   // unkeyed row: cannot page further

            if (copied % 50_000 == 0) log.LogInformation("{Table}: {Rows} rows", t.NobleTable, copied);
        }
        return copied;
    }

    // ---- phase 2: tail -------------------------------------------------------

    private async Task<int> TailAsync(
        SqlConnection sql, NpgsqlConnection pg, TableSync t, long since, CancellationToken ct)
    {
        // THE GUARD THAT MAKES A GAP IMPOSSIBLE.
        //
        // Change Tracking keeps 7 days. If this service was down longer, Noble
        // has already discarded the versions in between and there is no way to
        // know what changed. Refusing loudly is the only correct response —
        // carrying on would leave the replica permanently, silently wrong.
        var minValid = await ScalarLongAsync(sql,
            $"SELECT CHANGE_TRACKING_MIN_VALID_VERSION(OBJECT_ID('dbo.{t.NobleTable}'))", ct);

        if (since < minValid)
        {
            throw new InvalidOperationException(
                $"{t.NobleTable}: watermark {since} is older than the retention floor {minValid}. " +
                "Changes have been discarded by Change Tracking; this table needs a re-snapshot " +
                "(clear snapshot_completed_at in sync_watermark).");
        }

        /*
         * Captured BEFORE the changes query, and it is what an EMPTY poll
         * advances the watermark to. A table that never changes never used to
         * move its watermark at all, so after seven quiet days it fell below
         * the retention floor and tripped the gap guard above — for changes
         * that never existed. Two lookup tables (sample_master and the sample
         * status master) died exactly this way in the first week; every other
         * slow mover was days from joining them. Advancing to a version read
         * before the query is safe by construction: any change committed
         * after the capture has a higher version and is still discoverable
         * from the new watermark.
         */
        var current = await ScalarLongAsync(sql, "SELECT CHANGE_TRACKING_CURRENT_VERSION()", ct);

        var upserts = new List<Dictionary<string, object?>>(ChangeBatch);
        var deletes = new List<int>();
        long maxVersion = since;

        await using (var cmd = new SqlCommand(t.ChangesSql(), sql))
        {
            cmd.CommandTimeout = 600;
            cmd.Parameters.AddWithValue("@since", since);

            await using var r = await cmd.ExecuteReaderAsync(ct);
            while (await r.ReadAsync(ct))
            {
                var row = SqlReaderMap.Row(r);
                maxVersion = Math.Max(maxVersion, Convert.ToInt64(row["__version"]));

                var op = row["__op"]?.ToString();
                var key = Conv.ToInt(row["__key"]);

                // 'D', or an operation whose base row is gone: both are
                // deletes. The second case is why the join is LEFT — a row
                // inserted and deleted between two polls arrives as an update
                // with nothing behind it.
                if (op == "D" || row["id"] is null)
                {
                    if (key is not null) deletes.Add(key.Value);
                }
                else
                {
                    upserts.Add(row);
                }
            }
        }

        if (upserts.Count == 0 && deletes.Count == 0)
        {
            // Quiet is not stuck: the watermark rides the current version so
            // the retention window can never close over this table.
            await AdvanceQuietAsync(pg, t.NobleTable, current, ct);
            return 0;
        }

        // Upserts before deletes. The reverse order would resurrect a row that
        // was updated and then deleted within the same window.
        if (upserts.Count > 0) await t.Apply(pg, upserts, ct);
        if (deletes.Count > 0) await t.Delete(pg, deletes, ct);

        await AdvanceWatermarkAsync(pg, t.NobleTable, maxVersion, upserts.Count + deletes.Count, ct);
        log.LogInformation("{Table}: {Up} upserts, {Del} deletes, now at version {V}",
            t.NobleTable, upserts.Count, deletes.Count, maxVersion);

        return upserts.Count + deletes.Count;
    }

    // ---- watermark bookkeeping ----------------------------------------------

    private static async Task<(long version, bool snapshotDone)> ReadWatermarkAsync(
        NpgsqlConnection pg, string table, CancellationToken ct)
    {
        await using var cmd = new NpgsqlCommand(
            "SELECT last_version, snapshot_completed_at IS NOT NULL FROM stellar.sync_watermark WHERE noble_table = @t", pg);
        cmd.Parameters.AddWithValue("@t", table);
        await using var r = await cmd.ExecuteReaderAsync(ct);
        if (!await r.ReadAsync(ct)) return (0, false);
        return (r.GetInt64(0), r.GetBoolean(1));
    }

    private static async Task CompleteSnapshotAsync(
        NpgsqlConnection pg, string table, long version, int rows, CancellationToken ct)
    {
        await using var cmd = new NpgsqlCommand("""
            UPDATE stellar.sync_watermark
            SET last_version = @v, snapshot_completed_at = now(), last_polled_at = now(),
                rows_applied = rows_applied + @n, last_error = NULL, last_error_at = NULL,
                updated_at = now()
            WHERE noble_table = @t
            """, pg);
        cmd.Parameters.AddWithValue("@t", table);
        cmd.Parameters.AddWithValue("@v", version);
        cmd.Parameters.AddWithValue("@n", (long)rows);
        await cmd.ExecuteNonQueryAsync(ct);
    }

    private static async Task AdvanceWatermarkAsync(
        NpgsqlConnection pg, string table, long version, int rows, CancellationToken ct)
    {
        await using var cmd = new NpgsqlCommand("""
            UPDATE stellar.sync_watermark
            SET last_version = @v, last_polled_at = now(), last_change_at = now(),
                rows_applied = rows_applied + @n, updated_at = now()
            WHERE noble_table = @t
            """, pg);
        cmd.Parameters.AddWithValue("@t", table);
        cmd.Parameters.AddWithValue("@v", version);
        cmd.Parameters.AddWithValue("@n", (long)rows);
        await cmd.ExecuteNonQueryAsync(ct);
    }

    /// <summary>
    /// An empty poll's bookkeeping: the watermark advances (see the capture
    /// note in TailAsync) but last_change_at does NOT — that column answers
    /// "when did this table last actually change", and a quiet poll is not a
    /// change. GREATEST() so a concurrent non-empty pass can never be walked
    /// backwards by a slower quiet one.
    /// </summary>
    private static async Task AdvanceQuietAsync(
        NpgsqlConnection pg, string table, long version, CancellationToken ct)
    {
        await using var cmd = new NpgsqlCommand("""
            UPDATE stellar.sync_watermark
            SET last_version = GREATEST(last_version, @v), last_polled_at = now(), updated_at = now()
            WHERE noble_table = @t
            """, pg);
        cmd.Parameters.AddWithValue("@t", table);
        cmd.Parameters.AddWithValue("@v", version);
        await cmd.ExecuteNonQueryAsync(ct);
    }

    private static async Task RecordErrorAsync(
        NpgsqlConnection pg, string table, string message, CancellationToken ct)
    {
        await using var cmd = new NpgsqlCommand("""
            UPDATE stellar.sync_watermark
            SET last_error = @e, last_error_at = now(), last_polled_at = now()
            WHERE noble_table = @t
            """, pg);
        cmd.Parameters.AddWithValue("@t", table);
        cmd.Parameters.AddWithValue("@e", message.Length > 2000 ? message[..2000] : message);
        await cmd.ExecuteNonQueryAsync(ct);
    }

    private static async Task ClearErrorAsync(NpgsqlConnection pg, string table, CancellationToken ct)
    {
        await using var cmd = new NpgsqlCommand(
            "UPDATE stellar.sync_watermark SET last_error = NULL, last_error_at = NULL WHERE noble_table = @t AND last_error IS NOT NULL", pg);
        cmd.Parameters.AddWithValue("@t", table);
        await cmd.ExecuteNonQueryAsync(ct);
    }

    private static async Task<long> ScalarLongAsync(SqlConnection sql, string text, CancellationToken ct)
    {
        await using var cmd = new SqlCommand(text, sql);
        var v = await cmd.ExecuteScalarAsync(ct);
        return v is null or DBNull ? 0 : Convert.ToInt64(v);
    }
}
