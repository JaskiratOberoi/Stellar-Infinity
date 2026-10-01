using System.Globalization;
using Infinity.Api.Auth;
using Infinity.Api.Messaging;

namespace Infinity.Api.Endpoints;

/// <summary>
/// Reports to patients on WhatsApp (see <see cref="WhatsAppWorker"/>).
/// </summary>
/// <remarks>
/// <list type="bullet">
/// <item><c>/api/settings/whatsapp</c> — Admin → WhatsApp: link the number
/// (QR or phone-number code), the switches, the clients on auto-send, a test
/// send, and the log. Super admin and admin; 404 for anyone else.</item>
/// <item><c>/api/reports/whatsapp</c> — "Send on WhatsApp" from the Reporting
/// list: the lab's desks (the unrestricted reporters), never a client
/// account — a centre does not message patients from the lab's number.</item>
/// </list>
/// Everything queues; nothing here sends. The worker paces the queue.
/// </remarks>
public static class WhatsAppEndpoints
{
    public static void MapWhatsAppEndpoints(this WebApplication app)
    {
        // The tab's own password (Jas, 2026-09-30): an admin unlocks it for
        // half an hour. Outside the gated group so a locked tab can open.
        app.MapPost("/api/settings/whatsapp/unlock", Unlock).RequireAuthorization().WithName("UnlockWhatsApp");
        app.MapPost("/api/settings/whatsapp/lock", Lock).RequireAuthorization().WithName("LockWhatsApp");

        var admin = app.MapGroup("/api/settings/whatsapp").RequireAuthorization();
        admin.AddEndpointFilter(async (ctx, next) =>
        {
            var http = ctx.HttpContext;
            // Non-admins get the handlers' own 404; the gate is for the tab's users.
            if (!IsEditor(http.User)) return await next(ctx);
            if (await IsUnlockedAsync(http).ConfigureAwait(false)) return await next(ctx);
            return Results.Problem("The WhatsApp tab is locked. Enter its password to open it.",
                statusCode: StatusCodes.Status423Locked,
                extensions: new Dictionary<string, object?> { ["code"] = "WA_LOCKED" });
        });
        admin.MapGet("/", Get).WithName("GetWhatsApp");
        admin.MapPut("/", Put).WithName("PutWhatsApp");
        admin.MapPost("/pair", Pair).WithName("PairWhatsApp");
        admin.MapPost("/logout", Logout).WithName("LogoutWhatsApp");
        // Numbers beyond the default, each for the clients assigned to it.
        admin.MapPost("/senders", AddSender).WithName("AddWhatsAppSender");
        admin.MapDelete("/senders/{id}", RemoveSender).WithName("RemoveWhatsAppSender");
        admin.MapPut("/senders/{id}/clients", PutSenderClients).WithName("PutWhatsAppSenderClients");
        admin.MapPut("/clients", PutClients).WithName("PutWhatsAppClients");
        admin.MapPost("/test", Test).WithName("TestWhatsApp");
        admin.MapGet("/messages", Messages).WithName("ListWhatsAppMessages");
        admin.MapPost("/messages/{id:long}/retry", Retry).WithName("RetryWhatsAppMessage");
        admin.MapDelete("/optouts/{phone}", OptIn).WithName("WhatsAppOptIn");

        var reports = app.MapGroup("/api/reports/whatsapp").RequireAuthorization().RequireCapability(Capabilities.ReportView);
        reports.MapPost("/", SendReport).WithName("SendReportWhatsApp");
        reports.MapGet("/status", ReportStatus).WithName("ReportWhatsAppStatus");
    }

    private static bool IsEditor(System.Security.Claims.ClaimsPrincipal p) =>
        p.Role() is InfinityRoles.SuperAdmin or InfinityRoles.Admin;

    private static readonly TimeSpan UnlockFor = TimeSpan.FromMinutes(30);
    private const int MaxWrongTries = 5;
    private static readonly TimeSpan WrongTriesWindow = TimeSpan.FromMinutes(15);

    private static string UnlockKey(int userId) => $"wa:unlock:{userId.ToString(CultureInfo.InvariantCulture)}";

