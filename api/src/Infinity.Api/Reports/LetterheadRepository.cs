using System.Collections.Concurrent;
using System.Data;
using Infinity.Api.Data;
using Infinity.Api.Reads;

namespace Infinity.Api.Reports;

/// <summary>One printable layout for the standard report (inf_letterhead, script 171).</summary>
public sealed record LetterheadProfile(
    int Id,
    string Name,
    /// <summary>'digital' (artwork composited into the PDF) or 'stationery' (pre-printed sheets, nothing composited).</summary>
    string Kind,
    decimal FirstTopMm,
    decimal TopMm,
    decimal BottomMm,
    decimal SideMm,
    decimal NudgeXMm,
    decimal NudgeYMm,
    bool HasArtwork,
    string? ArtworkMime,
    int Version,
    bool IsActive,
    DateTime UpdatedAt,
    IReadOnlyList<string> Clients)
{
    public bool Composites => Kind == "digital" && HasArtwork;
}

public sealed record LetterheadArtwork(byte[] Bytes, string Mime);

/// <summary>The fields an admin edits; any left null keep their value.</summary>
public sealed record LetterheadEdit(
    string? Name = null, string? Kind = null,
    decimal? FirstTopMm = null, decimal? TopMm = null, decimal? BottomMm = null, decimal? SideMm = null,
    decimal? NudgeXMm = null, decimal? NudgeYMm = null);

/// <summary>
/// Letterhead profiles and which client each belongs to.
///
/// Profiles are read on every report download, so each is held for a minute
/// and dropped on any write; the artwork, the heavy part, is held by
/// (id, version) and so never needs invalidating — a new upload is a new
/// version.
/// </summary>
public sealed class LetterheadRepository(NobleConnectionFactory db, SqlRetry retry)
{
    private readonly ConcurrentDictionary<int, (DateTime At, LetterheadProfile? Profile)> _profiles = new();
    private readonly ConcurrentDictionary<(int, int), LetterheadArtwork?> _artwork = new();
    private static readonly TimeSpan Ttl = TimeSpan.FromMinutes(1);

    public static readonly IReadOnlySet<string> ArtworkMimes = new HashSet<string>(StringComparer.Ordinal)
    {
        "application/pdf", "image/png", "image/jpeg",
    };
    public const int MaxArtworkBytes = 8 * 1024 * 1024;

    private const string SelectCols = """
        l.id, l.name, l.kind, l.first_top_mm, l.top_mm, l.bottom_mm, l.side_mm, l.nudge_x_mm, l.nudge_y_mm,
        has_artwork = CAST(CASE WHEN l.artwork IS NULL THEN 0 ELSE 1 END AS BIT), l.artwork_mime,
        l.version, l.is_active, l.updated_at,
        clients = (SELECT STRING_AGG(c.client_code, ',') WITHIN GROUP (ORDER BY c.client_code)
                   FROM dbo.inf_client_letterhead c WHERE c.letterhead_id = l.id)
        """;

    private static LetterheadProfile Read(Microsoft.Data.SqlClient.SqlDataReader r) => new(
        Convert.ToInt32(r["id"]),
        r.Str("name") ?? string.Empty,
        r.Str("kind") ?? "stationery",
        Convert.ToDecimal(r["first_top_mm"]),
        Convert.ToDecimal(r["top_mm"]),
        Convert.ToDecimal(r["bottom_mm"]),
        Convert.ToDecimal(r["side_mm"]),
        Convert.ToDecimal(r["nudge_x_mm"]),
        Convert.ToDecimal(r["nudge_y_mm"]),
        Convert.ToBoolean(r["has_artwork"]),
        r.Str("artwork_mime"),
        Convert.ToInt32(r["version"]),
        Convert.ToBoolean(r["is_active"]),
        Convert.ToDateTime(r["updated_at"]),
        (r.Str("clients") ?? string.Empty).Split(',', StringSplitOptions.RemoveEmptyEntries));

