using System.Text.Json;
using Infinity.Api.Auth;
using Microsoft.Extensions.Options;

/*
 * Proves that the worklist is TOTAL: paging through it returns every matching
 * row exactly once, the advertised total is the truth, and a filter narrows the
 * set in SQL rather than hiding rows the client was already given.
 *
 * These are the properties a list has to have before "showing 1-100 of 3,412"
 * can be believed. They are cheap to assert and impossible to eyeball: a paging
 * bug that duplicates one row and drops another looks completely normal on any
 * single screen.
 *
 * Usage, from api/:
 *     Verify__BaseUrl=http://host:3121 dotnet run --project tools/VerifyPaging
 *
 * Read-only.
 */

LoadDotEnv(Path.Combine(FindApiRoot() ?? ".", ".env"));

var baseUrl = Env("Verify__BaseUrl") ?? "http://localhost:3121";
var failures = 0;

void Check(string label, bool ok, string detail)
{
    Console.WriteLine($"  {(ok ? "PASS" : "FAIL")}  {label}: {detail}");
    if (!ok) failures++;
}

var jwt = new JwtIssuer(Options.Create(new JwtOptions
{
    Secret = Env("Jwt__Secret") ?? "",
    Issuer = Env("Jwt__Issuer") ?? "infinity-api",
    Audience = Env("Jwt__Audience") ?? "infinity-web",
}));

var user = new AuthenticatedUser(
    UserId: int.Parse(Env("Verify__UserId") ?? "1"),
    Username: "verify-paging", DisplayName: null, Email: null,
    Role: InfinityRoles.SuperAdmin,
    Capabilities: InfinityRoles.CapabilitiesFor(InfinityRoles.SuperAdmin).ToArray(),
    UsertypeId: 1, UsertypeName: null, ManagedBy: "lis", LisAccess: false);

var (token, _) = jwt.Issue(user, 0);

using var http = new HttpClient { BaseAddress = new Uri(baseUrl), Timeout = TimeSpan.FromMinutes(3) };
http.DefaultRequestHeaders.Authorization = new("Bearer", token);

// A window wide enough to hold far more than one page.
var to = DateTime.UtcNow.AddHours(5.5).ToString("yyyy-MM-dd");
var from = DateTime.UtcNow.AddHours(5.5).AddDays(-30).ToString("yyyy-MM-dd");

async Task<(int Total, int PageCount, string[] Sids, int[] Statuses)> Fetch(
    int page, int size, string? statusIds)
{
    var url = $"/api/reports/?from={from}&to={to}&page={page}&pageSize={size}"
            + (statusIds is null ? "" : $"&statusIds={statusIds}");
    var resp = await http.GetAsync(url);
    resp.EnsureSuccessStatusCode();

    using var doc = JsonDocument.Parse(await resp.Content.ReadAsStringAsync());
    var root = doc.RootElement;
    var rows = root.GetProperty("rows");

    return (
        root.GetProperty("total").GetInt32(),
        root.GetProperty("pageCount").GetInt32(),
        rows.EnumerateArray().Select(r => r.GetProperty("sid").GetString() ?? "").ToArray(),
        rows.EnumerateArray()
            .Select(r => r.TryGetProperty("statusCode", out var s) && s.ValueKind == JsonValueKind.Number
                ? s.GetInt32() : -1)
            .ToArray());
}

// ---- 1. walk every page and account for every row --------------------------
Console.WriteLine($"[1] {from} to {to}, unfiltered — paging must be total");

const int Size = 50;
var first = await Fetch(1, Size, null);
Console.WriteLine($"        total={first.Total} pageCount={first.PageCount}");

Check("pageCount agrees with total", first.PageCount == (first.Total + Size - 1) / Size,
    $"{first.PageCount} pages of {Size} for {first.Total} rows");

var seen = new List<string>();
var totalsSeen = new HashSet<int>();