    /// <summary>No password set, or this admin unlocked it within the last half hour.</summary>
    private static async Task<bool> IsUnlockedAsync(HttpContext http)
    {
        var settings = http.RequestServices.GetRequiredService<WhatsAppSettings>();
        if (await settings.TabPasswordHashAsync(http.RequestAborted).ConfigureAwait(false) is null) return true;
        if (http.User.UserId() is not int userId) return false;
        var cache = http.RequestServices.GetRequiredService<Caching.InfinityCache>();
        return await cache.GetAsync(UnlockKey(userId), http.RequestAborted).ConfigureAwait(false) == "1";
    }

    public sealed record UnlockBody(string? Password);

    private static async Task<IResult> Unlock(
        UnlockBody body, System.Security.Claims.ClaimsPrincipal principal, HttpContext http,
        WhatsAppSettings settings, Caching.InfinityCache cache, Audit.AuditLog audit, CancellationToken ct)
    {
        if (!IsEditor(principal) || principal.UserId() is not int actor) return Results.NotFound();
        var hash = await settings.TabPasswordHashAsync(ct).ConfigureAwait(false);
        if (hash is null) return Results.Ok(new { unlocked = true });

        // Counted before the check, so a burst cannot outrun the limit.
        var failKey = $"wa:unlockfail:{actor.ToString(CultureInfo.InvariantCulture)}";
        var tries = await cache.GetAsync(failKey, ct).ConfigureAwait(false);
        if (int.TryParse(tries, NumberStyles.None, CultureInfo.InvariantCulture, out var n) && n >= MaxWrongTries)
            return Results.Problem("Too many wrong passwords. Try again in 15 minutes.", statusCode: StatusCodes.Status429TooManyRequests);

        if (!Worksheet.PasswordHash.Verify(body.Password ?? string.Empty, hash))
        {
            await cache.IncrementAsync(failKey, WrongTriesWindow, ct).ConfigureAwait(false);
            audit.Log("settings.whatsapp_unlock", actor: actor, ip: Audit.AuditIp.From(http), details: new { ok = false });
            return Results.Problem("That password is not right.", statusCode: StatusCodes.Status403Forbidden);
        }
        await cache.RemoveAsync(failKey, ct).ConfigureAwait(false);
        await cache.SetAsync(UnlockKey(actor), "1", UnlockFor, ct).ConfigureAwait(false);
        audit.Log("settings.whatsapp_unlock", actor: actor, ip: Audit.AuditIp.From(http), details: new { ok = true });
        return Results.Ok(new { unlocked = true, minutes = (int)UnlockFor.TotalMinutes });
    }

    private static async Task<IResult> Lock(
        System.Security.Claims.ClaimsPrincipal principal, Caching.InfinityCache cache, CancellationToken ct)
    {
        if (!IsEditor(principal) || principal.UserId() is not int actor) return Results.NotFound();
        await cache.RemoveAsync(UnlockKey(actor), ct).ConfigureAwait(false);
        return Results.Ok(new { locked = true });
    }

    private static object MessageView(WaMessage m) => new
    {
        m.Id, m.Pid, sids = m.SidList, m.ClientCode, m.PatientName, phone = Phone.Mask(m.Phone),
        m.Kind, m.Trigger, m.Status, m.Attempts, m.Error, m.CreatedAt, m.SentAt, m.UpdatedAt, m.Sender,
    };

    private static readonly System.Text.RegularExpressions.Regex SenderId = new("^[a-z0-9][a-z0-9-]{0,30}$");

    /// <summary>A sender id the sidecar accepts, or null; 'default' always resolves.</summary>
    private static string? SenderOf(string? raw)
    {
        var id = (raw ?? WhatsAppClient.DefaultSender).Trim().ToLowerInvariant();
        if (id.Length == 0) id = WhatsAppClient.DefaultSender;
        return SenderId.IsMatch(id) ? id : null;
    }

    private static object StatusView(WhatsAppClient.Status s) =>
        new { s.State, s.Qr, pairingCode = s.PairingCode, s.Me, s.Since, s.Error };

    private static object ConfigView(WhatsAppConfig c) => new
    {
        c.Enabled, c.Auto, c.AllClients, allowlist = c.Allowlist, c.Caption, c.MinGapSeconds, c.MaxGapSeconds,
        c.DailyCap, c.QuietFrom, c.QuietTo, c.AutoSince,
    };

