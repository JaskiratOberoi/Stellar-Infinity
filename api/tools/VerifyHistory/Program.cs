using Infinity.Api.Data;
using Infinity.Api.Worksheet;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

/*
 * Exercises ResultHistoryRepository — the stored procedure AND the two-result-set
 * reader on top of it — against the live database, and asserts the properties
 * the delta trend depends on.
 *
 * The reader is the part worth testing here: it consumes a series result set and
 * then advances to a second, differently-shaped one. Getting that wrong yields a
 * silently empty identity row rather than an exception, which would show the
 * operator an unlabelled trend. A compile is no evidence at all.
 *
 * Usage, from api/:
 *     dotnet run --project tools/VerifyHistory -- <sid-with-history> <sid-without-mobile>
 *
 * Read-only. Configuration comes from api/.env, same as the deploy tool.
 */

if (args.Length < 1)
{
    Console.Error.WriteLine("usage: VerifyHistory <sid> [sid-without-mobile]");
    return 2;
}

LoadDotEnv(Path.Combine(FindApiRoot() ?? ".", ".env"));

var options = Options.Create(new NobleOptions
{
    Server = Env("Noble__Server") ?? "",
    Database = Env("Noble__Database") ?? "Noble",
    User = Env("Noble__User") ?? "",
    Password = Env("Noble__Password") ?? "",
    Encrypt = Env("Noble__Encrypt") is not "false",
    TrustServerCertificate = Env("Noble__TrustServerCertificate") is "true",
    ApplicationName = "InfinityVerifyHistory",
});

using var loggerFactory = LoggerFactory.Create(b => b.SetMinimumLevel(LogLevel.Warning));
var factory = new NobleConnectionFactory(options, loggerFactory.CreateLogger<NobleConnectionFactory>());
var retry = new SqlRetry(loggerFactory.CreateLogger<SqlRetry>());
var repo = new ResultHistoryRepository(factory, retry);

var failures = 0;

void Check(string label, bool ok, string detail)
{
    Console.WriteLine($"  {(ok ? "PASS" : "FAIL")}  {label}: {detail}");
    if (!ok) failures++;
}

// ---- subject 1: a patient with prior visits --------------------------------
var sid = args[0];
Console.WriteLine($"[1] {sid} — patient with repeat visits");

var h = await repo.GetAsync(sid);

Check("identity row was read", h.Match.MatchedOn != "none",
    $"matchedOn={h.Match.MatchedOn} priorVisits={h.Match.PriorVisits} hasMobile={h.Match.HasMobile}");

Check("analytes with a trend", h.Analytes.Count > 0,
    $"{h.Analytes.Count} analyte(s)");

Check("every analyte has >1 point", h.Analytes.All(a => a.Points.Count > 1),
    string.Join(", ", h.Analytes.Select(a => $"{a.TestCode}×{a.Points.Count}")));

Check("every value parses as a number",
    h.Analytes.SelectMany(a => a.Points).All(p => double.TryParse(p.Value, out _)),
    $"{h.Analytes.Sum(a => a.Points.Count)} point(s) checked");

Check("every analyte includes the current sample",
    h.Analytes.All(a => a.Points.Any(p => p.IsCurrent)),
    "current value present on each card");

// Chronological order is what makes a left-to-right sparkline mean anything.
Check("points are in chronological order",
    h.Analytes.All(a => a.Points
        .Zip(a.Points.Skip(1), (x, y) => (x.DrawnAt ?? DateTimeOffset.MinValue) <= (y.DrawnAt ?? DateTimeOffset.MinValue))
        .All(ok => ok)),
    "ascending by drawn_at");

// The current sample must be the LAST point, not somewhere in the middle: the
// UI reads the delta off the final pair.
Check("the current sample is the newest point",
    h.Analytes.All(a => a.Points[^1].IsCurrent),
    "current value is rightmost");

// One analyte, one value on this sample. More than one means the series is
// stacking co-reported parameters that happen to share a test code, which is a
// column of unrelated numbers drawn as if it were a trend.
Check("at most one point per analyte is from this sample",
    h.Analytes.All(a => a.Points.Count(p => p.IsCurrent) <= 1),
    string.Join(", ", h.Analytes.Select(a => $"{a.TestCode}:{a.Points.Count(p => p.IsCurrent)}")));

// Two points from the same visit are, likewise, not a trend.
Check("one point per visit",
    h.Analytes.All(a => a.Points.Select(p => p.Sid).Distinct().Count() == a.Points.Count),
    string.Join(", ", h.Analytes.Select(a =>
        $"{a.TestCode}:{a.Points.Select(p => p.Sid).Distinct().Count()}/{a.Points.Count}")));

foreach (var a in h.Analytes.Take(3))
{
    var series = string.Join("  ", a.Points.Select(p =>
        $"{p.DrawnAt:yyyy-MM-dd}#{p.Sid}={p.Value}{(p.IsCurrent ? "*" : "")}"));
    Console.WriteLine($"        {a.TestName ?? a.TestCode} [{a.Unit}]: {series}");
}

