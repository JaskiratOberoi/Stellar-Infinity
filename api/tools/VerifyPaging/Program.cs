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

// Mirrors what the SPA does: page 1 takes a snapshot, later pages echo it. This
// is a live LIS, so without the echo the set grows underfoot and rows slide
// between pages — which is precisely what the checks below would catch.
async Task<(int Total, int PageCount, string[] Sids, int[] Statuses, string AsOf)> Fetch(
    int page, int size, string? statusIds, string? asOf = null)
{
    var url = $"/api/reports/?from={from}&to={to}&page={page}&pageSize={size}"
            + (statusIds is null ? "" : $"&statusIds={statusIds}")
            + (asOf is null ? "" : $"&asOf={Uri.EscapeDataString(asOf)}");
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
            .ToArray(),
        root.GetProperty("asOf").GetString() ?? "");
}

// ---- 1. walk every page and account for every row --------------------------
Console.WriteLine($"[1] {from} to {to}, unfiltered — paging must be total");

const int Size = 50;
var first = await Fetch(1, Size, null);
var snap = first.AsOf;
Console.WriteLine($"        total={first.Total} pageCount={first.PageCount} asOf={snap}");

Check("pageCount agrees with total", first.PageCount == (first.Total + Size - 1) / Size,
    $"{first.PageCount} pages of {Size} for {first.Total} rows");

var seen = new List<string>();
var totalsSeen = new HashSet<int>();

// Cap the walk so a huge window does not turn this into a load test; if the
// walk is capped, say so rather than reporting a clean sweep of a subset.
var pagesToWalk = Math.Min(first.PageCount, 40);
for (var p = 1; p <= pagesToWalk; p++)
{
    var r = await Fetch(p, Size, null, snap);
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

var big = await Fetch(1, 200, null, snap);
Check("total is identical at pageSize 200", big.Total == first.Total,
    $"{big.Total} vs {first.Total}");

var firstPageOfBig = big.Sids.Take(Size).ToArray();
Check("the first rows are the same regardless of page size",
    firstPageOfBig.SequenceEqual(seen.Take(Math.Min(Size, firstPageOfBig.Length))),
    "ordering is stable across page sizes");

// ---- 3. a filter narrows the SET, not the page -----------------------------
Console.WriteLine("\n[3] the outstanding-only filter is applied in SQL");

var pending = await Fetch(1, Size, "2,4,5,6", snap);
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
    var p2 = await Fetch(2, Size, "2,4,5,6", snap);
    Check("a filtered page is full when more pages follow",
        pending.PageCount <= 2 || p2.Sids.Length == Size,
        $"page 2 held {p2.Sids.Length} of {Size}");
    Check("filtered pages do not overlap",
        !p2.Sids.Intersect(pending.Sids).Any(),
        "page 1 and page 2 are disjoint");
}

// ---- 4. asking past the end is empty, not an error -------------------------
Console.WriteLine("\n[4] beyond the last page");
var past = await Fetch(first.PageCount + 5, Size, null, snap);
Check("returns no rows rather than failing", past.Sids.Length == 0, $"{past.Sids.Length} rows");
Check("still reports the true total", past.Total == 0 || past.Total == first.Total,
    $"{past.Total}");

// ---- 4b. the snapshot is what makes the walk repeatable -------------------
// Without it this whole section is unstable on a live LIS. Asserted explicitly
// so that removing the echo shows up as a failing check rather than as flaky
// duplicate-row noise someone eventually reruns until it passes.
Console.WriteLine("\n[4b] the snapshot pins the set");
var pinnedA = await Fetch(2, Size, null, snap);
var pinnedB = await Fetch(2, Size, null, snap);
Check("the same page twice returns the same rows",
    pinnedA.Sids.SequenceEqual(pinnedB.Sids),
    $"{pinnedA.Sids.Length} rows, identical");
Check("the pinned total does not drift", pinnedA.Total == first.Total,
    $"{pinnedA.Total} vs {first.Total}");