    public sealed record SettingsBody(bool? Enabled, bool? Auto, bool? AllClients, IReadOnlyList<string>? Allowlist,
                                      string? Caption, int? MinGapSeconds, int? MaxGapSeconds, int? DailyCap,
                                      string? QuietFrom, string? QuietTo);
    public sealed record PairBody(string? Phone, string? Sender);
    public sealed record SenderBody(string? Sender);
    public sealed record NewSenderBody(string? Id, string? Name);
    public sealed record ClientsBody(IReadOnlyList<string>? Clients);
    public sealed record TestBody(string? Phone, string? Sid, string? Sender);
    public sealed record SendBody(int Pid, IReadOnlyList<string>? Sids, string? Phone);

    private static async Task<IResult> Get(
        System.Security.Claims.ClaimsPrincipal principal, WhatsAppOptions options, WhatsAppSettings settings,
        WhatsAppRepository queue, WhatsAppClient wa, CancellationToken ct)
    {
        if (!IsEditor(principal)) return Results.NotFound();
        if (options.Instance is null) return Results.Ok(new { configured = false });
        var cfg = await settings.GetAsync(ct).ConfigureAwait(false);
        var statuses = await wa.StatusesAsync(ct).ConfigureAwait(false);
        var counts = await queue.CountsAsync(DateTime.UtcNow.AddHours(-24), ct).ConfigureAwait(false);
        var clients = await queue.ClientsAsync(ct).ConfigureAwait(false);
        var lab = Domain.NobleTime.NowForNoble();
        var midnightUtc = DateTime.UtcNow - lab.TimeOfDay;
        var sentToday = await queue.SentSinceAsync(midnightUtc, null, ct).ConfigureAwait(false);

        // The extra numbers, each with its live state. A sender the database
        // knows but the sidecar does not (its volume was lost) is started
        // again here, so it shows a QR instead of nothing.
        var extra = new List<object>();
        foreach (var s in await queue.SendersAsync(ct).ConfigureAwait(false))
        {
            var st = statuses?.GetValueOrDefault(s.Id);
            if (st is null && statuses is not null)
            {
                try { await wa.AddSenderAsync(s.Id, ct).ConfigureAwait(false); st = await wa.StatusAsync(s.Id, ct).ConfigureAwait(false); }
                catch (HttpRequestException) { /* shown as missing */ }
            }
            extra.Add(new
            {
                s.Id, s.Name, s.Clients, s.CreatedAt,
                status = StatusView(st ?? (statuses is null ? WhatsAppClient.Status.Unreachable : WhatsAppClient.Status.Missing)),
                sentToday = await queue.SentSinceAsync(midnightUtc, s.Id, ct).ConfigureAwait(false),
            });
        }
        var dflt = statuses?.GetValueOrDefault(WhatsAppClient.DefaultSender) ?? WhatsAppClient.Status.Unreachable;
        return Results.Ok(new
        {
            configured = true,
            instance = options.Instance,
            // Only prod looks for released visits by itself; see WhatsAppOptions.
            autoCapable = options.AutoEnqueue,
            requiresAllowlist = !options.IsProd,
            settings = ConfigView(cfg),
            status = StatusView(dflt),
            senders = extra,
            counts,
            sentToday,
            clients,
        });
    }

