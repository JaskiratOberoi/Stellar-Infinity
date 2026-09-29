using Infinity.Api.Domain;
using Infinity.Api.Reads;
using Infinity.Api.Reports;

namespace Infinity.Api.Messaging;

/// <summary>
/// Sends patient reports on WhatsApp through the linked number.
/// </summary>
/// <remarks>
/// <para>
/// One message at a time, like a person at the phone: after each send it waits
/// a random 40–120 s (settings), sends nothing in the quiet hours, and stops
/// for the day at the daily cap. A linked personal number that suddenly sends
/// a report every two seconds is the number WhatsApp bans; pacing is not
/// politeness here, it is what keeps the number alive.
/// </para>
/// <para>
/// What it sends is the patient's copy — exactly the PDF the QR on the report
/// opens: authorised samples only, never one on balance hold, never one
/// without a signatory, on the centre's digital letterhead when it has one.
/// A visit's samples go as one PDF.
/// </para>
/// <para>
/// Automatic sends (prod only, WhatsApp__AutoEnqueue) are for visits whose
/// every sample is released after auto-send was switched on, for the listed
/// clients (or all). Each visit goes automatically once; an amended report is
/// a manual resend from the Reporting list.
/// </para>
/// </remarks>
public sealed class WhatsAppWorker(
    IServiceScopeFactory scopes,
    WhatsAppOptions options,
    WhatsAppSettings settings,
    WhatsAppRepository queue,
    ReportsRepository reports,
    ReportLockRepository locks,
    ReportExtrasRepository extras,
    GraphRepository graphs,
    LetterheadPapers papers,
    ReportLink links,
    Audit.AuditLog audit,
    ILoggerFactory loggers,
    ILogger<WhatsAppWorker> log) : BackgroundService
{
    private static readonly TimeSpan Tick = TimeSpan.FromSeconds(10);
    private static readonly TimeSpan ScanEvery = TimeSpan.FromMinutes(2);
    private const int MaxAttempts = 3;

    private long _eventCursor;
    private DateTime _nextSendUtc = DateTime.MinValue;
    private DateTime _nextScanUtc = DateTime.MinValue;

    protected override async Task ExecuteAsync(CancellationToken stop)
    {
        if (options.Instance is null)
        {
            log.LogInformation("wa.worker off: WhatsApp__Instance is not configured");
            return;
        }
        try { await Task.Delay(TimeSpan.FromSeconds(30), stop).ConfigureAwait(false); }
        catch (OperationCanceledException) { return; }

        while (!stop.IsCancellationRequested)
        {
            try { await TickAsync(stop).ConfigureAwait(false); }
            catch (OperationCanceledException) when (stop.IsCancellationRequested) { return; }
            catch (Exception e) { log.LogError(e, "wa.tick failed"); }
            try { await Task.Delay(Tick, stop).ConfigureAwait(false); }
            catch (OperationCanceledException) { return; }
        }
    }

    private async Task TickAsync(CancellationToken ct)
    {
        using var scope = scopes.CreateScope();
        var wa = scope.ServiceProvider.GetRequiredService<WhatsAppClient>();
        var status = await wa.StatusAsync(ct).ConfigureAwait(false);

        // Delivery ticks and STOP replies, whatever the switches say.
        if (status.Ready) await CollectEventsAsync(wa, ct).ConfigureAwait(false);

        var cfg = await settings.GetAsync(ct).ConfigureAwait(false);
        var now = DateTime.UtcNow;

        if (now >= _nextScanUtc)
        {
            _nextScanUtc = now + ScanEvery;
            await queue.RecoverStuckAsync(ct).ConfigureAwait(false);
            if (cfg.Enabled && cfg.Auto && options.AutoEnqueue && cfg.AutoSince is DateTime since)
                await EnqueueReleasedAsync(cfg, since, ct).ConfigureAwait(false);
        }

        if (!status.Ready || now < _nextSendUtc) return;
        var lab = NobleTime.NowForNoble();
        if (cfg.IsQuiet(lab)) return;
        var labMidnightUtc = now - lab.TimeOfDay;
        if (await queue.SentSinceAsync(labMidnightUtc, ct).ConfigureAwait(false) >= cfg.DailyCap) return;

        // Switched off: only an admin's test message goes.
        var msg = await queue.ClaimNextAsync(testsOnly: !cfg.Enabled, ct).ConfigureAwait(false);
        if (msg is null) return;

        var sent = await ProcessAsync(scope, wa, cfg, msg, ct).ConfigureAwait(false);
        if (sent)
        {
            var gap = Math.Max(5, cfg.MinGapSeconds) + Random.Shared.Next(Math.Max(1, cfg.MaxGapSeconds - cfg.MinGapSeconds + 1));
            _nextSendUtc = DateTime.UtcNow.AddSeconds(gap);
        }
    }

    private async Task CollectEventsAsync(WhatsAppClient wa, CancellationToken ct)
    {
        var (events, last) = await wa.EventsAsync(_eventCursor, ct).ConfigureAwait(false);
        // The sidecar restarted: its sequence began again.
        if (last < _eventCursor) { _eventCursor = 0; return; }
        foreach (var e in events)
        {
            if (e.Type == "ack" && e.Id is { } id && e.Ack is int ack)
                await queue.AckAsync(id, ack, ct).ConfigureAwait(false);
            else if (e.Type == "optout" && Phone.Normalise(e.From) is { } phone)
            {
                await queue.OptOutAsync(phone, "reply", ct).ConfigureAwait(false);
                log.LogInformation("wa.optout phone={Phone}", Phone.Mask(phone));
            }
        }
        _eventCursor = last;
    }

    private async Task EnqueueReleasedAsync(WhatsAppConfig cfg, DateTime autoSinceUtc, CancellationToken ct)
    {
        // The LIS stamps sample times on the lab's clock. Look back two days at
        // most, and never before auto-send was switched on: switching it on
        // must not send a backlog.
        var offset = NobleTime.NowForNoble() - DateTime.UtcNow;
        var sinceLab = autoSinceUtc + offset;
        var floor = NobleTime.NowForNoble().AddDays(-2);
        if (sinceLab < floor) sinceLab = floor;

        var candidates = await queue.CandidatesAsync(sinceLab, cfg.AllClients, 200, ct).ConfigureAwait(false);
        var queued = 0;
        foreach (var c in candidates)
        {
            // Held for a balance: not now. It is looked at again on the next
            // scan, and goes once the hold is lifted (within the two days).
            var held = false;
            foreach (var sid in c.Sids)
                if ((await locks.GetAsync(sid, ct).ConfigureAwait(false)).Locked) { held = true; break; }
            if (held) continue;
            if (await queue.EnqueueAsync(c.Pid, c.Sids, c.ClientCode, c.PatientName, c.Phone, "report", "auto", null, ct)
                    .ConfigureAwait(false) is not null) queued++;
        }
        if (queued > 0) log.LogInformation("wa.auto queued={Queued}", queued);
    }

    /// <returns>True when something went out (so the pacing gap applies).</returns>
    private async Task<bool> ProcessAsync(IServiceScope scope, WhatsAppClient wa, WhatsAppConfig cfg, WaMessage msg, CancellationToken ct)
    {
        if (!settings.MaySendTo(cfg, msg.Phone))
        {
            await queue.MarkAsync(msg.Id, "skipped",
                options.IsProd ? "Not on the allowlist." : "Staging sends only to numbers on its allowlist.", ct: ct).ConfigureAwait(false);
            return false;
        }
        if (await queue.IsOptedOutAsync(msg.Phone, ct).ConfigureAwait(false))
        {
            await queue.MarkAsync(msg.Id, "skipped", "This number replied STOP.", ct: ct).ConfigureAwait(false);
            return false;
        }

        byte[]? pdf = null;
        string? filename = null;
        string text;
        var sids = msg.SidList;

        if (msg.Kind == "test" && sids.Count == 0)
        {
            text = "Test message from Noble Diagnostic Centre (Infinity). If you received this, WhatsApp report delivery is working.";
        }
        else
        {
            var built = await BuildReportAsync(scope, msg, sids, ct).ConfigureAwait(false);
            if (built.Skip is { } why)
            {
                await queue.MarkAsync(msg.Id, "skipped", why, ct: ct).ConfigureAwait(false);
                return false;
            }
            if (built.Pdf is null)
            {
                await FailOrRetryAsync(msg, "The report could not be rendered.", ct).ConfigureAwait(false);
                return false;
            }
            pdf = built.Pdf;
            filename = built.FileName;
            text = msg.Kind == "test"
                ? "Test message from Noble Diagnostic Centre (Infinity) — a sample report."
                : Caption(cfg.Caption, msg);
        }

        var result = await wa.SendAsync(msg.Phone, text, pdf, filename, ct).ConfigureAwait(false);
        switch (result.Outcome)
        {
            case WhatsAppClient.SendOutcome.Sent:
                await queue.MarkAsync(msg.Id, "sent", waId: result.WaId, sent: true, ct: ct).ConfigureAwait(false);
                if (msg.Kind == "report")
                {
                    // On the trail as a report that left, like the QR copy.
                    audit.Log("report.whatsapp", actor: msg.CreatedBy, username: msg.CreatedBy is null ? "whatsapp" : null,
                        sid: sids.FirstOrDefault(),
                        details: new { msg.Pid, sids, phone = Phone.Mask(msg.Phone), msg.Trigger, messageId = msg.Id });
                }
                return true;
            case WhatsAppClient.SendOutcome.NotOnWhatsApp:
            case WhatsAppClient.SendOutcome.BadNumber:
                await queue.MarkAsync(msg.Id, "failed", result.Error, ct: ct).ConfigureAwait(false);
                return false;
            case WhatsAppClient.SendOutcome.NotReady:
                // Not the message's fault: back in the queue without spending an attempt.
                await queue.MarkAsync(msg.Id, "queued", result.Error, ct: ct).ConfigureAwait(false);
                await queue.RefundAttemptAsync(msg.Id, ct).ConfigureAwait(false);
                return false;
            default:
                await FailOrRetryAsync(msg, result.Error ?? "Sending failed.", ct).ConfigureAwait(false);
                return true;
        }
    }

    private Task FailOrRetryAsync(WaMessage msg, string error, CancellationToken ct) =>
        queue.MarkAsync(msg.Id, msg.Attempts >= MaxAttempts ? "failed" : "queued", error, ct: ct);

    private static string Caption(string template, WaMessage msg)
    {
        var name = System.Globalization.CultureInfo.GetCultureInfo("en-IN").TextInfo
            .ToTitleCase((msg.PatientName ?? "Patient").Trim().ToLowerInvariant());
        return template.Replace("{name}", name, StringComparison.OrdinalIgnoreCase)
                       .Replace("{pid}", msg.Pid?.ToString(System.Globalization.CultureInfo.InvariantCulture) ?? "", StringComparison.OrdinalIgnoreCase);
    }

    private sealed record Built(byte[]? Pdf, string? FileName, string? Skip);

    /// <summary>The patient's copy of these samples, as one PDF — or why not.</summary>
    private async Task<Built> BuildReportAsync(IServiceScope scope, WaMessage msg, IReadOnlyList<string> sids, CancellationToken ct)
    {
        var ready = new List<WorksheetRow>();
        foreach (var sid in sids)
        {
            var row = await reports.GetBySidAsync([], sid, ct, publicCopy: true).ConfigureAwait(false);
            if (row is null || row.StatusCode is not (6 or 7 or 8 or 9)) continue;
            if ((await locks.GetAsync(sid, ct).ConfigureAwait(false)).Locked) continue;
            var signoff = await ReportSignoff.RequireAsync(extras, row.Sid, loggers, ct).ConfigureAwait(false);
            if (signoff.Refusal is not null) continue;
            ready.Add(row);
        }
        if (ready.Count == 0)
            return new Built(null, null, "Nothing to send: the report is not released, is on balance hold, or has no signatory.");

        var ordered = await reports.OrderAsLisAsync(ready.Select(r => r.Sid).ToList(), ct).ConfigureAwait(false);
        var sheet = await papers.PublicCopyAsync(ready[0].ClientCode, ct).ConfigureAwait(false);
        var render = scope.ServiceProvider.GetRequiredService<RenderClient>();

        var requests = new List<RenderClient.ReportRequest>();
        foreach (var sid in ordered)
        {
            IReadOnlyList<RenderClient.Attachment>? attachments = null;
            try
            {
                var files = await graphs.GetFilesAsync(sid, ct).ConfigureAwait(false);
                if (files.Count > 0) attachments = files.Select(f => new RenderClient.Attachment(Convert.ToBase64String(f.Bytes), f.Mime)).ToList();
            }
            catch (Exception e) { log.LogWarning(e, "wa.graphs sid={Sid}", sid); }
            requests.Add(new RenderClient.ReportRequest(
                Url: $"/print/report/{Uri.EscapeDataString(sid)}?pdf=1&split=1&t={Uri.EscapeDataString(links.Token(sid))}"
                     + (sheet.LetterheadId is null ? "" : sheet.Query),
                Attachments: attachments,
                Headless: false,
                PageNumbers: false));
        }

        try
        {
            var pdf = await render.RenderAsync(requests, cookieHeader: null, ct, numberPages: true,
                numberPagesY: sheet.PageNumberY, numberPagesRight: sheet.PageNumberRight,
                headless: sheet.Headless, ink: sheet.Ink).ConfigureAwait(false);
            var first = ready.First(r => r.Sid == ordered[0]);
            var id = ordered.Count == 1 ? ordered[0] : $"PID{msg.Pid}";
            return new Built(pdf, ReportFileName.For(first, id), null);
        }
        catch (RenderFailedException e)
        {
            log.LogWarning(e, "wa.render failed message={Id}", msg.Id);
            return new Built(null, null, null);
        }
    }
}