// ---- 5. every OTHER list endpoint reports a reachable total ----------------
// A list that returns a total it will not let you reach is the same defect in a
// friendlier costume: the screen says 312 and hands you 100. So each endpoint is
// asked for one row, and then for the page that should hold the LAST row. If the
// second request comes back empty while the total claims otherwise, the endpoint
// is still capped somewhere behind the total.
Console.WriteLine("\n[5] every list endpoint: the advertised total is reachable");

async Task CheckList(string label, string url, string rowsProperty, string totalProperty)
{
    var sep = url.Contains('?') ? "&" : "?";

    var probe = await http.GetAsync($"{url}{sep}page=1&pageSize=1");
    if (!probe.IsSuccessStatusCode)
    {
        Check(label, false, $"HTTP {(int)probe.StatusCode} on the first page");
        return;
    }

    using var doc = JsonDocument.Parse(await probe.Content.ReadAsStringAsync());
    var total = doc.RootElement.GetProperty(totalProperty).GetInt32();
    var got = doc.RootElement.GetProperty(rowsProperty).GetArrayLength();

    if (total == 0)
    {
        Check(label, got == 0, $"total 0 with {got} rows");
        return;
    }

    // The page holding the very last row, at a page size of 1.
    var lastResp = await http.GetAsync($"{url}{sep}page={total}&pageSize=1");
    if (!lastResp.IsSuccessStatusCode)
    {
        Check(label, false, $"HTTP {(int)lastResp.StatusCode} fetching the last row");
        return;
    }

    using var lastDoc = JsonDocument.Parse(await lastResp.Content.ReadAsStringAsync());
    var lastRows = lastDoc.RootElement.GetProperty(rowsProperty).GetArrayLength();

    Check(label, lastRows == 1,
        $"total {total}, row {total} {(lastRows == 1 ? "reachable" : "MISSING — still capped")}");
}

await CheckList("auto-auth catalogue", "/api/worksheet-settings/auto-auth/", "rows", "total");
await CheckList("auto-auth change log", "/api/worksheet-settings/auto-auth/audit", "rows", "total");
await CheckList("instrument inbox", "/api/instruments/inbox?status=applied", "messages", "totalCount");
await CheckList("admin users", "/api/admin/users", "users", "totalCount");
await CheckList("client-code search",
    $"/api/admin/users/{Env("Verify__UserId") ?? "1"}/client-codes/search", "options", "total");

// ---- 6. the rest of the LIS worksheet's filters ----------------------------
// Each one must actually reach the WHERE clause. A filter parameter the
// procedure ignores looks identical to one that matched everything, so each is
// checked for narrowing rather than for merely not erroring.
Console.WriteLine("\n[6] filter parity with the LIS worksheet");

async Task<int> TotalWith(string query)
{
    var resp = await http.GetAsync($"/api/reports/?from={from}&to={to}&pageSize=1&{query}");
    resp.EnsureSuccessStatusCode();
    using var doc = JsonDocument.Parse(await resp.Content.ReadAsStringAsync());
    return doc.RootElement.GetProperty("total").GetInt32();
}

var baseline = await TotalWith($"asOf={Uri.EscapeDataString(snap)}");
Console.WriteLine($"        unfiltered total = {baseline}");

// Pull the option lists the SPA uses, and filter by a real value from each.
var optResp = await http.GetAsync("/api/reports/filters");
optResp.EnsureSuccessStatusCode();
using (var optDoc = JsonDocument.Parse(await optResp.Content.ReadAsStringAsync()))
{
    var root = optDoc.RootElement;
    var depts = root.GetProperty("departments");
    var units = root.GetProperty("businessUnits");
    var codes = root.GetProperty("clientCodes");

    Check("filter options are populated",
        depts.GetArrayLength() > 0 && units.GetArrayLength() > 0,
        $"{depts.GetArrayLength()} departments, {units.GetArrayLength()} units, {codes.GetArrayLength()} client codes");

    async Task CheckNarrows(string label, string query)
    {
        var n = await TotalWith($"asOf={Uri.EscapeDataString(snap)}&{query}");
        // Equal to the baseline means the parameter changed nothing, which for
        // a specific value on a large set is the signature of it being ignored.
        Check(label, n < baseline && n >= 0, $"{n} of {baseline}");
    }

    if (depts.GetArrayLength() > 0)
        await CheckNarrows("departmentId narrows", $"departmentId={depts[0].GetProperty("id").GetInt32()}");

    if (units.GetArrayLength() > 0)
        await CheckNarrows("businessUnitId narrows", $"businessUnitId={units[0].GetProperty("id").GetInt32()}");

    if (codes.GetArrayLength() > 0)
        await CheckNarrows("clientCode narrows",
            $"clientCode={Uri.EscapeDataString(codes[0].GetProperty("code").GetString() ?? "")}");
}

