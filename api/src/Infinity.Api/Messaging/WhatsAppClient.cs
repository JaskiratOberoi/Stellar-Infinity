using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Serialization;

namespace Infinity.Api.Messaging;

/// <summary>
/// The WhatsApp sidecar's client (../whatsapp/server.mjs): a linked WhatsApp
/// Web session that sends one message at a time. Everything about WHO and
/// WHEN is decided on this side, in <see cref="WhatsAppWorker"/>.
/// </summary>
public sealed class WhatsAppClient(HttpClient http, ILogger<WhatsAppClient> log)
{
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
        public bool Ready => State == "ready";
    }

    public sealed record Event(
        [property: JsonPropertyName("seq")] long Seq,
        [property: JsonPropertyName("type")] string Type,
        [property: JsonPropertyName("id")] string? Id,
        [property: JsonPropertyName("ack")] int? Ack,
        [property: JsonPropertyName("from")] string? From);

    private sealed record EventsResponse(
        [property: JsonPropertyName("events")] IReadOnlyList<Event> Events,
        [property: JsonPropertyName("last")] long Last);

    public enum SendOutcome { Sent, NotOnWhatsApp, NotReady, BadNumber, Failed }

    public sealed record SendResult(SendOutcome Outcome, string? WaId, string? Error);

    public async Task<Status> StatusAsync(CancellationToken ct = default)
    {
        try
        {
            return await http.GetFromJsonAsync<Status>("/status", ct).ConfigureAwait(false) ?? Status.Unreachable;
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException)
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
    public async Task<SendResult> SendAsync(string to, string text, byte[]? pdf, string? filename, CancellationToken ct = default)
    {
        try
        {
            using var res = await http.PostAsJsonAsync("/send", new
            {
                to,
                text,
                pdfB64 = pdf is null ? null : Convert.ToBase64String(pdf),
                filename,
            }, ct).ConfigureAwait(false);
            if (res.IsSuccessStatusCode)
            {
                var ok = await res.Content.ReadFromJsonAsync<Dictionary<string, string>>(ct).ConfigureAwait(false);
                return new SendResult(SendOutcome.Sent, ok?.GetValueOrDefault("id"), null);
            }
            var body = await res.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
            return res.StatusCode switch
            {
                (HttpStatusCode)422 => new SendResult(SendOutcome.NotOnWhatsApp, null, "This number is not on WhatsApp."),
                HttpStatusCode.ServiceUnavailable => new SendResult(SendOutcome.NotReady, null, "WhatsApp is not linked or not ready."),
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
    public async Task<string?> PairAsync(string phone, CancellationToken ct = default)
    {
        try
        {
            using var res = await http.PostAsJsonAsync("/pair", new { phone }, ct).ConfigureAwait(false);
            if (res.IsSuccessStatusCode) return null;
            return res.StatusCode == HttpStatusCode.Conflict
                ? "A number is already linked. Unlink it first."
                : "That number could not be used for linking.";
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException)
        {
            return "The WhatsApp service is not reachable.";
        }
    }

    public async Task LogoutAsync(CancellationToken ct = default)
    {
        using var res = await http.PostAsync("/logout", null, ct).ConfigureAwait(false);
        res.EnsureSuccessStatusCode();
    }

    private static string Trim(string s) => s.Length > 380 ? s[..380] : s;
}
