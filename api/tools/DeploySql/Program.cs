using Infinity.Api.Data;
using Microsoft.Data.SqlClient;

/*
 * Applies api/db/sql/*.sql to Noble, in lexical order, splitting each file on
 * GO batch separators.
 *
 * ⚠️  THIS TARGETS THE LIVE PRODUCTION LIS DATABASE. Every script is written to
 *     be idempotent (tables IF NOT EXISTS, procedures CREATE OR ALTER) and
 *     purely additive, but it is still a production migration.
 *
 * Usage, from api/:
 *     dotnet run --project tools/DeploySql              # apply everything
 *     dotnet run --project tools/DeploySql -- --dry-run # list what would run
 *     dotnet run --project tools/DeploySql -- 10_usp_inf_authenticate.sql
 *
 * Configuration comes from the same Noble__* environment variables the API
 * uses; a .env file beside the api/ folder is loaded if present.
 */

var dryRun = args.Contains("--dry-run", StringComparer.OrdinalIgnoreCase);
var only = args.FirstOrDefault(a => !a.StartsWith("--", StringComparison.Ordinal));

var apiRoot = FindApiRoot() ?? Fail("Could not locate the api/ directory from the current path.");
var sqlDir = Path.Combine(apiRoot, "db", "sql");
if (!Directory.Exists(sqlDir)) Fail($"No SQL directory at {sqlDir}");

LoadDotEnv(Path.Combine(apiRoot, ".env"));

var options = new NobleOptions
{
    Server = Env("Noble__Server") ?? "",
    Database = Env("Noble__Database") ?? "Noble",
    User = Env("Noble__User") ?? "",
    Password = Env("Noble__Password") ?? "",
    Encrypt = Env("Noble__Encrypt") is not "false",
    TrustServerCertificate = Env("Noble__TrustServerCertificate") is "true",
    HostNameInCertificate = Env("Noble__HostNameInCertificate"),
    ApplicationName = "InfinityDeploySql",
    // Migrations can legitimately run long; do not inherit the read timeout.
    CommandTimeoutSeconds = 300,
};

var problems = options.Validate();
if (problems.Count > 0) Fail("Missing configuration: " + string.Join(" ", problems));

var files = Directory.GetFiles(sqlDir, "*.sql")
                     .OrderBy(Path.GetFileName, StringComparer.Ordinal)
                     .Where(f => only is null || Path.GetFileName(f).Equals(only, StringComparison.OrdinalIgnoreCase))
                     .ToList();

if (files.Count == 0) Fail(only is null ? "No .sql files found." : $"No file named '{only}'.");

Console.WriteLine($"Target : {options.Server}/{options.Database}");
Console.WriteLine($"Scripts: {files.Count}");
Console.WriteLine(dryRun ? "Mode   : DRY RUN (nothing will be executed)\n" : "Mode   : APPLY\n");

if (dryRun)
{
    foreach (var f in files) Console.WriteLine($"  would apply  {Path.GetFileName(f)}  ({CountBatches(File.ReadAllText(f))} batch(es))");
    return 0;
}

await using var conn = new SqlConnection(options.BuildConnectionString());

// Surface PRINT/RAISERROR-with-low-severity output; the scripts use PRINT to
// say whether they created an object or found it already present.
conn.InfoMessage += (_, e) =>
{
    foreach (SqlError err in e.Errors)
    {
        if (!string.IsNullOrWhiteSpace(err.Message)) Console.WriteLine($"      | {err.Message}");
    }
};

await conn.OpenAsync();
Console.WriteLine($"Connected as {options.User}.\n");

var applied = 0;
foreach (var file in files)
{
    var name = Path.GetFileName(file);
    Console.WriteLine($"  -> {name}");

    var batches = SplitOnGo(await File.ReadAllTextAsync(file));
    var n = 0;

    foreach (var batch in batches)
    {
        n++;
        try
        {
            await using var cmd = new SqlCommand(batch, conn) { CommandTimeout = options.CommandTimeoutSeconds };
            await cmd.ExecuteNonQueryAsync();
        }
        catch (SqlException ex)
        {
            Console.Error.WriteLine($"\nFAILED in {name}, batch {n}/{batches.Count}:");
            Console.Error.WriteLine($"  {ex.Message}");
            Console.Error.WriteLine("\nStopped. Earlier scripts already applied are idempotent and safe to re-run.");
            return 1;
        }
    }

    applied++;
}

Console.WriteLine($"\nApplied {applied} script(s) successfully.");

// Smoke test: prove the objects the API depends on actually exist now.
foreach (var obj in new[] { "dbo.inf_account", "dbo.inf_user_role", "dbo.inf_user_session_version" })
{
    Console.WriteLine($"  check table  {obj,-34} {(await ObjectExists(conn, obj, "U") ? "OK" : "MISSING")}");
}
foreach (var obj in new[]
         {
             "dbo.usp_inf_authenticate", "dbo.usp_inf_admin_create_user",
             "dbo.usp_inf_admin_set_lis_access", "dbo.usp_inf_admin_set_active",
             "dbo.usp_inf_admin_set_role", "dbo.usp_inf_admin_reset_password",
             "dbo.usp_inf_admin_list_users", "dbo.usp_inf_bump_session_version",
         })
{
    Console.WriteLine($"  check proc   {obj,-34} {(await ObjectExists(conn, obj, "P") ? "OK" : "MISSING")}");
}

return 0;

static async Task<bool> ObjectExists(SqlConnection conn, string name, string type)
{
    await using var cmd = new SqlCommand("SELECT CASE WHEN OBJECT_ID(@n, @t) IS NULL THEN 0 ELSE 1 END", conn);
    cmd.Parameters.AddWithValue("@n", name);
    cmd.Parameters.AddWithValue("@t", type);
    return Convert.ToInt32(await cmd.ExecuteScalarAsync()) == 1;
}

/// <summary>Split a script on lines consisting only of GO (the sqlcmd separator, not T-SQL).</summary>
static List<string> SplitOnGo(string script)
{
    var batches = new List<string>();
    var current = new List<string>();

    foreach (var line in script.Split('\n'))
    {
        if (line.Trim().Equals("GO", StringComparison.OrdinalIgnoreCase))
        {
            AddIfMeaningful(batches, current);
            current.Clear();
        }
        else
        {
            current.Add(line);
        }
    }

    AddIfMeaningful(batches, current);
    return batches;

    static void AddIfMeaningful(List<string> into, List<string> lines)
    {
        var text = string.Join('\n', lines);
        if (!string.IsNullOrWhiteSpace(text)) into.Add(text);
    }
}

static int CountBatches(string script) => SplitOnGo(script).Count;

static string? Env(string key) =>
    Environment.GetEnvironmentVariable(key) is { Length: > 0 } v ? v : null;

/// <summary>Minimal .env loader — KEY=VALUE, # comments, no interpolation.</summary>
static void LoadDotEnv(string path)
{
    if (!File.Exists(path)) return;

    foreach (var raw in File.ReadAllLines(path))
    {
        var line = raw.Trim();
        if (line.Length == 0 || line.StartsWith('#')) continue;

        var eq = line.IndexOf('=');
        if (eq <= 0) continue;

        var key = line[..eq].Trim();
        var value = line[(eq + 1)..].Trim().Trim('"');

        // Real environment variables win, so a deploy can be overridden inline.
        if (Environment.GetEnvironmentVariable(key) is null or "")
        {
            Environment.SetEnvironmentVariable(key, value);
        }
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

static string Fail(string message)
{
    Console.Error.WriteLine("ERROR: " + message);
    Environment.Exit(1);
    return "";
}