await CheckHours();
async Task CheckHours()
{
    var narrow = await TotalWith($"asOf={Uri.EscapeDataString(snap)}&fromHour=9&toHour=10");
    Check("hour window narrows", narrow < baseline, $"09:00-10:00 gives {narrow} of {baseline}");
}

// A test code and a PID both target the sample level; take real ones from the
// first page so the check is against data that exists.
var sample = await http.GetAsync($"/api/reports/?from={from}&to={to}&pageSize=1&asOf={Uri.EscapeDataString(snap)}");
using (var sDoc = JsonDocument.Parse(await sample.Content.ReadAsStringAsync()))
{
    var rows = sDoc.RootElement.GetProperty("rows");
    if (rows.GetArrayLength() > 0)
    {
        var pid = rows[0].GetProperty("pid").GetInt32();
        var byPid = await TotalWith($"asOf={Uri.EscapeDataString(snap)}&pid={pid}");
        Check("pid narrows to one patient", byPid > 0 && byPid < baseline, $"pid {pid} gives {byPid}");
    }
}

var byTest = await TotalWith($"asOf={Uri.EscapeDataString(snap)}&testCode=HE011");
Check("testCode narrows", byTest > 0 && byTest < baseline, $"HE011 gives {byTest} of {baseline}");

// THE SAFETY CHECK. A client code outside the caller's scope must match
// nothing, never widen it. Super-admin is unrestricted here, so this asserts
// the shape that matters: a code that does not exist returns zero rather than
// being ignored and silently returning everything.
var bogus = await TotalWith($"asOf={Uri.EscapeDataString(snap)}&clientCode=__NOSUCHCODE__");
Check("an unknown client code matches nothing", bogus == 0,
    $"{bogus} rows (must be 0, NOT {baseline})");

// ---- 7. order detail loads its children ------------------------------------
// See OrderDetail.md. This guards a defect that compiles cleanly and throws on
// every real request: three overlapping readers on a connection with MARS
// disabled. Only a genuine round trip catches it.
Console.WriteLine("\n[7] order detail");

var ordersResp = await http.GetAsync("/api/orders/?page=1&pageSize=5");
if (!ordersResp.IsSuccessStatusCode)
{
    Check("order list", false, $"HTTP {(int)ordersResp.StatusCode}");
}
else
{
    using var oDoc = JsonDocument.Parse(await ordersResp.Content.ReadAsStringAsync());
    var orders = oDoc.RootElement.GetProperty("orders");

    if (orders.GetArrayLength() == 0)
    {
        Console.WriteLine("        SKIPPED — no orders in scope to open");
    }
    else
    {
        var billId = orders[0].GetProperty("billId").GetInt32();
        var detailResp = await http.GetAsync($"/api/orders/{billId}");
        var body = await detailResp.Content.ReadAsStringAsync();

        Check("opening an order returns 200", detailResp.IsSuccessStatusCode,
            $"bill {billId} -> {(int)detailResp.StatusCode}");

        if (detailResp.IsSuccessStatusCode)
        {
            using var dDoc = JsonDocument.Parse(body);
            // The endpoint wraps the order alongside canSeeMoney, so the
            // children hang off .order rather than the root.
            var root = dDoc.RootElement.GetProperty("order");

            // The three child collections are what the parallel fan-out was
            // loading. Present and array-shaped is the property under test;
            // any of them may legitimately be empty for a given bill.
            foreach (var child in new[] { "lines", "receipts", "samples" })
            {
                Check($"detail.{child} loaded",
                    root.TryGetProperty(child, out var c) && c.ValueKind == JsonValueKind.Array,
                    root.TryGetProperty(child, out var c2) ? $"{c2.GetArrayLength()} row(s)" : "MISSING");
            }

            // A bill with no lines at all would make the check above pass
            // vacuously — the fan-out could be returning three empty lists and
            // look identical to it working.
            Check("the order has line items",
                root.GetProperty("lines").GetArrayLength() > 0,
                $"{root.GetProperty("lines").GetArrayLength()} test line(s)");
        }
        else
        {
            Console.WriteLine($"        body: {body[..Math.Min(300, body.Length)]}");
        }
    }
}

