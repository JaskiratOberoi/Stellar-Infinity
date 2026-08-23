using Npgsql;

namespace Stellar.Sync;

/// <summary>
/// Batch upsert into a stellar table, keyed on <c>noble_id</c>.
///
/// One multi-row INSERT ... ON CONFLICT per batch rather than a statement per
/// row: at 68M result rows the round-trip cost dominates everything else, and
/// a single statement also means one transaction boundary per batch instead of
/// per row.
///
/// <para>
/// Written as a generic builder rather than eighteen hand-written upserts.
/// Hand-written ones drift from their SELECT lists — the exact failure this
/// pipeline has to avoid, because a drifted column is invisible until someone
/// reads a value that was never being copied.
/// </para>
/// </summary>
internal static class Upsert
{
    /// <summary>
    /// Upsert <paramref name="rows"/> into <paramref name="table"/>.
    ///
    /// <paramref name="columns"/> is the stellar column list; each row supplies
    /// values in the same order. Column 0 MUST be <c>noble_id</c> — it is the
    /// conflict target and the sync's identity for the row.
    ///
    /// Every non-key column is overwritten on conflict. `created_at` is
    /// deliberately NOT in the update set: it records when the replica first
    /// saw the row, and an update must not keep pushing it forward.
    /// </summary>
    /// <summary>
    /// Postgres allows at most 65535 bound parameters in one statement, and the
    /// limit is on PARAMETERS, not rows — so the safe batch size depends on how
    /// wide the table is. Found the hard way: centre is 21 columns, and 3,620
    /// rows in one statement is 76,020 parameters. Deriving the chunk from the
    /// column count means a wide table cannot reintroduce the bug later.
    /// </summary>
    private const int MaxParameters = 65_000;   // headroom under the 65535 cap

    /// <summary>
    /// Rows per statement, independent of the parameter cap.
    ///
    /// The parameter limit alone is not enough. A statement with 65,000
    /// parameters is legal and catastrophically slow — Postgres has to parse
    /// and plan a query string hundreds of kilobytes long, and the bill
    /// snapshot (31 columns, so 2,096 rows fitted the cap) simply timed out.
    /// A thousand rows keeps each statement small enough to plan quickly while
    /// still amortising the round trip.
    /// </summary>
    private const int MaxRowsPerStatement = 1_000;

    /// <param name="conflict">
    /// Conflict target, defaulting to <c>noble_id</c>. A PARTITIONED table
    /// needs its partition key here too: Postgres requires a unique index to
    /// back ON CONFLICT, and on a partitioned table every unique index must
    /// include the partition column — so `result` conflicts on
    /// <c>(noble_id, created_at)</c>, which only works because its created_at
    /// comes from Noble's addeddate and is therefore stable across re-syncs.
    /// Were it now(), every update would land as a new row in a new partition.
    /// </param>
    /// <param name="conflictWhere">
    /// The predicate of a PARTIAL unique index, when that is what backs the
    /// conflict target. Postgres will not infer a partial index from the column
    /// list alone — it fails with 42P10, "no unique or exclusion constraint
    /// matching the ON CONFLICT specification" — so the index's own WHERE has
    /// to be repeated here for it to be found.
    ///
    /// Only `result` needs it: every other synced table has a plain unique
    /// index on noble_id, which is why the first attempt at the 68M-row load
    /// was the first time this was discovered.
    /// </param>
    public static async Task RunAsync(
        NpgsqlConnection conn,
        string table,
        string[] columns,
        IReadOnlyList<object?[]> rows,
        CancellationToken ct,
        string conflict = "noble_id",
        string? conflictWhere = null)
    {
        if (rows.Count == 0) return;

        var perStatement = Math.Min(MaxRowsPerStatement,
                                    Math.Max(1, MaxParameters / columns.Length));
        if (rows.Count > perStatement)
        {
            for (var offset = 0; offset < rows.Count; offset += perStatement)
            {
                var slice = rows.Skip(offset).Take(perStatement).ToList();
                await RunAsync(conn, table, columns, slice, ct, conflict, conflictWhere).ConfigureAwait(false);
            }
            return;
        }

        var cols = string.Join(", ", columns);
        var updates = string.Join(", ",
            columns.Skip(1).Select(c => $"{c} = EXCLUDED.{c}"));

        var sql = new System.Text.StringBuilder(256 + rows.Count * columns.Length * 8);
        sql.Append("INSERT INTO stellar.").Append(table).Append(" (").Append(cols).Append(") VALUES ");

        await using var cmd = new NpgsqlCommand { Connection = conn, CommandTimeout = 300 };

        for (var r = 0; r < rows.Count; r++)
        {
            if (r > 0) sql.Append(',');
            sql.Append('(');
            for (var c = 0; c < columns.Length; c++)
            {
                if (c > 0) sql.Append(',');
                var p = $"@p{r}_{c}";
                sql.Append(p);
                var v = rows[r][c];

                // Strings go as UNKNOWN, not as text.
                //
                // Several target columns are not text: sex, age_unit,
                // write_origin and ledger_direction are enums, and code columns
                // are citext. A parameter typed as text makes Postgres refuse
                // ("column is of type sex but expression is of type text")
                // because there is no implicit cast from text to an enum.
                // Sending it untyped lets the server coerce the literal to
                // whatever the column actually is — the same thing that makes
                // a plain SQL literal work.
                if (v is string s)
                {
                    cmd.Parameters.Add(new NpgsqlParameter(p, NpgsqlTypes.NpgsqlDbType.Unknown) { Value = s });
                }
                else
                {
                    cmd.Parameters.AddWithValue(p, v ?? DBNull.Value);
                }
            }
            sql.Append(')');
        }

        sql.Append(" ON CONFLICT (").Append(conflict).Append(')');
        if (conflictWhere is not null) sql.Append(" WHERE ").Append(conflictWhere);
        sql.Append(" DO UPDATE SET ").Append(updates).Append(", updated_at = now()");

        cmd.CommandText = sql.ToString();
        await cmd.ExecuteNonQueryAsync(ct).ConfigureAwait(false);
    }

    /// <summary>
    /// Resolve a Noble foreign key to a stellar surrogate id, inline.
    ///
    /// The sync loads tables in dependency order, so the parent is normally
    /// already present and this is a plain lookup. It returns NULL rather than
    /// failing when it is not: Noble has no foreign keys on several of these
    /// columns and genuinely contains references to rows that do not exist. A
    /// sync that refused those rows would replicate less than the LIS holds.
    /// </summary>
    public static string Lookup(string parentTable, string nobleIdParam) =>
        $"(SELECT id FROM stellar.{parentTable} WHERE noble_id = {nobleIdParam})";

    /// <summary>Mark rows deleted in Noble as gone from the replica.</summary>
    public static async Task DeleteAsync(
        NpgsqlConnection conn, string table, IReadOnlyList<int> nobleIds, CancellationToken ct)
    {
        if (nobleIds.Count == 0) return;
        await using var cmd = new NpgsqlCommand(
            $"DELETE FROM stellar.{table} WHERE noble_id = ANY(@ids)", conn);
        cmd.Parameters.AddWithValue("@ids", nobleIds.ToArray());
        await cmd.ExecuteNonQueryAsync(ct).ConfigureAwait(false);
    }
}