    private static async Task<IResult> Put(
        SettingsBody body, System.Security.Claims.ClaimsPrincipal principal, HttpContext http, WhatsAppOptions options,
        WhatsAppSettings settings, Audit.AuditLog audit, CancellationToken ct)
    {
        if (!IsEditor(principal) || principal.UserId() is not int actor) return Results.NotFound();
        if (options.Instance is null) return Results.Problem("WhatsApp is not configured on this server.", statusCode: 409);
        var before = await settings.GetAsync(ct).ConfigureAwait(false);
        var set = new Dictionary<string, string>(StringComparer.Ordinal);
        static string B(bool v) => v ? "1" : "0";

        if (body.Enabled is bool en) set["enabled"] = B(en);
        if (body.AllClients is bool all) set["all_clients"] = B(all);
        if (body.Auto is bool auto)
        {
            set["auto"] = B(auto);
            // Switching auto-send on starts the clock: nothing released before
            // this moment is ever sent automatically.
            if (auto && !before.Auto) set["auto_since"] = DateTime.UtcNow.ToString("O", CultureInfo.InvariantCulture);
        }
        if (body.Allowlist is not null)
        {
            var nums = new List<string>();
            foreach (var raw in body.Allowlist)
            {
                if (string.IsNullOrWhiteSpace(raw)) continue;
                if (Phone.Normalise(raw) is not { } p) return Results.BadRequest(new { error = $"Not an Indian mobile number: {raw}" });
                if (!nums.Contains(p)) nums.Add(p);
            }
            if (nums.Count > 50) return Results.BadRequest(new { error = "Up to 50 numbers on the allowlist." });
            set["allowlist"] = string.Join(",", nums);
        }
        if (body.Caption is not null)
        {
            var c = body.Caption.Trim();
            if (c.Length is 0 or > 1000) return Results.BadRequest(new { error = "The message must be 1–1000 characters." });
            set["caption"] = c;
        }
        var min = body.MinGapSeconds ?? before.MinGapSeconds;
        var max = body.MaxGapSeconds ?? before.MaxGapSeconds;
        if (min < 15 || max < min || max > 3600)
            return Results.BadRequest(new { error = "The gap between messages must be at least 15 seconds, and the longest no shorter than the shortest." });
        if (body.MinGapSeconds is not null) set["min_gap_s"] = min.ToString(CultureInfo.InvariantCulture);
        if (body.MaxGapSeconds is not null) set["max_gap_s"] = max.ToString(CultureInfo.InvariantCulture);
        if (body.DailyCap is int cap)
        {
            if (cap is < 1 or > 1000) return Results.BadRequest(new { error = "The daily cap must be between 1 and 1000." });
            set["daily_cap"] = cap.ToString(CultureInfo.InvariantCulture);
        }
        foreach (var (key, v) in new[] { ("quiet_from", body.QuietFrom), ("quiet_to", body.QuietTo) })
        {
            if (v is null) continue;
            if (!TimeSpan.TryParseExact(v.Trim(), @"hh\:mm", CultureInfo.InvariantCulture, out _))
                return Results.BadRequest(new { error = "Quiet hours are times like 21:00." });
            set[key] = v.Trim();
        }

        await settings.SetAsync(set, actor, ct).ConfigureAwait(false);
        var after = await settings.GetAsync(ct).ConfigureAwait(false);
        audit.Log("settings.whatsapp", actor: actor, ip: Audit.AuditIp.From(http),
            details: new { instance = options.Instance, changed = set.Keys, from = ConfigView(before), to = ConfigView(after) });
        return Results.Ok(ConfigView(after));
    }

    private static async Task<IResult> Pair(
        PairBody body, System.Security.Claims.ClaimsPrincipal principal, HttpContext http, WhatsAppClient wa,
        Audit.AuditLog audit, CancellationToken ct)
    {
        if (!IsEditor(principal) || principal.UserId() is not int actor) return Results.NotFound();
        if (Phone.Normalise(body.Phone) is not { } phone) return Results.BadRequest(new { error = "Enter the WhatsApp number to link." });
        if (SenderOf(body.Sender) is not { } sender) return Results.BadRequest(new { error = "Not a sender." });
        var r = await wa.PairAsync(sender, phone, ct).ConfigureAwait(false);
        if (r is not null) return Results.BadRequest(new { error = r });
        audit.Log("settings.whatsapp", actor: actor, ip: Audit.AuditIp.From(http), details: new { op = "pair", sender, phone = Phone.Mask(phone) });
        return Results.Ok(new { ok = true });
    }

    private static async Task<IResult> Logout(
        SenderBody body, System.Security.Claims.ClaimsPrincipal principal, HttpContext http, WhatsAppClient wa, Audit.AuditLog audit, CancellationToken ct)
    {
        if (!IsEditor(principal) || principal.UserId() is not int actor) return Results.NotFound();
        if (SenderOf(body.Sender) is not { } sender) return Results.BadRequest(new { error = "Not a sender." });
        await wa.LogoutAsync(sender, ct).ConfigureAwait(false);
        audit.Log("settings.whatsapp", actor: actor, ip: Audit.AuditIp.From(http), details: new { op = "unlink", sender });
        return Results.Ok(new { ok = true });
    }