    public Task<IReadOnlyList<LetterheadProfile>> ListAsync(bool activeOnly, CancellationToken ct = default) =>
        retry.ExecuteAsync("letterhead.list", token =>
            db.QueryAsync("letterhead.list", async (conn, inner) =>
            {
                await using var cmd = NobleConnectionFactory.CreateCommand(conn,
                    $"SELECT {SelectCols} FROM dbo.inf_letterhead l {(activeOnly ? "WHERE l.is_active = 1" : "")} ORDER BY l.name");
                var list = new List<LetterheadProfile>();
                await using var r = await cmd.ExecuteReaderAsync(inner).ConfigureAwait(false);
                while (await r.ReadAsync(inner).ConfigureAwait(false)) list.Add(Read(r));
                return (IReadOnlyList<LetterheadProfile>)list;
            }, token), ct);

    public async Task<LetterheadProfile?> GetAsync(int id, CancellationToken ct = default)
    {
        if (_profiles.TryGetValue(id, out var hit) && DateTime.UtcNow - hit.At < Ttl) return hit.Profile;
        var p = await retry.ExecuteAsync("letterhead.get", token =>
            db.QueryAsync("letterhead.get", async (conn, inner) =>
            {
                await using var cmd = NobleConnectionFactory.CreateCommand(conn,
                    $"SELECT {SelectCols} FROM dbo.inf_letterhead l WHERE l.id = @id");
                cmd.Parameters.Add("@id", SqlDbType.Int).Value = id;
                await using var r = await cmd.ExecuteReaderAsync(inner).ConfigureAwait(false);
                return await r.ReadAsync(inner).ConfigureAwait(false) ? Read(r) : null;
            }, token), ct).ConfigureAwait(false);
        _profiles[id] = (DateTime.UtcNow, p);
        return p;
    }

    public async Task<LetterheadArtwork?> GetArtworkAsync(LetterheadProfile p, CancellationToken ct = default)
    {
        if (!p.HasArtwork) return null;
        if (_artwork.TryGetValue((p.Id, p.Version), out var hit)) return hit;
        var art = await retry.ExecuteAsync("letterhead.artwork", token =>
            db.QueryAsync("letterhead.artwork", async (conn, inner) =>
            {
                await using var cmd = NobleConnectionFactory.CreateCommand(conn,
                    "SELECT artwork, artwork_mime FROM dbo.inf_letterhead WHERE id = @id AND artwork IS NOT NULL");
                cmd.Parameters.Add("@id", SqlDbType.Int).Value = p.Id;
                await using var r = await cmd.ExecuteReaderAsync(inner).ConfigureAwait(false);
                if (!await r.ReadAsync(inner).ConfigureAwait(false)) return (LetterheadArtwork?)null;
                return new LetterheadArtwork((byte[])r["artwork"], r.Str("artwork_mime") ?? "application/pdf");
            }, token), ct).ConfigureAwait(false);
        _artwork[(p.Id, p.Version)] = art;
        return art;
    }

    /// <summary>The active profile each of these client codes defaults to.</summary>
    public Task<IReadOnlyDictionary<string, int>> ForClientsAsync(IReadOnlyCollection<string> codes, CancellationToken ct = default)
    {
        if (codes.Count == 0) return Task.FromResult((IReadOnlyDictionary<string, int>)new Dictionary<string, int>());
        return retry.ExecuteAsync("letterhead.for_clients", token =>
            db.QueryAsync("letterhead.for_clients", async (conn, inner) =>
            {
                var names = codes.Select((_, i) => "@c" + i.ToString(System.Globalization.CultureInfo.InvariantCulture)).ToArray();
                await using var cmd = NobleConnectionFactory.CreateCommand(conn, $"""
                    SELECT c.client_code, c.letterhead_id
                    FROM dbo.inf_client_letterhead c
                    JOIN dbo.inf_letterhead l ON l.id = c.letterhead_id AND l.is_active = 1
                    WHERE c.client_code IN ({string.Join(",", names)})
                    """);
                var i = 0;
                foreach (var c in codes) cmd.Parameters.Add(names[i++], SqlDbType.NVarChar, 50).Value = c;
                var map = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
                await using var r = await cmd.ExecuteReaderAsync(inner).ConfigureAwait(false);
                while (await r.ReadAsync(inner).ConfigureAwait(false))
                    map[r.Str("client_code") ?? string.Empty] = Convert.ToInt32(r["letterhead_id"]);
                return (IReadOnlyDictionary<string, int>)map;
            }, token), ct);
    }

