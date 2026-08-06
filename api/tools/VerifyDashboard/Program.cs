using Infinity.Api.Data;
using Infinity.Api.Reads;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

/*
 * Exercises MonthStatsRepository against the live database.
 *
 * The SQL can be checked by hand; the READER cannot. That command returns five
 * result sets consumed in a fixed order, and getting the order or a column name
 * wrong does not throw — NextResult past the end just leaves an empty list, and
 * the dashboard renders "Nothing billed this month" over a month that billed
 * three hundred thousand rupees. A compile proves nothing about any of it.
 *
 * Usage, from api/:
 *     dotnet run --project tools/VerifyDashboard
 *     dotnet run --project tools/VerifyDashboard -- 2026-07
 *
 * Read-only.
 */

LoadDotEnv(Path.Combine(FindApiRoot() ?? ".", ".env"));

var options = Options.Create(new NobleOptions
{
    Server = Env("Noble__Server") ?? "",
    Database = Env("Noble__Database") ?? "Noble",
    User = Env("Noble__User") ?? "",
    Password = Env("Noble__Password") ?? "",
    Encrypt = Env("Noble__Encrypt") is not "false",
    TrustServerCertificate = Env("Noble__TrustServerCertificate") is "true",
    ApplicationName = "InfinityVerifyDashboard",
});

using var loggerFactory = LoggerFactory.Create(b => b.SetMinimumLevel(LogLevel.Warning));
var factory = new NobleConnectionFactory(options, loggerFactory.CreateLogger<NobleConnectionFactory>());
var retry = new SqlRetry(loggerFactory.CreateLogger<SqlRetry>());
var repo = new MonthStatsRepository(factory, retry);

var failures = 0;
void Check(string label, bool ok, string detail)
{
    Console.WriteLine($"  {(ok ? "PASS" : "FAIL")}  {label}: {detail}");
    if (!ok) failures++;
}

// An admin's scope. Above ScopeFilter.UnrestrictedThreshold the IN-list is
// dropped entirely, so this exercises the unrestricted branch — the one an
// administrator actually hits.
var wide = await AllMccAsync();
var month = args.FirstOrDefault(a => !a.StartsWith("--", StringComparison.Ordinal));

Console.WriteLine($"[1] month stats over {wide.Count} centres" + (month is null ? " (current month)" : $" for {month}"));

var started = System.Diagnostics.Stopwatch.StartNew();
var m = await repo.GetAsync(wide, month);
started.Stop();

Console.WriteLine($"        {m.Month} through {m.Through}, in {started.ElapsedMilliseconds} ms");

// The dashboard loads on every sign-in. A month query that creeps past a few
// seconds is a regression even when the numbers are right.
Check("completed inside 10s", started.ElapsedMilliseconds < 10_000, $"{started.ElapsedMilliseconds} ms");

Check("headline read", m.Bills > 0 || m.Revenue == 0,
    $"{m.Bills} bills, revenue {m.Revenue}");

// The specific failure this tool exists for: a misordered NextResult leaves
// these empty while the headline still looks healthy.
Check("top clients populated when bills exist", m.Bills == 0 || m.TopClients.Count > 0,
    $"{m.TopClients.Count} rows");
Check("top tests populated when bills exist", m.Bills == 0 || m.TopTests.Count > 0,
    $"{m.TopTests.Count} rows");

Check("no board exceeds its cap",
    m.TopClients.Count <= 10 && m.TopTests.Count <= 10 && m.TopPayers.Count <= 10,
    $"{m.TopClients.Count}/{m.TopTests.Count}/{m.TopPayers.Count}");

// A board whose codes are all "—" means the column name is wrong and Str()
// returned null for every row — which renders as a plausible-looking list.
Check("client codes actually read", m.TopClients.Count == 0 || m.TopClients.All(r => r.Code != "—"),
    m.TopClients.Count == 0 ? "no rows" : string.Join(", ", m.TopClients.Take(3).Select(r => r.Code)));
Check("test names actually read", m.TopTests.Count == 0 || m.TopTests.Any(r => !string.IsNullOrWhiteSpace(r.Name)),
    m.TopTests.Count == 0 ? "no rows" : m.TopTests[0].Name ?? "null");

Check("top clients are sorted by value descending",
    m.TopClients.Zip(m.TopClients.Skip(1)).All(p => p.First.Amount >= p.Second.Amount),
    string.Join(" ≥ ", m.TopClients.Take(3).Select(r => r.Amount)));
Check("top tests are sorted by volume descending",
    m.TopTests.Zip(m.TopTests.Skip(1)).All(p => p.First.Count >= p.Second.Count),
    string.Join(" ≥ ", m.TopTests.Take(3).Select(r => r.Count)));

// The leaderboard is a subset of the same month, so it cannot exceed it.
// Catches a board accidentally scanning a wider range than the headline.
Check("top clients sum does not exceed month revenue",
    m.TopClients.Sum(r => r.Amount) <= m.Revenue,
    $"{m.TopClients.Sum(r => r.Amount)} vs {m.Revenue}");
Check("centres billed is at least the number of boarded clients",
    m.ActiveClients >= m.TopClients.Count,
    $"{m.ActiveClients} active vs {m.TopClients.Count} on the board");

// The whole reason LabSales exists. Order billing covers Telo and Infinity
// only; if the two are ever equal, either the lab has stopped billing through
// LISTEC or — far more likely — the sales query has silently started reading
// the wrong table.
Check("lab sales is at least order billing", m.LabSalesMonth >= m.Revenue,
    $"lab {m.LabSalesMonth:N0} vs order {m.Revenue:N0}");