    private static async Task<IResult> AddSender(
        NewSenderBody body, System.Security.Claims.ClaimsPrincipal principal, HttpContext http, WhatsAppOptions options,
        WhatsAppRepository queue, WhatsAppClient wa, Audit.AuditLog audit, CancellationToken ct)
    {
        if (!IsEditor(principal) || principal.UserId() is not int actor) return Results.NotFound();
        if (options.Instance is null) return Results.Problem("WhatsApp is not configured on this server.", statusCode: 409);
        var name = body.Name?.Trim() ?? "";
        if (name.Length is 0 or > 80) return Results.BadRequest(new { error = "Give the number a name, up to 80 characters." });
        // The id is the name made safe, or whatever was typed if it already is.
        var id = SenderOf(string.IsNullOrWhiteSpace(body.Id)
            ? System.Text.RegularExpressions.Regex.Replace(name.ToLowerInvariant(), "[^a-z0-9]+", "-").Trim('-')
            : body.Id);
        if (id is null || id == WhatsAppClient.DefaultSender)
            return Results.BadRequest(new { error = "The id must be letters, digits and hyphens, and not 'default'." });
        if (!await queue.AddSenderAsync(id, name, actor, ct).ConfigureAwait(false))
            return Results.BadRequest(new { error = $"A sender '{id}' already exists." });
        try { await wa.AddSenderAsync(id, ct).ConfigureAwait(false); }
        catch (HttpRequestException) { /* the overview re-adds it when the sidecar is back */ }
        audit.Log("settings.whatsapp", actor: actor, ip: Audit.AuditIp.From(http), details: new { op = "sender_add", id, name });
        return Results.Ok(new { id, name });
    }

    private static async Task<IResult> RemoveSender(
        string id, System.Security.Claims.ClaimsPrincipal principal, HttpContext http, WhatsAppRepository queue,
        WhatsAppClient wa, Audit.AuditLog audit, CancellationToken ct)
    {
        if (!IsEditor(principal) || principal.UserId() is not int actor) return Results.NotFound();
        if (SenderOf(id) is not { } sender || sender == WhatsAppClient.DefaultSender)
            return Results.BadRequest(new { error = "The default number cannot be removed." });
        try { await wa.RemoveSenderAsync(sender, ct).ConfigureAwait(false); }
        catch (HttpRequestException) { /* its directory goes when the sidecar next sees no row for it */ }
        await queue.RemoveSenderAsync(sender, ct).ConfigureAwait(false);
        audit.Log("settings.whatsapp", actor: actor, ip: Audit.AuditIp.From(http), details: new { op = "sender_remove", sender });
        return Results.Ok(new { ok = true });
    }

    private static async Task<IResult> PutSenderClients(
        string id, ClientsBody body, System.Security.Claims.ClaimsPrincipal principal, HttpContext http,
        WhatsAppRepository queue, Audit.AuditLog audit, CancellationToken ct)
    {
        if (!IsEditor(principal) || principal.UserId() is not int actor) return Results.NotFound();
        if (SenderOf(id) is not { } sender || sender == WhatsAppClient.DefaultSender)
            return Results.BadRequest(new { error = "Clients are assigned to the extra numbers; everyone else uses the default." });
        if (!(await queue.SendersAsync(ct).ConfigureAwait(false)).Any(s => s.Id == sender)) return Results.NotFound();
        var codes = (body.Clients ?? [])
            .Select(c => c?.Trim().ToUpperInvariant() ?? "")
            .Where(c => c.Length is > 0 and <= 50)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();
        if (codes.Count > 2000) return Results.BadRequest(new { error = "Up to 2000 client codes." });
        var unknown = await queue.SetSenderClientsAsync(sender, codes, actor, ct).ConfigureAwait(false);
        audit.Log("settings.whatsapp", actor: actor, ip: Audit.AuditIp.From(http), details: new { op = "sender_clients", sender, codes, unknown });
        return Results.Ok(new { unknown });
    }

