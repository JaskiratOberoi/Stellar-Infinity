using System.Data;
using Infinity.Api.Data;
using Infinity.Api.Reads;

namespace Infinity.Api.Reports;

/// <summary>
/// The lab-wide switches for what the standard report prints
/// (inf_report_setting, script 168), held in memory.
///
/// One instance for the process: loaded once at start-up, re-read on every
/// save, so a report or a PDF never waits on the table. The PDF cache key
/// carries <see cref="Fingerprint"/>, which changes with every save — so a
/// switch flipped in the morning is in the next download, not in a cached
/// one from the night before. The print page reads the same values through
/// a public route: it draws with no session when the renderer drives it.
/// </summary>
public sealed class ReportSettings(NobleConnectionFactory db, SqlRetry retry, ILogger<ReportSettings> logger)
    : IHostedService
{
    private readonly SemaphoreSlim _gate = new(1, 1);
    private volatile bool _loaded;

    /// <summary>"Reading this thyroid profile" under a thyroid profile's rows.</summary>
    public bool ThyroidFigure { get; private set; } = true;

    /// <summary>"Reading this CBC" under a Complete Blood Count's rows.</summary>
    public bool CbcFigure { get; private set; } = true;

    /// <summary>
    /// The Trending report — each analyte's earlier visits as bands and
    /// columns — on the standard report and in the Smart Report. Off by
    /// default; the web additionally shows it only on a staging build while
    /// it is under test.
    /// </summary>
    public bool Trending { get; private set; }

    /// <summary>
    /// Infinity's own per-test interpretation texts (inf_test_interpretation,
    /// script 175) on reports. Off by default; the report procedure prints
    /// them on the review centre ZZTEST01 regardless, so a draft is approved
    /// on test reports before any real report shows it.
    /// </summary>
    public bool TestInterpretation { get; private set; }

    /// <summary>What the PDF cache key carries for the switches; changes with every save.</summary>
    public static string Fingerprint { get; private set; } = "t1r0i0c1";

    public const string ThyroidFigureKey = "thyroid_figure";
    public const string CbcFigureKey = "cbc_figure";
    public const string TrendingKey = "trending_report";
    public const string TestInterpretationKey = "test_interpretation";

    public Task StartAsync(CancellationToken ct) => EnsureLoadedAsync(ct);
    public Task StopAsync(CancellationToken ct) => Task.CompletedTask;

    public async Task EnsureLoadedAsync(CancellationToken ct = default)
    {
        if (_loaded) return;
        await _gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            if (_loaded) return;
            await LoadAsync(ct).ConfigureAwait(false);
            _loaded = true;
        }
        catch (Exception ex) when (!ct.IsCancellationRequested)
        {
            // A start-up without the table (a fresh stack before script 168)
            // keeps the defaults and tries again on the next read.
            logger.LogWarning(ex, "Report settings could not be loaded; using defaults until the next read.");
        }
        finally { _gate.Release(); }
    }

    private async Task LoadAsync(CancellationToken ct)
    {
        var map = await retry.ExecuteAsync("settings.report.get", token =>
            db.QueryAsync("settings.report.get", async (conn, inner) =>
            {
                await using var cmd = NobleConnectionFactory.CreateCommand(conn,
                    "SELECT [key], value FROM dbo.inf_report_setting");
                var m = new Dictionary<string, string>(StringComparer.Ordinal);
                await using var r = await cmd.ExecuteReaderAsync(inner).ConfigureAwait(false);
                while (await r.ReadAsync(inner).ConfigureAwait(false))
                    m[r.Str("key") ?? string.Empty] = r.Str("value") ?? string.Empty;
                return (IReadOnlyDictionary<string, string>)m;
            }, token), ct).ConfigureAwait(false);
        Apply(map);
    }

    private void Apply(IReadOnlyDictionary<string, string> map)
    {
        ThyroidFigure = !map.TryGetValue(ThyroidFigureKey, out var v) || v.Trim() != "0";
        Trending = map.TryGetValue(TrendingKey, out var tr) && tr.Trim() == "1";
        TestInterpretation = map.TryGetValue(TestInterpretationKey, out var ti) && ti.Trim() == "1";
        CbcFigure = !map.TryGetValue(CbcFigureKey, out var cb) || cb.Trim() != "0";
        Fingerprint = $"t{(ThyroidFigure ? 1 : 0)}r{(Trending ? 1 : 0)}i{(TestInterpretation ? 1 : 0)}c{(CbcFigure ? 1 : 0)}";
    }

    /// <summary>Saves one switch and re-reads them all.</summary>
    public async Task SetAsync(string key, string value, int actorId, CancellationToken ct = default)
    {
        await retry.ExecuteAsync("settings.report.set", token =>
            db.QueryAsync("settings.report.set", async (conn, inner) =>
            {
                await using var cmd = NobleConnectionFactory.CreateCommand(conn, """
                    MERGE dbo.inf_report_setting AS t
                    USING (SELECT @k AS [key]) AS s ON t.[key] = s.[key]
                    WHEN MATCHED THEN UPDATE SET value = @v, updated_by = @by, updated_at = SYSUTCDATETIME()
                    WHEN NOT MATCHED THEN INSERT ([key], value, updated_by) VALUES (@k, @v, @by);
                    """);
                cmd.Parameters.Add("@k", SqlDbType.NVarChar, 50).Value = key;
                cmd.Parameters.Add("@v", SqlDbType.NVarChar, 200).Value = value;
                cmd.Parameters.Add("@by", SqlDbType.Int).Value = actorId;
                await cmd.ExecuteNonQueryAsync(inner).ConfigureAwait(false);
                return 0;
            }, token), ct).ConfigureAwait(false);
        await _gate.WaitAsync(ct).ConfigureAwait(false);
        try { await LoadAsync(ct).ConfigureAwait(false); _loaded = true; }
        finally { _gate.Release(); }
    }
}