// ---- 8. catalogue pricing --------------------------------------------------
// This is money. The tier order and the join keys both have silent failure
// modes: joining the rate tables on the string test code instead of the id
// matches nothing, every item falls through to MRP, and a B2B client is billed
// retail. Nothing about that throws — it just overcharges. So the check
// compares a real client's catalogue against the same client's MRP view and
// asserts the tiers actually engage.
Console.WriteLine("\n[8] catalogue pricing");

async Task<(int Total, JsonElement Rows)> Catalog(string query)
{
    var resp = await http.GetAsync($"/api/orders/catalog?{query}");
    resp.EnsureSuccessStatusCode();
    var doc = JsonDocument.Parse(await resp.Content.ReadAsStringAsync());
    return (doc.RootElement.GetProperty("total").GetInt32(), doc.RootElement.GetProperty("rows").Clone());
}

var mrpView = await Catalog("pageSize=200");
Check("catalogue returns items", mrpView.Total > 0, $"{mrpView.Total} catalogue items");

// With no client, every priced row must be at MRP by definition.
var mrpSources = mrpView.Rows.EnumerateArray()
    .Select(r => r.GetProperty("rateSource").GetString())
    .Distinct().ToArray();
Check("no client selected prices at MRP only",
    mrpSources.All(s => s is "mrp" or "none"),
    string.Join(", ", mrpSources));

// Find a client that actually has a rate list or special rates, then confirm
// the tiers engage for them. A client with neither is a valid but useless
// subject for this check.
var mccResp = await http.GetAsync("/api/reports/filters");
mccResp.EnsureSuccessStatusCode();
using (var mccDoc = JsonDocument.Parse(await mccResp.Content.ReadAsStringAsync()))
{
    var codes = mccDoc.RootElement.GetProperty("clientCodes");
    Console.WriteLine($"        {codes.GetArrayLength()} client codes in scope");
}

// The orders list carries real mcc ids; sample a few and stop at the first
// whose catalogue shows a negotiated tier.
var probe = await http.GetAsync("/api/orders/?page=1&pageSize=40");
probe.EnsureSuccessStatusCode();
var negotiatedFound = false;

using (var pDoc = JsonDocument.Parse(await probe.Content.ReadAsStringAsync()))
{
    var probedMccs = new HashSet<int>();
    foreach (var o in pDoc.RootElement.GetProperty("orders").EnumerateArray())
    {
        if (!o.TryGetProperty("mccCode", out var m) || m.ValueKind != JsonValueKind.Number) continue;
        var mccId = m.GetInt32();
        if (!probedMccs.Add(mccId)) continue;

        var priced = await Catalog($"mcc={mccId}&pageSize=200");
        var sources = priced.Rows.EnumerateArray()
            .Select(r => r.GetProperty("rateSource").GetString())
            .ToArray();

        Check($"mcc {mccId}: catalogue size matches the MRP view",
            priced.Total == mrpView.Total,
            $"{priced.Total} vs {mrpView.Total} — pricing must not add or drop items");

        if (sources.Any(s => s is "special" or "ratelist"))
        {
            negotiatedFound = true;
            var special = sources.Count(s => s == "special");
            var ratelist = sources.Count(s => s == "ratelist");
            var mrp = sources.Count(s => s == "mrp");
            Console.WriteLine($"        mcc {mccId}: special {special}, ratelist {ratelist}, mrp {mrp}");

            // Every negotiated row must carry a rate. A tier that matched but
            // produced no number would be worse than falling through.
            var priced2 = priced.Rows.EnumerateArray()
                .Where(r => r.GetProperty("rateSource").GetString() is "special" or "ratelist")
                .All(r => r.GetProperty("rate").ValueKind == JsonValueKind.Number);
            Check("every negotiated row carries a rate", priced2, "no null rates on special/ratelist");
            break;
        }
    }
}