    public async Task<int> CreateAsync(string name, string kind, int actor, CancellationToken ct = default)
    {
        // Not retried: a replayed insert is a duplicate profile.
        var id = await db.QueryAsync("letterhead.create", async (conn, inner) =>
            {
                await using var cmd = NobleConnectionFactory.CreateCommand(conn, """
                    INSERT INTO dbo.inf_letterhead (name, kind, updated_by) VALUES (@n, @k, @by);
                    SELECT CAST(SCOPE_IDENTITY() AS INT);
                    """);
                cmd.Parameters.Add("@n", SqlDbType.NVarChar, 120).Value = name;
                cmd.Parameters.Add("@k", SqlDbType.VarChar, 12).Value = kind;
                cmd.Parameters.Add("@by", SqlDbType.Int).Value = actor;
                return Convert.ToInt32(await cmd.ExecuteScalarAsync(inner).ConfigureAwait(false));
            }, ct).ConfigureAwait(false);
        return id;
    }

    public async Task UpdateAsync(int id, LetterheadEdit e, int actor, CancellationToken ct = default)
    {
        await retry.ExecuteAsync("letterhead.update", token =>
            db.QueryAsync("letterhead.update", async (conn, inner) =>
            {
                await using var cmd = NobleConnectionFactory.CreateCommand(conn, """
                    UPDATE dbo.inf_letterhead SET
                        name = COALESCE(@n, name), kind = COALESCE(@k, kind),
                        first_top_mm = COALESCE(@ft, first_top_mm), top_mm = COALESCE(@t, top_mm),
                        bottom_mm = COALESCE(@b, bottom_mm), side_mm = COALESCE(@s, side_mm),
                        nudge_x_mm = COALESCE(@nx, nudge_x_mm), nudge_y_mm = COALESCE(@ny, nudge_y_mm),
                        version = version + 1, updated_by = @by, updated_at = SYSUTCDATETIME()
                    WHERE id = @id;
                    """);
                cmd.Parameters.Add("@id", SqlDbType.Int).Value = id;
                cmd.Parameters.Add("@n", SqlDbType.NVarChar, 120).Value = (object?)e.Name ?? DBNull.Value;
                cmd.Parameters.Add("@k", SqlDbType.VarChar, 12).Value = (object?)e.Kind ?? DBNull.Value;
                foreach (var (name, v) in new[] { ("@ft", e.FirstTopMm), ("@t", e.TopMm), ("@b", e.BottomMm), ("@s", e.SideMm), ("@nx", e.NudgeXMm), ("@ny", e.NudgeYMm) })
                {
                    var p = cmd.Parameters.Add(name, SqlDbType.Decimal);
                    p.Precision = 5; p.Scale = 1;
                    p.Value = (object?)v ?? DBNull.Value;
                }
                cmd.Parameters.Add("@by", SqlDbType.Int).Value = actor;
                await cmd.ExecuteNonQueryAsync(inner).ConfigureAwait(false);
                return 0;
            }, token), ct).ConfigureAwait(false);
        _profiles.TryRemove(id, out _);
    }

    public async Task SetArtworkAsync(int id, byte[]? bytes, string? mime, int actor, CancellationToken ct = default)
    {
        await retry.ExecuteAsync("letterhead.artwork_set", token =>
            db.QueryAsync("letterhead.artwork_set", async (conn, inner) =>
            {
                await using var cmd = NobleConnectionFactory.CreateCommand(conn, """
                    UPDATE dbo.inf_letterhead SET artwork = @a, artwork_mime = @m,
                        version = version + 1, updated_by = @by, updated_at = SYSUTCDATETIME()
                    WHERE id = @id;
                    """);
                cmd.Parameters.Add("@id", SqlDbType.Int).Value = id;
                cmd.Parameters.Add("@a", SqlDbType.VarBinary, -1).Value = (object?)bytes ?? DBNull.Value;
                cmd.Parameters.Add("@m", SqlDbType.VarChar, 40).Value = (object?)mime ?? DBNull.Value;
                cmd.Parameters.Add("@by", SqlDbType.Int).Value = actor;
                await cmd.ExecuteNonQueryAsync(inner).ConfigureAwait(false);
                return 0;
            }, token), ct).ConfigureAwait(false);
        _profiles.TryRemove(id, out _);
    }

