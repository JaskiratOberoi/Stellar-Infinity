using Infinity.Api.Data;
using Infinity.Api.Orders;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

/*
 * Exercises the invoice branding read — the stored procedure AND the tri-state
 * resolution on top of it — against the live database.
 *
 * The resolution is the part worth testing. on_behalf_mode, show_disclaimer and
 * show_signatory are all nullable, and NULL means "not decided", not "off". Two
 * of about three and a half thousand centres have a config row at all, so the
 * NULL path IS the production path: if it resolved to false the disclaimer
 * saying tests have been BILLED rather than performed would vanish from very
 * nearly every invoice the lab prints. That is not a defect a compile can find,
 * and it is not one anybody notices by looking at a document that appears fine.
 *
 * Usage, from api/:
 *     dotnet run --project tools/VerifyInvoice
 *     dotnet run --project tools/VerifyInvoice -- <mcc-id>   # also probe one centre
 *
 * Read-only. Configuration comes from api/.env, same as the deploy tool.
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
    ApplicationName = "InfinityVerifyInvoice",
});

using var loggerFactory = LoggerFactory.Create(b => b.SetMinimumLevel(LogLevel.Warning));
var factory = new NobleConnectionFactory(options, loggerFactory.CreateLogger<NobleConnectionFactory>());
var retry = new SqlRetry(loggerFactory.CreateLogger<SqlRetry>());
var repo = new InvoiceRepository(factory, retry);

var failures = 0;

void Check(string label, bool ok, string detail)
{
    Console.WriteLine($"  {(ok ? "PASS" : "FAIL")}  {label}: {detail}");
    if (!ok) failures++;
}

// ---- [1] an UNCONFIGURED centre: the production path -----------------------
//
// ABC01 (mcc 177) has no row in telo_mcc_invoice_config, which is true of all
// but two centres. Everything must still resolve to a printable document.
Console.WriteLine("[1] mcc 177 (ABC01) — no config row");

var plain = await repo.GetAsync(177);

Check("a config object came back at all", plain is not null,
    plain is null ? "null — the LEFT JOIN against the unit master is not holding" : "yes");

if (plain is not null)
{
    Check("hasConfig is false", !plain.HasConfig, plain.HasConfig ? "true" : "false");
    Check("disclaimer is ON by default", plain.Flags.ShowDisclaimer,
        $"showDisclaimer={plain.Flags.ShowDisclaimer}");
    Check("signatory is OFF by default", !plain.Flags.ShowSignatory,
        $"showSignatory={plain.Flags.ShowSignatory}");
    Check("billed in the centre's own name", plain.Flags.OnBehalf == "client",
        plain.Flags.OnBehalf);
    Check("heading is never blank", !string.IsNullOrWhiteSpace(plain.Heading),
        $"\"{plain.Heading}\"");
    // The letterhead falls back to the LIS's own record of the centre. Not
    // every centre has an address on file, so this reports rather than asserts.
    Console.WriteLine($"        letterhead: {plain.Heading} | {plain.Address ?? "(no address)"} | " +
                      $"{plain.Phone ?? "(no phone)"}");
}

// ---- [2] MDCARE keeps the pre-config behaviour -----------------------------
//
// The one centre whose defaults are inverted. If this drifts, MEDICARE's bills
// silently change shape — a disclaimer appears on a document that has never
// carried one, and the signature line it does carry disappears.
Console.WriteLine();
Console.WriteLine("[2] MDCARE — the inverted defaults");

var mdcareId = await FindMccByCodeAsync("MDCARE");
if (mdcareId is null)
{
    // Not a failure: the code may not exist on this database. Say so loudly
    // rather than passing a check that never ran.
    Console.WriteLine("  SKIP  no centre with MCCUnitCode 'MDCARE' on this database");
}
else
{
    var md = await repo.GetAsync(mdcareId.Value);
    Check("resolved", md is not null, md is null ? "null" : $"mcc {mdcareId}");
    if (md is not null)
    {
        Check("billed on behalf of Qugen", md.Flags.OnBehalf == "qugen", md.Flags.OnBehalf);
        Check("no disclaimer", !md.Flags.ShowDisclaimer, $"showDisclaimer={md.Flags.ShowDisclaimer}");
        Check("signatory shown", md.Flags.ShowSignatory, $"showSignatory={md.Flags.ShowSignatory}");
    }
}

// ---- [3] every configured centre round-trips -------------------------------
//
// Small set today, but a stored value must never be overridden by a default —
// that is the failure that would make the config screen look broken.
Console.WriteLine();
Console.WriteLine("[3] centres that DO have a config row");

foreach (var (mcc, mode, disc, sign) in await ConfiguredAsync())
{
    var c = await repo.GetAsync(mcc);
    if (c is null) { Check($"mcc {mcc} resolved", false, "null"); continue; }

    Check($"mcc {mcc} reports hasConfig", c.HasConfig, c.HasConfig.ToString());

    // A stored value wins; only NULL may be defaulted.
    if (disc is bool d)
        Check($"mcc {mcc} kept its stored showDisclaimer", c.Flags.ShowDisclaimer == d,
            $"stored={d} resolved={c.Flags.ShowDisclaimer}");
    if (sign is bool s)
        Check($"mcc {mcc} kept its stored showSignatory", c.Flags.ShowSignatory == s,
            $"stored={s} resolved={c.Flags.ShowSignatory}");
    if (!string.IsNullOrWhiteSpace(mode))
        Check($"mcc {mcc} kept its stored onBehalfMode", c.Flags.OnBehalf == mode!.Trim().ToLowerInvariant(),
            $"stored={mode} resolved={c.Flags.OnBehalf}");

    // Unrecognised values must land on "client", never on "qugen": billing in
    // the wrong entity's name is the expensive direction to be wrong in.
    Check($"mcc {mcc} onBehalf is one of client|qugen",
        c.Flags.OnBehalf is "client" or "qugen", c.Flags.OnBehalf);
}

// ---- [4] a centre id that does not exist -----------------------------------
Console.WriteLine();
Console.WriteLine("[4] an id with no centre behind it");
var ghost = await repo.GetAsync(-1);
Check("returns null rather than an empty document", ghost is null, ghost is null ? "null" : "an object");

// ---- [5] an optional named centre ------------------------------------------
if (args.Length > 0 && int.TryParse(args[0], out var probe))
{
    Console.WriteLine();
    Console.WriteLine($"[5] mcc {probe} — as asked");
    var c = await repo.GetAsync(probe);
    Console.WriteLine(c is null
        ? "        (no such centre)"
        : $"        {c.ClientCode} | heading \"{c.Heading}\" | onBehalf={c.Flags.OnBehalf} " +
          $"disclaimer={c.Flags.ShowDisclaimer} signatory={c.Flags.ShowSignatory} hasConfig={c.HasConfig}");
}

Console.WriteLine();
Console.WriteLine(failures == 0 ? "All checks passed." : $"{failures} check(s) FAILED.");
return failures == 0 ? 0 : 1;

// ---------------------------------------------------------------------------

async Task<int?> FindMccByCodeAsync(string code) =>
    await factory.QueryAsync("verify.mcc", async (conn, ct) =>
    {
        await using var cmd = NobleConnectionFactory.CreateCommand(conn,
            "SELECT TOP 1 id FROM dbo.tbl_med_mcc_unit_master WHERE MCCUnitCode = @c");
        cmd.Parameters.AddWithValue("@c", code);
        var v = await cmd.ExecuteScalarAsync(ct).ConfigureAwait(false);
        return v is null or DBNull ? (int?)null : Convert.ToInt32(v);
    }, default);

async Task<List<(int Mcc, string? Mode, bool? Disclaimer, bool? Signatory)>> ConfiguredAsync() =>
    await factory.QueryAsync("verify.configured", async (conn, ct) =>
    {
        await using var cmd = NobleConnectionFactory.CreateCommand(conn, """
            SELECT mcc_id, on_behalf_mode, show_disclaimer, show_signatory
            FROM dbo.telo_mcc_invoice_config
            ORDER BY mcc_id
            """);
        await using var r = await cmd.ExecuteReaderAsync(ct).ConfigureAwait(false);

        var rows = new List<(int, string?, bool?, bool?)>();
        while (await r.ReadAsync(ct).ConfigureAwait(false))
            rows.Add((
                r.GetInt32(0),
                r.IsDBNull(1) ? null : r.GetString(1),
                r.IsDBNull(2) ? null : r.GetBoolean(2),
                r.IsDBNull(3) ? null : r.GetBoolean(3)));
        return rows;
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