    private static async Task<IResult> PutClients(
        ClientsBody body, System.Security.Claims.ClaimsPrincipal principal, HttpContext http, WhatsAppRepository queue,
        Audit.AuditLog audit, CancellationToken ct)
    {
        if (!IsEditor(principal) || principal.UserId() is not int actor) return Results.NotFound();
        var codes = (body.Clients ?? [])
            .Select(c => c?.Trim().ToUpperInvariant() ?? "")
            .Where(c => c.Length is > 0 and <= 50)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();
        if (codes.Count > 2000) return Results.BadRequest(new { error = "Up to 2000 client codes." });
        var before = await queue.ClientsAsync(ct).ConfigureAwait(false);
        var unknown = await queue.SetClientsAsync(codes, actor, ct).ConfigureAwait(false);
        var after = await queue.ClientsAsync(ct).ConfigureAwait(false);
        audit.Log("settings.whatsapp", actor: actor, ip: Audit.AuditIp.From(http),
            details: new { op = "clients", from = before, to = after, unknown });
        return Results.Ok(new { clients = after, unknown });
    }

    private static async Task<IResult> Test(
        TestBody body, System.Security.Claims.ClaimsPrincipal principal, HttpContext http, WhatsAppOptions options,
        WhatsAppRepository queue, Audit.AuditLog audit, CancellationToken ct)
    {
        if (!IsEditor(principal) || principal.UserId() is not int actor) return Results.NotFound();
        if (options.Instance is null) return Results.Problem("WhatsApp is not configured on this server.", statusCode: 409);
        if (Phone.Normalise(body.Phone) is not { } phone) return Results.BadRequest(new { error = "Enter a 10-digit mobile number." });
        var sid = string.IsNullOrWhiteSpace(body.Sid) ? null : body.Sid.Trim();
        if (sid is { Length: > 50 }) return Results.BadRequest(new { error = "A sample ID is at most 50 characters." });
        if (SenderOf(body.Sender) is not { } sender) return Results.BadRequest(new { error = "Not a sender." });
        var id = await queue.EnqueueAsync(null, sid is null ? [] : [sid], null, "Test", phone, "test", "test", actor, sender, ct).ConfigureAwait(false);
        audit.Log("settings.whatsapp", actor: actor, ip: Audit.AuditIp.From(http),
            details: new { op = "test", sender, phone = Phone.Mask(phone), sid, messageId = id });
        return Results.Ok(new { id, phone = Phone.Mask(phone) });
    }

    private static async Task<IResult> Messages(
        string? status, string? q, int? page, System.Security.Claims.ClaimsPrincipal principal, WhatsAppOptions options,
        WhatsAppRepository queue, CancellationToken ct)
    {
        if (!IsEditor(principal)) return Results.NotFound();
        if (options.Instance is null) return Results.Ok(new { rows = Array.Empty<object>(), total = 0, page = 1, size = 50 });
        var s = status is "queued" or "sending" or "sent" or "delivered" or "read" or "failed" or "skipped" ? status : null;
        var query = string.IsNullOrWhiteSpace(q) ? null : q.Trim()[..Math.Min(q.Trim().Length, 60)];
        // A number typed as 98123… is stored as 9198123…: search on the digits.
        if (query is not null && Phone.Normalise(query) is { } asPhone) query = asPhone;
        var p = Math.Max(1, page ?? 1);
        const int size = 50;
        var (rows, total) = await queue.ListAsync(s, query, p, size, ct).ConfigureAwait(false);
        return Results.Ok(new { rows = rows.Select(MessageView), total, page = p, size });
    }

    private static async Task<IResult> Retry(
        long id, System.Security.Claims.ClaimsPrincipal principal, HttpContext http, WhatsAppRepository queue,
        Audit.AuditLog audit, CancellationToken ct)
    {
        if (!IsEditor(principal) || principal.UserId() is not int actor) return Results.NotFound();
        var n = await queue.RequeueAsync(id, ct).ConfigureAwait(false);
        if (n == 0) return Results.BadRequest(new { error = "Only a failed or skipped message can be retried." });
        audit.Log("settings.whatsapp", actor: actor, ip: Audit.AuditIp.From(http), details: new { op = "retry", messageId = id });
        return Results.Ok(new { ok = true });
    }

    private static async Task<IResult> OptIn(
        string phone, System.Security.Claims.ClaimsPrincipal principal, HttpContext http, WhatsAppRepository queue,
        Audit.AuditLog audit, CancellationToken ct)
    {
        if (!IsEditor(principal) || principal.UserId() is not int actor) return Results.NotFound();
        if (Phone.Normalise(phone) is not { } p) return Results.BadRequest(new { error = "Not a mobile number." });
        var n = await queue.OptInAsync(p, ct).ConfigureAwait(false);
        audit.Log("settings.whatsapp", actor: actor, ip: Audit.AuditIp.From(http), details: new { op = "opt_in", phone = Phone.Mask(p) });
        return Results.Ok(new { removed = n });
    }