    public async Task SetActiveAsync(int id, bool active, int actor, CancellationToken ct = default)
    {
        await retry.ExecuteAsync("letterhead.active", token =>
            db.QueryAsync("letterhead.active", async (conn, inner) =>
            {
                await using var cmd = NobleConnectionFactory.CreateCommand(conn, """
                    UPDATE dbo.inf_letterhead SET is_active = @a, version = version + 1, updated_by = @by, updated_at = SYSUTCDATETIME() WHERE id = @id;
                    """);
                cmd.Parameters.Add("@id", SqlDbType.Int).Value = id;
                cmd.Parameters.Add("@a", SqlDbType.Bit).Value = active;
                cmd.Parameters.Add("@by", SqlDbType.Int).Value = actor;
                await cmd.ExecuteNonQueryAsync(inner).ConfigureAwait(false);
                return 0;
            }, token), ct).ConfigureAwait(false);
        _profiles.TryRemove(id, out _);
    }

    /// <summary>
    /// Makes this profile the default for exactly these client codes: codes
    /// dropped from the list stop pointing at it, and codes that pointed at
    /// another profile move here. Unknown codes are returned, not written.
    /// </summary>
    public async Task<IReadOnlyList<string>> SetClientsAsync(int id, IReadOnlyCollection<string> codes, int actor, CancellationToken ct = default)
    {
        var unknown = await retry.ExecuteAsync("letterhead.clients", token =>
            db.QueryAsync("letterhead.clients", async (conn, inner) =>
            {
                await using var tx = (Microsoft.Data.SqlClient.SqlTransaction)await conn.BeginTransactionAsync(inner).ConfigureAwait(false);
                var known = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                if (codes.Count > 0)
                {
                    var names = codes.Select((_, i) => "@c" + i.ToString(System.Globalization.CultureInfo.InvariantCulture)).ToArray();
                    await using var q = NobleConnectionFactory.CreateCommand(conn,
                        $"SELECT LTRIM(RTRIM(MCCUnitCode)) AS code FROM dbo.tbl_med_mcc_unit_master WHERE LTRIM(RTRIM(MCCUnitCode)) IN ({string.Join(",", names)})");
                    q.Transaction = tx;
                    var i = 0;
                    foreach (var c in codes) q.Parameters.Add(names[i++], SqlDbType.NVarChar, 50).Value = c;
                    await using (var r = await q.ExecuteReaderAsync(inner).ConfigureAwait(false))
                        while (await r.ReadAsync(inner).ConfigureAwait(false)) known.Add(r.Str("code") ?? string.Empty);
                }
                await using (var del = NobleConnectionFactory.CreateCommand(conn, "DELETE FROM dbo.inf_client_letterhead WHERE letterhead_id = @id"))
                {
                    del.Transaction = tx;
                    del.Parameters.Add("@id", SqlDbType.Int).Value = id;
                    await del.ExecuteNonQueryAsync(inner).ConfigureAwait(false);
                }
                foreach (var c in known)
                {
                    await using var up = NobleConnectionFactory.CreateCommand(conn, """
                        MERGE dbo.inf_client_letterhead AS t USING (SELECT @c AS client_code) AS s ON t.client_code = s.client_code
                        WHEN MATCHED THEN UPDATE SET letterhead_id = @id, updated_by = @by, updated_at = SYSUTCDATETIME()
                        WHEN NOT MATCHED THEN INSERT (client_code, letterhead_id, updated_by) VALUES (@c, @id, @by);
                        """);
                    up.Transaction = tx;
                    up.Parameters.Add("@c", SqlDbType.NVarChar, 50).Value = c;
                    up.Parameters.Add("@id", SqlDbType.Int).Value = id;
                    up.Parameters.Add("@by", SqlDbType.Int).Value = actor;
                    await up.ExecuteNonQueryAsync(inner).ConfigureAwait(false);
                }
                await tx.CommitAsync(inner).ConfigureAwait(false);
                return (IReadOnlyList<string>)codes.Where(c => !known.Contains(c)).ToList();
            }, token), ct).ConfigureAwait(false);
        _profiles.Clear();
        return unknown;
    }
}