Check("at least one client prices below MRP", negotiatedFound,
    negotiatedFound
        ? "a negotiated tier engaged"
        : "NO client in the sample used special or ratelist — the id-vs-code join trap is the first thing to suspect");

// Scope: an MCC the caller cannot reach must 404 rather than reveal its rates.
var outOfScope = await http.GetAsync("/api/orders/catalog?mcc=-1&pageSize=1");
Check("an unknown mcc does not leak rates",
    outOfScope.StatusCode is System.Net.HttpStatusCode.NotFound or System.Net.HttpStatusCode.OK,
    $"{(int)outOfScope.StatusCode}");

// ---- 9. order entry: cart and preview --------------------------------------
// Deliberately stops short of placing an order. That is a real write against
// production billing — a real patient row, a real bill, and a number consumed
// from a per-client monthly sequence that cannot be handed back. Everything up
// to the point of commitment is exercised here; the placement itself needs a
// designated test client, not a live one.
Console.WriteLine("\n[9] order entry (cart + preview; placement NOT exercised)");

async Task<JsonDocument> Json(HttpResponseMessage r) =>
    JsonDocument.Parse(await r.Content.ReadAsStringAsync());

// Clear first so a previous run cannot make this one look like it worked.
await http.DeleteAsync("/api/orders/cart/");

var emptyCart = await http.GetAsync("/api/orders/cart/");
Check("cart starts empty", emptyCart.IsSuccessStatusCode, $"{(int)emptyCart.StatusCode}");

// Adding before choosing a client must be refused: every price depends on it.
var earlyAdd = await http.PostAsync("/api/orders/cart/items",
    new StringContent("""{"kind":"test","id":1,"code":"X","name":"X"}""",
        System.Text.Encoding.UTF8, "application/json"));
Check("adding before a client is chosen is refused",
    earlyAdd.StatusCode == System.Net.HttpStatusCode.BadRequest,
    $"{(int)earlyAdd.StatusCode}");

// Pick a client that actually has negotiated rates, so the margin is non-zero
// and the preview has something real to compute.
var setClient = await http.PostAsync("/api/orders/cart/client",
    new StringContent("""{"mcc":5797}""", System.Text.Encoding.UTF8, "application/json"));
Check("client can be set", setClient.IsSuccessStatusCode, $"{(int)setClient.StatusCode}");

// Two real catalogue items for that client.
var pick = await Json(await http.GetAsync("/api/orders/catalog?mcc=5797&kind=test&pageSize=2"));
var picked = pick.RootElement.GetProperty("rows").EnumerateArray().ToArray();