// ---- subject 2: no mobile, so no cross-visit guessing ----------------------
if (args.Length > 1)
{
    var sid2 = args[1];
    Console.WriteLine($"\n[2] {sid2} — no mobile recorded");

    var h2 = await repo.GetAsync(sid2);

    Check("reported as having no mobile", !h2.Match.HasMobile,
        $"hasMobile={h2.Match.HasMobile}");

    Check("claimed no prior visits", h2.Match.PriorVisits == 0,
        $"priorVisits={h2.Match.PriorVisits}");

    // The safety property: with no identifier, nothing outside this
    // registration may appear.
    var foreignSids = h2.Analytes
        .SelectMany(a => a.Points)
        .Where(p => !p.IsCurrent)
        .Select(p => p.Sid)
        .Distinct()
        .ToArray();

    Check("no points from another visit", foreignSids.Length == 0,
        foreignSids.Length == 0 ? "none" : string.Join(", ", foreignSids));
}

// ---- the JSON that actually reaches the browser ----------------------------
// The repository could be perfect and the screen still empty: System.Text.Json
// camel-cases these property names, and the TypeScript interfaces have to agree
// field for field. A mismatch is silent — undefined, not an error — so the wire
// format is checked rather than assumed.
var baseUrl = Env("Verify__BaseUrl");
if (baseUrl is not null)
{
    Console.WriteLine($"\n[3] {baseUrl} — the HTTP response the SPA consumes");

    var jwt = new Infinity.Api.Auth.JwtIssuer(Options.Create(new Infinity.Api.Auth.JwtOptions
    {
        Secret = Env("Jwt__Secret") ?? "",
        Issuer = Env("Jwt__Issuer") ?? "infinity-api",
        Audience = Env("Jwt__Audience") ?? "infinity-web",
    }));

    var caps = Infinity.Api.Auth.InfinityRoles.CapabilitiesFor(Infinity.Api.Auth.InfinityRoles.SuperAdmin);
    var user = new Infinity.Api.Auth.AuthenticatedUser(
        UserId: int.Parse(Env("Verify__UserId") ?? "1"),
        Username: "verify-history",
        DisplayName: null, Email: null,
        Role: Infinity.Api.Auth.InfinityRoles.SuperAdmin,
        Capabilities: caps.ToArray(),
        UsertypeId: 1, UsertypeName: null,
        ManagedBy: "lis", LisAccess: false);

    var (token, _) = jwt.Issue(user, 0);
    if (Env("Verify__PrintToken") is not null) Console.WriteLine($"TOKEN={token}");

    using var http = new HttpClient { BaseAddress = new Uri(baseUrl), Timeout = TimeSpan.FromSeconds(60) };
    http.DefaultRequestHeaders.Authorization = new("Bearer", token);

    var resp = await http.GetAsync($"/api/worksheet/{Uri.EscapeDataString(sid)}/trend");
    var body = await resp.Content.ReadAsStringAsync();

    Check("HTTP 200", resp.IsSuccessStatusCode, $"{(int)resp.StatusCode} {resp.StatusCode}");

    if (resp.IsSuccessStatusCode)
    {
        using var doc = System.Text.Json.JsonDocument.Parse(body);
        var root = doc.RootElement;

        var hasMatch = root.TryGetProperty("match", out var m);
        Check("match object present", hasMatch, hasMatch ? m.ToString() : "missing");

        var hasAnalytes = root.TryGetProperty("analytes", out var an)
                       && an.ValueKind == System.Text.Json.JsonValueKind.Array;
        Check("analytes array present", hasAnalytes,
            hasAnalytes ? $"{an.GetArrayLength()} entries" : "missing");

        if (hasAnalytes && an.GetArrayLength() > 0)
        {
            var first = an[0];
            foreach (var field in new[] { "testKey", "testCode", "testName", "unit", "points" })
                Check($"analyte.{field}", first.TryGetProperty(field, out _), "camelCase as TypeScript expects");

            var p0 = first.GetProperty("points")[0];
            foreach (var field in new[] { "value", "sid", "drawnAt", "isCurrent" })
                Check($"point.{field}", p0.TryGetProperty(field, out _), "camelCase as TypeScript expects");

            // The UI parses drawnAt with Date; an offset-less string would be
            // read as local time and shift the dates on the chart.
            var drawn = p0.GetProperty("drawnAt").GetString() ?? "";
            Check("drawnAt carries the IST offset", drawn.Contains("+05:30"), drawn);
        }

        foreach (var field in new[] { "matchedOn", "priorVisits", "hasMobile" })
            Check($"match.{field}", m.TryGetProperty(field, out _), "camelCase as TypeScript expects");
    }
    else
    {
        Console.WriteLine($"        body: {body[..Math.Min(300, body.Length)]}");
    }
}

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