// Cap the walk so a huge window does not turn this into a load test; if the
// walk is capped, say so rather than reporting a clean sweep of a subset.
var pagesToWalk = Math.Min(first.PageCount, 40);
for (var p = 1; p <= pagesToWalk; p++)
{
    var r = await Fetch(p, Size, null);
    totalsSeen.Add(r.Total);
    seen.AddRange(r.Sids);

    var expected = p < first.PageCount ? Size : first.Total - (first.PageCount - 1) * Size;
    if (r.Sids.Length != expected)
        Check($"page {p} is full", false, $"{r.Sids.Length} rows, expected {expected}");
}

if (pagesToWalk < first.PageCount)
    Console.WriteLine($"        NOTE: walked {pagesToWalk} of {first.PageCount} pages (capped)");

Check("the total never changes between pages", totalsSeen.Count <= 1,
    string.Join(", ", totalsSeen));

var duplicates = seen.GroupBy(s => s).Where(g => g.Count() > 1).Select(g => g.Key).ToArray();
Check("no row appears on two pages", duplicates.Length == 0,
    duplicates.Length == 0 ? $"{seen.Count} rows, all distinct" : string.Join(", ", duplicates.Take(5)));

if (pagesToWalk == first.PageCount)
{
    Check("the walk returned exactly the advertised total", seen.Count == first.Total,
        $"{seen.Count} collected vs {first.Total} advertised");
}

// ---- 2. page size must not change WHICH rows exist -------------------------
// A different page size is a different slicing of the same set. If the totals
// disagree, something is being dropped by the transport rather than filtered.
Console.WriteLine("\n[2] page size changes the slicing, not the set");

var big = await Fetch(1, 200, null);
Check("total is identical at pageSize 200", big.Total == first.Total,
    $"{big.Total} vs {first.Total}");

var firstPageOfBig = big.Sids.Take(Size).ToArray();
Check("the first rows are the same regardless of page size",
    firstPageOfBig.SequenceEqual(seen.Take(Math.Min(Size, firstPageOfBig.Length))),
    "ordering is stable across page sizes");

// ---- 3. a filter narrows the SET, not the page -----------------------------
Console.WriteLine("\n[3] the outstanding-only filter is applied in SQL");

var pending = await Fetch(1, Size, "2,4,5,6");
Console.WriteLine($"        total={pending.Total} pageCount={pending.PageCount}");

Check("filtered total is not greater than unfiltered", pending.Total <= first.Total,
    $"{pending.Total} <= {first.Total}");

Check("every returned row matches the filter",
    pending.Statuses.All(s => s is 2 or 4 or 5 or 6),
    pending.Statuses.Length == 0 ? "no rows" : $"statuses: {string.Join(",", pending.Statuses.Distinct())}");

// The defect this replaces: a filtered page used to arrive short because rows
// were removed after paging. A full result set must now fill its pages.
if (pending.PageCount > 1)
{
    var p2 = await Fetch(2, Size, "2,4,5,6");
    Check("a filtered page is full when more pages follow",
        pending.PageCount <= 2 || p2.Sids.Length == Size,
        $"page 2 held {p2.Sids.Length} of {Size}");
    Check("filtered pages do not overlap",
        !p2.Sids.Intersect(pending.Sids).Any(),
        "page 1 and page 2 are disjoint");
}

// ---- 4. asking past the end is empty, not an error -------------------------
Console.WriteLine("\n[4] beyond the last page");
var past = await Fetch(first.PageCount + 5, Size, null);
Check("returns no rows rather than failing", past.Sids.Length == 0, $"{past.Sids.Length} rows");
Check("still reports the true total", past.Total == 0 || past.Total == first.Total,
    $"{past.Total}");

Console.WriteLine();
Console.WriteLine(failures == 0 ? "All checks passed." : $"{failures} check(s) FAILED.");
return failures == 0 ? 0 : 1;

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
