using Stellar.Sync;

/*
 * stellar-sync — Noble → stellar replication.
 *
 *   dotnet run --project src/Stellar.Sync -- --once
 *
 * Configuration, from environment or api/.env (the same Noble__* variables the
 * API already uses, plus Stellar__ConnectionString):
 *
 *   Noble__Server / Noble__Database / Noble__User / Noble__Password
 *   Stellar__ConnectionString   default: the local replica on 5435
 *   Stellar__IntervalSeconds    default: 15
 *
 * --once runs a single pass and exits, which is what the bootstrap and any
 * verification wants. Without it the worker loops.
 */

var once = args.Contains("--once");

/*
 * Which tables to run.
 *
 *   (default)     masters + clinical + billing
 *   --masters     the reference tables only
 *   --billing     bills, lines, receipts, ledger
 *   --clinical    registrations, samples, ordered tests, events
 *   --result      the 68M-row result table, ON ITS OWN
 *
 * `result` is excluded from the default set deliberately. Its initial snapshot
 * is measured in hours, and it should be a decision someone makes rather than
 * something a routine `--once` starts by surprise. After that first load it
 * tails like everything else and belongs in the default set.
 */
var groups = new List<TableSync>();
if (args.Contains("--masters")) groups.AddRange(MasterTables.All);
if (args.Contains("--clinical")) groups.AddRange(ClinicalTables.All);
if (args.Contains("--billing")) groups.AddRange(BillingTables.All);
if (args.Contains("--result")) groups.Add(ClinicalTables.Result);
if (groups.Count == 0)
{
    groups.AddRange(MasterTables.All);
    groups.AddRange(ClinicalTables.All);
    groups.AddRange(BillingTables.All);
}
IReadOnlyList<TableSync> tables = groups;

var builder = Host.CreateApplicationBuilder(args);

// api/.env is the same file the API reads. Loaded by hand because the worker
// host has no notion of it and duplicating credentials into a second file is
// how the two drift apart.
var envPath = Path.Combine(AppContext.BaseDirectory, "../../../../../.env");
if (!File.Exists(envPath)) envPath = "/x/Stellar-Infinity/api/.env";
if (File.Exists(envPath))
{
    foreach (var line in File.ReadAllLines(envPath))
    {
        var t = line.Trim();
        if (t.Length == 0 || t.StartsWith('#') || !t.Contains('=')) continue;
        var i = t.IndexOf('=');
        var key = t[..i].Trim().TrimStart('﻿');
        if (Environment.GetEnvironmentVariable(key) is null)
        {
            Environment.SetEnvironmentVariable(key, t[(i + 1)..].Trim());
        }
    }
}
builder.Configuration.AddEnvironmentVariables();

var cfg = builder.Configuration;

string Req(string key) => cfg[key]
    ?? throw new InvalidOperationException($"{key} is not configured.");

var nobleConn = new Microsoft.Data.SqlClient.SqlConnectionStringBuilder
{
    DataSource = Req("Noble:Server"),
    InitialCatalog = Req("Noble:Database"),
    UserID = Req("Noble:User"),
    Password = Req("Noble:Password"),
    TrustServerCertificate = true,
    Encrypt = string.Equals(cfg["Noble:Encrypt"], "true", StringComparison.OrdinalIgnoreCase),
    // The snapshot reads millions of rows; the default 30s is not the right
    // budget for that and a timeout mid-load wastes the whole pass.
    ConnectTimeout = 30,
    CommandTimeout = 600,
    ApplicationName = "stellar-sync",
}.ConnectionString;

var pgConn = cfg["Stellar:ConnectionString"]
    ?? "Host=127.0.0.1;Port=5435;Database=stellar;Username=stellar;Password=stellar_dev";

var interval = int.TryParse(cfg["Stellar:IntervalSeconds"], out var s) ? s : 15;

builder.Services.AddSingleton(sp => new SyncEngine(
    nobleConn, pgConn, sp.GetRequiredService<ILogger<SyncEngine>>()));

if (once)
{
    using var host = builder.Build();
    var engine = host.Services.GetRequiredService<SyncEngine>();
    var logger = host.Services.GetRequiredService<ILogger<Program>>();

    logger.LogInformation("stellar-sync: single pass over {N} tables", tables.Count);
    var n = await engine.RunAsync(tables, CancellationToken.None);
    logger.LogInformation("stellar-sync: {Rows} rows applied", n);
    return;
}

builder.Services.AddHostedService(sp => new SyncWorker(
    sp.GetRequiredService<SyncEngine>(),
    sp.GetRequiredService<ILogger<SyncWorker>>(), tables,
    TimeSpan.FromSeconds(interval)));

await builder.Build().RunAsync();

/// <summary>
/// The poll loop. One pass at a time, never overlapping: a pass that runs long
/// (a snapshot, say) must not have a second pass start behind it and fight for
/// the same watermark.
/// </summary>
internal sealed class SyncWorker(SyncEngine engine, ILogger<SyncWorker> log, IReadOnlyList<TableSync> tables, TimeSpan interval)
    : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        log.LogInformation("stellar-sync started, polling every {Interval}", interval);
        using var timer = new PeriodicTimer(interval);

        do
        {
            try
            {
                await engine.RunAsync(tables, stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                // Never let the loop die: a transient Noble outage must resolve
                // itself when the database comes back, not need a restart.
                log.LogError(ex, "sync pass failed; continuing");
            }
        }
        while (await timer.WaitForNextTickAsync(stoppingToken));
    }
}
