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

    public static async Task RunAsync(
        NpgsqlConnection conn,
        string table,
        string[] columns,
        IReadOnlyList<object?[]> rows,
        CancellationToken ct)
    {
        if (rows.Count == 0) return;

        var perStatement = Math.Max(1, MaxParameters / columns.Length);
        if (rows.Count > perStatement)
        {
            for (var offset = 0; offset < rows.Count; offset += perStatement)
            {
                var slice = rows.Skip(offset).Take(perStatement).ToList();
                await RunAsync(conn, table, columns, slice, ct).ConfigureAwait(false);
            }
            return;
        }

        var cols = string.Join(", ", columns);
        var updates = string.Join(", ",
            columns.Skip(1).Select(c => $"{c} = EXCLUDED.{c}"));

        var sql = new System.Text.StringBuilder(256 + rows.Count * columns.Length * 8);
        sql.Append("INSERT INTO stellar.").Append(table).Append(" (").Append(cols).Append(") VALUES ");

        await using var cmd = new NpgsqlCommand { Connection = conn };

        for (var r = 0; r < rows.Count; r++)
        {
            if (r > 0) sql.Append(',');
            sql.Append('(');
            for (var c = 0; c < columns.Length; c++)
            {
                if (c > 0) sql.Append(',');
                var p = $"@p{r}_{c}";
                sql.Append(p);
                cmd.Parameters.AddWithValue(p, rows[r][c] ?? DBNull.Value);
            }
            sql.Append(')');
        }

        sql.Append(" ON CONFLICT (noble_id) DO UPDATE SET ").Append(updates)
           .Append(", updated_at = now()");

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
