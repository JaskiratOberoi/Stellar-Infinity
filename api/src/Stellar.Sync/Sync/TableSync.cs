using Microsoft.Data.SqlClient;
using Npgsql;

namespace Stellar.Sync;

/// <summary>
/// One Noble table's sync definition.
///
/// The snapshot query and the change query are deliberately built from the SAME
/// <see cref="SelectList"/>. The alternative — two hand-written queries per
/// table — is the classic way a sync rots: the bulk load and the tail disagree
/// about a column, and the divergence only shows up months later on rows that
/// happened to change.
///
/// <para>
/// Change Tracking gives us the PRIMARY KEY of what changed and nothing else,
/// so every apply re-reads the current row from Noble by that key. That is the
/// central trade against CDC: intermediate states within one poll interval
/// collapse into the latest value. For a replica that is correct — the audit
/// trail of who changed what lives in inf_result_audit, not here.
/// </para>
/// </summary>
internal sealed class TableSync
{
    /// <summary>Noble table, unqualified. Also the sync_watermark key.</summary>
    public required string NobleTable { get; init; }

    /// <summary>Noble's PK column. Composite keys are handled by KeyColumns.</summary>
    public required string[] KeyColumns { get; init; }

    /// <summary>
    /// Columns to read, already aliased to the names <see cref="Apply"/> expects.
    /// </summary>
    public required string SelectList { get; init; }

    /// <summary>Optional FROM/JOIN tail, for the few tables needing a lookup.</summary>
    public string FromClause { get; init; } = "";

    /// <summary>
    /// Upserts one batch into Postgres. Receives rows already materialised —
    /// the reader is not held open across the write, because holding a SQL
    /// Server reader while talking to Postgres keeps a Noble transaction alive
    /// for the duration of a network round trip.
    /// </summary>
    public required Func<NpgsqlConnection, IReadOnlyList<Dictionary<string, object?>>, CancellationToken, Task> Apply { get; init; }

    /// <summary>
    /// Deletes, applied separately. Change Tracking reports a delete with only
    /// the key populated, so there is no row to map — just a noble_id to
    /// resolve.
    /// </summary>
    public required Func<NpgsqlConnection, IReadOnlyList<int>, CancellationToken, Task> Delete { get; init; }

    // ---- query construction -------------------------------------------------

    /// <summary>Full-table read for the initial snapshot.</summary>
    public string SnapshotSql(int? afterId, int batchSize) =>
        $"""
         SELECT TOP (@batch) {SelectList}
         FROM dbo.{NobleTable} AS t {FromClause}
         {(afterId is null ? "" : $"WHERE t.{KeyColumns[0]} > @afterId")}
         ORDER BY t.{KeyColumns[0]}
         """;

    /// <summary>
    /// Changes since a version.
    ///
    /// LEFT JOIN, not INNER: a row that was inserted and then deleted between
    /// polls appears in CHANGETABLE with no surviving base row. An inner join
    /// would silently drop it and the replica would keep a row Noble no longer
    /// has. The join being outer is what lets the caller see a NULL base row
    /// and treat it as a delete.
    /// </summary>
    public string ChangesSql() =>
        $"""
         SELECT ct.SYS_CHANGE_OPERATION AS __op,
                ct.SYS_CHANGE_VERSION   AS __version,
                ct.{KeyColumns[0]}      AS __key,
                {SelectList}
         FROM CHANGETABLE(CHANGES dbo.{NobleTable}, @since) AS ct
         LEFT JOIN dbo.{NobleTable} AS t ON t.{KeyColumns[0]} = ct.{KeyColumns[0]}
         {FromClause}
         ORDER BY ct.SYS_CHANGE_VERSION
         """;
}

internal static class SqlReaderMap
{
    /// <summary>
    /// Materialise the current row into a plain dictionary.
    ///
    /// Deliberately untyped: the mappers know their own columns, and a typed
    /// row class per table would be 18 near-identical files whose only job is
    /// to be kept in step with a SELECT list.
    /// </summary>
    public static Dictionary<string, object?> Row(SqlDataReader r)
    {
        var row = new Dictionary<string, object?>(r.FieldCount, StringComparer.OrdinalIgnoreCase);
        for (var i = 0; i < r.FieldCount; i++)
        {
            row[r.GetName(i)] = r.IsDBNull(i) ? null : r.GetValue(i);
        }
        return row;
    }
}