Check("the day's sales fit inside the month's", m.LabSalesDay <= m.LabSalesMonth,
    $"{m.LabSalesDay:N0} of {m.LabSalesMonth:N0}");

Console.WriteLine();
Console.WriteLine($"        LAB SALES {m.LabSalesMonth:N0} month · {m.LabSalesDay:N0} on {m.Through}");
Console.WriteLine($"        order billing {m.Revenue:N0} " +
                  $"({(m.LabSalesMonth > 0 ? m.Revenue / m.LabSalesMonth * 100 : 0):N1}% of lab sales)");
Console.WriteLine($"        collected {m.Collected:N0} · outstanding {m.Outstanding:N0}");
Console.WriteLine($"        {m.ActiveClients} centres billed · {m.ReferringDoctors} referring doctors · {m.Registrations} registrations");
foreach (var r in m.TopClients.Take(3)) Console.WriteLine($"        client  {r.Code,-12} {r.Amount,12:N0}  ({r.Count} bills)");
foreach (var r in m.TopTests.Take(3)) Console.WriteLine($"        test    {r.Code,-12} {r.Count,12:N0}  {r.Name}");

// ---- [2] fail closed --------------------------------------------------------
//
// The single most dangerous bug this class can have. An empty scope must mean
// no data, never all data.
Console.WriteLine();
Console.WriteLine("[2] a user with no centres");
var none = await repo.GetAsync([]);
Check("returns nothing rather than everything",
    none.Bills == 0 && none.Revenue == 0 && none.TopClients.Count == 0 && none.TopTests.Count == 0,
    $"{none.Bills} bills, {none.TopClients.Count} clients, {none.TopTests.Count} tests");

// ---- [3] a single narrow scope ----------------------------------------------
//
// Exercises the IN-list branch, which the admin path above skips entirely.
if (wide.Count > 0)
{
    Console.WriteLine();
    var one = m.TopClients.Count > 0 ? await MccByCodeAsync(m.TopClients[0].Code) : null;
    if (one is null)
    {
        Console.WriteLine("  SKIP  no single centre to narrow to");
    }
    else
    {
        Console.WriteLine($"[3] scoped to one centre ({m.TopClients[0].Code})");
        var narrow = await repo.GetAsync([one.Value], month);
        Check("revenue is no greater than the whole lab's", narrow.Revenue <= m.Revenue,
            $"{narrow.Revenue} vs {m.Revenue}");
        Check("board holds only that centre",
            narrow.TopClients.All(r => r.Code == m.TopClients[0].Code),
            string.Join(", ", narrow.TopClients.Select(r => r.Code)));
        Check("at most one centre counted as active", narrow.ActiveClients <= 1,
            narrow.ActiveClients.ToString());
    }
}

// ---- [4] a month that has not happened --------------------------------------
Console.WriteLine();
Console.WriteLine("[4] a future month");
var future = await repo.GetAsync(wide, "2099-01");
Check("falls back to the current month rather than reporting an empty future",
    future.Month.StartsWith(DateTime.UtcNow.AddMinutes(330).ToString("yyyy-MM"), StringComparison.Ordinal),
    future.Month);

Console.WriteLine();
Console.WriteLine(failures == 0 ? "All checks passed." : $"{failures} check(s) FAILED.");
return failures == 0 ? 0 : 1;

// -----------------------------------------------------------------------------

async Task<IReadOnlyList<int>> AllMccAsync() =>
    await factory.QueryAsync("verify.allmcc", async (conn, ct) =>
    {
        await using var cmd = NobleConnectionFactory.CreateCommand(conn,
            "SELECT id FROM dbo.tbl_med_mcc_unit_master");
        await using var r = await cmd.ExecuteReaderAsync(ct).ConfigureAwait(false);
        var ids = new List<int>();
        while (await r.ReadAsync(ct).ConfigureAwait(false)) ids.Add(r.GetInt32(0));
        return (IReadOnlyList<int>)ids;
    }, default);

async Task<int?> MccByCodeAsync(string code) =>
    await factory.QueryAsync("verify.mccbycode", async (conn, ct) =>
    {
        await using var cmd = NobleConnectionFactory.CreateCommand(conn,
            "SELECT TOP 1 id FROM dbo.tbl_med_mcc_unit_master WHERE MCCUnitCode = @c");
        cmd.Parameters.AddWithValue("@c", code);
        var v = await cmd.ExecuteScalarAsync(ct).ConfigureAwait(false);
        return v is null or DBNull ? (int?)null : Convert.ToInt32(v);
    }, default);

static string? Env(string key) =>
    Environment.GetEnvironmentVariable(key) is { Length: > 0 } v ? v : null;

static void LoadDotEnv(string path)
{
    if (!File.Exists(path)) return;

    foreach (var raw in File.ReadAllLines(path))
    {
        var line = raw.Trim();
        if (line.Length == 0 || line.StartsWith('#')) continue;

        var eq = line.IndexOf('=');
        if (eq <= 0) continue;

        if (Environment.GetEnvironmentVariable(line[..eq].Trim()) is null or "")
            Environment.SetEnvironmentVariable(line[..eq].Trim(), line[(eq + 1)..].Trim().Trim('"'));
    }
}

static string? FindApiRoot()
{
    var dir = new DirectoryInfo(Directory.GetCurrentDirectory());
    while (dir is not null)
    {
        if (Directory.Exists(Path.Combine(dir.FullName, "db", "sql"))) return dir.FullName;
        if (Directory.Exists(Path.Combine(dir.FullName, "api", "db", "sql"))) return Path.Combine(dir.FullName, "api");
        dir = dir.Parent;
    }
    return null;
}