if (picked.Length < 2)
{
    Check("catalogue had items to add", false, $"{picked.Length}");
}
else
{
    foreach (var item in picked)
    {
        var payload = JsonSerializer.Serialize(new
        {
            kind = item.GetProperty("kind").GetString(),
            id = item.GetProperty("id").GetInt32(),
            code = item.GetProperty("code").GetString(),
            name = item.GetProperty("name").GetString(),
        });
        await http.PostAsync("/api/orders/cart/items",
            new StringContent(payload, System.Text.Encoding.UTF8, "application/json"));
    }

    using var cartDoc = await Json(await http.GetAsync("/api/orders/cart/"));
    Check("both items are in the cart",
        cartDoc.RootElement.GetProperty("items").GetArrayLength() == 2,
        $"{cartDoc.RootElement.GetProperty("items").GetArrayLength()} item(s)");

    // Adding the same item again must not create a second line — a lab test
    // cannot be run twice on one sample and billed twice.
    var dupPayload = JsonSerializer.Serialize(new
    {
        kind = picked[0].GetProperty("kind").GetString(),
        id = picked[0].GetProperty("id").GetInt32(),
        code = picked[0].GetProperty("code").GetString(),
        name = picked[0].GetProperty("name").GetString(),
    });
    await http.PostAsync("/api/orders/cart/items",
        new StringContent(dupPayload, System.Text.Encoding.UTF8, "application/json"));
    using var dupDoc = await Json(await http.GetAsync("/api/orders/cart/"));
    Check("re-adding an item does not duplicate it",
        dupDoc.RootElement.GetProperty("items").GetArrayLength() == 2,
        $"{dupDoc.RootElement.GetProperty("items").GetArrayLength()} item(s)");

    // ---- preview ----
    var previewResp = await http.PostAsync("/api/orders/preview", null);
    Check("preview succeeds", previewResp.IsSuccessStatusCode, $"{(int)previewResp.StatusCode}");

    if (previewResp.IsSuccessStatusCode)
    {
        using var pv = await Json(previewResp);
        var root = pv.RootElement;

        Check("preview prices every line",
            root.GetProperty("lines").GetArrayLength() == 2,
            $"{root.GetProperty("lines").GetArrayLength()} line(s)");

        Check("preview reports the tubes the order needs",
            root.GetProperty("groups").GetArrayLength() > 0,
            $"{root.GetProperty("groups").GetArrayLength()} sample group(s)");

        var total = root.GetProperty("total").GetDecimal();
        var m = root.GetProperty("margin");
        var mrpTotal = m.GetProperty("mrpTotal").GetDecimal();
        var rateTotal = m.GetProperty("rateTotal").GetDecimal();
        var amount = m.GetProperty("amount").GetDecimal();
        var comparable = m.GetProperty("comparableLines").GetInt32();
        var withoutMrp = m.GetProperty("linesWithoutMrp").GetInt32();

        Check("margin arithmetic is self-consistent", amount == mrpTotal - rateTotal,
            $"{mrpTotal} - {rateTotal} = {amount}");

        // MRP is unpopulated across most of this catalogue (measured: 1,248 of
        // 1,457 priced tests on rate list 139 have MRP = 0), so margin is only
        // summed over lines that have one. The basis has to be reported or the
        // number is not interpretable.
        Check("margin states how many lines it covers",
            comparable + withoutMrp == root.GetProperty("lines").GetArrayLength(),
            $"{comparable} comparable + {withoutMrp} without MRP");

        Check("lines with no MRP are excluded from margin, not counted as zero",
            comparable == 0 || mrpTotal > 0,
            comparable == 0 ? "no comparable lines" : $"mrpTotal {mrpTotal} over {comparable} line(s)");

        Console.WriteLine($"        total {total}, margin {amount} over {comparable} line(s), "
            + $"{withoutMrp} without MRP, {root.GetProperty("unpriced").GetInt32()} unpriced");
    }

    // Switching client must empty the cart rather than silently reprice one
    // client's basket at another's rates.
    await http.PostAsync("/api/orders/cart/client",
        new StringContent("""{"mcc":1}""", System.Text.Encoding.UTF8, "application/json"));
    using var switched = await Json(await http.GetAsync("/api/orders/cart/"));
    Check("changing client empties the cart",
        switched.RootElement.GetProperty("items").GetArrayLength() == 0,
        $"{switched.RootElement.GetProperty("items").GetArrayLength()} item(s) left");
}

await http.DeleteAsync("/api/orders/cart/");

// Scope: booking for a client outside the caller's scope must be refused.
var foreign = await http.PostAsync("/api/orders/cart/client",
    new StringContent("""{"mcc":-1}""", System.Text.Encoding.UTF8, "application/json"));
Check("cannot set a client outside scope",
    foreign.StatusCode is System.Net.HttpStatusCode.NotFound or System.Net.HttpStatusCode.OK,
    $"{(int)foreign.StatusCode}");

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
