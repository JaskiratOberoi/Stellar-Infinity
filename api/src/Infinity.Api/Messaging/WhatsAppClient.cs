using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Infinity.Api.Messaging;

/// <summary>
/// The WhatsApp sidecar's client (../whatsapp/server.mjs): linked WhatsApp
/// Web sessions — the 'default' universal number and any added senders —
/// each sending one message at a time. Everything about WHO and WHEN is
/// decided on this side, in <see cref="WhatsAppWorker"/>.
/// </summary>
public sealed class WhatsAppClient(HttpClient http, ILogger<WhatsAppClient> log)
{
    public const string DefaultSender = "default";

    public sealed record Me(
        [property: JsonPropertyName("number")] string? Number,
        [property: JsonPropertyName("name")] string? Name);

    /// <summary>state: starting | qr | ready | disconnected | unreachable.</summary>
    public sealed record Status(
        [property: JsonPropertyName("state")] string State,
        [property: JsonPropertyName("qr")] string? Qr,
        [property: JsonPropertyName("pairingCode")] string? PairingCode,
        [property: JsonPropertyName("me")] Me? Me,
        [property: JsonPropertyName("since")] string? Since,
        [property: JsonPropertyName("error")] string? Error)
    {
        public static readonly Status Unreachable = new("unreachable", null, null, null, null, "The WhatsApp service is not running.");
        public static readonly Status Missing = new("missing", null, null, null, null, "This sender is not on the WhatsApp service yet.");
        public bool Ready => State == "ready";
    }

    private sealed record AllStatus([property: JsonPropertyName("senders")] Dictionary<string, Status> Senders);

    public sealed record Event(
        [property: JsonPropertyName("seq")] long Seq,
        [property: JsonPropertyName("sender")] string? Sender,
        [property: JsonPropertyName("type")] string Type,
        [property: JsonPropertyName("id")] string? Id,
        [property: JsonPropertyName("ack")] int? Ack,
        [property: JsonPropertyName("from")] string? From);

    private sealed record EventsResponse(
        [property: JsonPropertyName("events")] IReadOnlyList<Event> Events,
        [property: JsonPropertyName("last")] long Last);

    public enum SendOutcome { Sent, NotOnWhatsApp, NotReady, BadNumber, Failed }

    public sealed record SendResult(SendOutcome Outcome, string? WaId, string? Error);

    /// <summary>Every sender the sidecar holds. Empty when it is unreachable.</summary>
    public async Task<IReadOnlyDictionary<string, Status>?> StatusesAsync(CancellationToken ct = default)
    {
        try
        {
            var r = await http.GetFromJsonAsync<AllStatus>("/status", ct).ConfigureAwait(false);
            return r?.Senders;
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException or JsonException)
        {
            return null;
        }
    }

    public async Task<Status> StatusAsync(string sender = DefaultSender, CancellationToken ct = default)
    {
        try
        {
            using var res = await http.GetAsync($"/status?sender={Uri.EscapeDataString(sender)}", ct).ConfigureAwait(false);
            if (res.StatusCode == HttpStatusCode.NotFound) return Status.Missing;
            res.EnsureSuccessStatusCode();
            return await res.Content.ReadFromJsonAsync<Status>(ct).ConfigureAwait(false) ?? Status.Unreachable;
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException or JsonException)
        {
            return Status.Unreachable;
        }
    }

    public async Task<(IReadOnlyList<Event> Events, long Last)> EventsAsync(long after, CancellationToken ct = default)
    {
        try
        {
            var r = await http.GetFromJsonAsync<EventsResponse>($"/events?after={after}", ct).ConfigureAwait(false);
            return r is null ? ([], after) : (r.Events, r.Last);
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException)
        {
            return ([], after);
        }
    }

    /// <param name="to">Digits with country code, e.g. 919812345678.</param>
    public async Task<SendResult> SendAsync(string sender, string to, string text, byte[]? pdf, string? filename, CancellationToken ct = default)
    {
        try
        {
            using var res = await http.PostAsJsonAsync("/send", new
            {
                sender,
                to,
                text,
                pdfB64 = pdf is null ? null : Convert.ToBase64String(pdf),
                filename,
            }, ct).ConfigureAwait(false);
            if (res.IsSuccessStatusCode)
            {
                // {id, unconfirmed}: id null when WhatsApp Web sent without
                // handing back the message — sent, but no ticks will follow.
                var ok = await res.Content.ReadFromJsonAsync<JsonElement>(ct).ConfigureAwait(false);
                var id = ok.TryGetProperty("id", out var i) && i.ValueKind == JsonValueKind.String ? i.GetString() : null;
                return new SendResult(SendOutcome.Sent, id, id is null ? "Sent, but WhatsApp Web gave no message ID, so no delivery ticks." : null);
            }
            var body = await res.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
            return res.StatusCode switch
            {
                (HttpStatusCode)422 => new SendResult(SendOutcome.NotOnWhatsApp, null, "This number is not on WhatsApp."),
                HttpStatusCode.ServiceUnavailable => new SendResult(SendOutcome.NotReady, null, "WhatsApp is not linked or not ready."),
                HttpStatusCode.NotFound => new SendResult(SendOutcome.NotReady, null, "That sender is not on the WhatsApp service."),
                HttpStatusCode.BadRequest => new SendResult(SendOutcome.BadNumber, null, "Not a valid mobile number."),
                _ => new SendResult(SendOutcome.Failed, null, Trim(body)),
            };
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException)
        {
            log.LogWarning(e, "wa.send unreachable");
            return new SendResult(SendOutcome.NotReady, null, "The WhatsApp service is not reachable.");
        }
    }

    /// <summary>Link by phone-number code instead of QR. Null on success, else why not.</summary>
    public async Task<string?> PairAsync(string sender, string phone, CancellationToken ct = default)
    {
        try
        {
            using var res = await http.PostAsJsonAsync("/pair", new { sender, phone }, ct).ConfigureAwait(false);
            if (res.IsSuccessStatusCode) return null;
            return res.StatusCode switch
            {
                HttpStatusCode.Conflict => "A number is already linked on this sender. Unlink it first.",
                HttpStatusCode.NotFound => "That sender is not on the WhatsApp service.",
                _ => "That number could not be used for linking.",
            };
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException)
        {
            return "The WhatsApp service is not reachable.";
        }
    }

    public async Task LogoutAsync(string sender, CancellationToken ct = default)
    {
        using var res = await http.PostAsJsonAsync("/logout", new { sender }, ct).ConfigureAwait(false);
        res.EnsureSuccessStatusCode();
    }

    /// <summary>Start a session for a new sender (a QR follows). Idempotent.</summary>
    public async Task AddSenderAsync(string sender, CancellationToken ct = default)
    {
        using var res = await http.PostAsJsonAsync("/senders", new { id = sender }, ct).ConfigureAwait(false);
        res.EnsureSuccessStatusCode();
    }

    /// <summary>Unlink, stop and forget a sender's session.</summary>
    public async Task RemoveSenderAsync(string sender, CancellationToken ct = default)
    {
        using var res = await http.DeleteAsync($"/senders/{Uri.EscapeDataString(sender)}", ct).ConfigureAwait(false);
        if (res.StatusCode != HttpStatusCode.NotFound) res.EnsureSuccessStatusCode();
    }

    private static string Trim(string s) => s.Length > 380 ? s[..380] : s;
}