    /// <summary>"Send on WhatsApp" from the Reporting list: queue this visit's released reports.</summary>
    private static async Task<IResult> SendReport(
        SendBody body, System.Security.Claims.ClaimsPrincipal principal, HttpContext http, WhatsAppOptions options,
        WhatsAppSettings settings, WhatsAppRepository queue, ScopeRepository scopes, Reads.ReportsRepository repo,
        Audit.AuditLog audit, CancellationToken ct)
    {
        if (principal.UserId() is not int actor) return Results.Unauthorized();
        if (!InfinityRoles.IsUnrestrictedReporter(principal.Role()))
            return Results.Problem("Reports are sent on WhatsApp by the lab.", statusCode: StatusCodes.Status403Forbidden);
        if (options.Instance is null) return Results.Problem("WhatsApp is not set up on this server.", statusCode: 409);
        var cfg = await settings.GetAsync(ct).ConfigureAwait(false);
        if (!cfg.Enabled)
            return Results.Problem("WhatsApp sending is switched off. An admin can switch it on in Admin → WhatsApp.", statusCode: 409);

        var patient = await queue.PatientAsync(body.Pid, ct).ConfigureAwait(false);
        if (patient is null) return Results.NotFound();
        var wanted = (body.Sids ?? []).Select(s => s.Trim()).Where(s => s.Length is > 0 and <= 50).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var sids = patient.ReleasedSids.Where(s => wanted.Count == 0 || wanted.Contains(s)).ToList();
        if (sids.Count == 0)
            return Results.Problem("Nothing released to send for this patient yet.", statusCode: StatusCodes.Status422UnprocessableEntity);

        var typed = string.IsNullOrWhiteSpace(body.Phone) ? null : Phone.Normalise(body.Phone);
        if (!string.IsNullOrWhiteSpace(body.Phone) && typed is null)
            return Results.BadRequest(new { error = "Enter a 10-digit mobile number." });
        var phone = typed ?? patient.Phone;
        if (phone is null)
            return Results.Problem("No mobile number on this patient.", statusCode: StatusCodes.Status422UnprocessableEntity,
                extensions: new Dictionary<string, object?> { ["code"] = "NO_MOBILE" });
        if (await queue.IsOptedOutAsync(phone, ct).ConfigureAwait(false))
            return Results.Problem("This number replied STOP to our reports; nothing more is sent to it.", statusCode: 409);

        // The client's own number if it has one, else the lab's.
        var sender = await queue.SenderForAsync(patient.ClientCode, ct).ConfigureAwait(false);
        var id = await queue.EnqueueAsync(patient.Pid, sids, patient.ClientCode, patient.PatientName, phone, "report", "manual", actor, sender, ct)
            .ConfigureAwait(false);
        audit.Log("report.whatsapp_queued", actor: actor, sid: sids[0], ip: Audit.AuditIp.From(http),
            details: new { pid = patient.Pid, sids, phone = Phone.Mask(phone), typed = typed is not null, sender, messageId = id });
        return Results.Ok(new { id, phone = Phone.Mask(phone), samples = sids.Count, sender });
    }

    private static async Task<IResult> ReportStatus(
        string? pids, System.Security.Claims.ClaimsPrincipal principal, WhatsAppOptions options, WhatsAppRepository queue,
        CancellationToken ct)
    {
        if (!InfinityRoles.IsUnrestrictedReporter(principal.Role()) || options.Instance is null) return Results.Ok(new { });
        var list = (pids ?? "").Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(s => int.TryParse(s, NumberStyles.None, CultureInfo.InvariantCulture, out var n) ? n : 0)
            .Where(n => n > 0).Distinct().Take(500).ToList();
        var latest = await queue.LatestForPidsAsync(list, ct).ConfigureAwait(false);
        return Results.Ok(latest.ToDictionary(
            kv => kv.Key.ToString(CultureInfo.InvariantCulture),
            kv => new { kv.Value.Status, at = kv.Value.SentAt ?? kv.Value.CreatedAt, phone = Phone.Mask(kv.Value.Phone), kv.Value.Error }));
    }
}
