using System.Text.Json;
using System.Text.Json.Serialization;

namespace Infinity.Api.Reports;

/// <summary>
/// The render service's client.
/// </summary>
/// <remarks>
/// <para>
/// The API cannot drive a browser, so the one job that needs one — turning the
/// SPA's print route into a PDF — lives in a sidecar. This is the only thing
/// that talks to it.
/// </para>
/// <para>
/// The caller's <c>Cookie</c> header is forwarded verbatim and replayed by the
/// renderer against the SPA's internal origin. That is what makes the PDF show
/// exactly what THIS user is allowed to see: the print route runs the same
/// scope checks as every other route, so a renderer holding a client-scoped
/// user's cookie cannot photograph another client's report. The corollary is
/// that the sidecar must never be published — it renders whatever URL it is
/// given with whatever cookie it is handed.
/// </para>
/// </remarks>
public sealed class RenderClient(HttpClient http, ILogger<RenderClient> log)
{
    private static readonly JsonSerializerOptions Json = new()
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    /// <summary>One report in a render request: a print URL plus anything stapled after it.</summary>
    /// <param name="PdfB64">
    /// A FINISHED report — letterhead, numbers, attachments already in — that
    /// only needs concatenating into the batch. The cache's currency: a batch
    /// re-downloaded minutes later renders nothing and merely re-staples.
    /// When set, Url is ignored.
    /// </param>
    public sealed record ReportRequest(
        [property: JsonPropertyName("url")] string? Url,
        [property: JsonPropertyName("attachments")] IReadOnlyList<Attachment>? Attachments = null,
        [property: JsonPropertyName("headless")] bool? Headless = null,
        [property: JsonPropertyName("pageNumbers")] bool? PageNumbers = null,
        [property: JsonPropertyName("pageNumberY")] double? PageNumberY = null,
        [property: JsonPropertyName("pdfB64")] string? PdfB64 = null);

    /// <summary>A graph or image to staple after a report's own pages.</summary>
    public sealed record Attachment(
        [property: JsonPropertyName("b64")] string B64,
        [property: JsonPropertyName("mime")] string Mime);

    private sealed record Envelope(
        [property: JsonPropertyName("cookie")] string? Cookie,
        [property: JsonPropertyName("reports")] IReadOnlyList<ReportRequest> Reports,
        [property: JsonPropertyName("numberPages")] bool NumberPages = false);

    /// <summary>
    /// Render one or more reports into a single PDF. A batch goes in one call
    /// on purpose: the sidecar keeps a warm browser and renders the batch
    /// against it, so a merged download pays one startup rather than N.
    /// </summary>
    public async Task<byte[]> RenderAsync(
        IReadOnlyList<ReportRequest> reports,
        string? cookieHeader,
        CancellationToken ct = default,
        // After ct, unconventionally, so the existing call sites that pass ct
        // positionally keep meaning what they said. Named at the one caller.
        bool numberPages = false)
    {
        if (reports.Count == 0) throw new ArgumentException("No reports to render.", nameof(reports));

        using var content = new StringContent(
            JsonSerializer.Serialize(new Envelope(cookieHeader, reports, numberPages), Json),
            System.Text.Encoding.UTF8,
            "application/json");

        using var res = await http.PostAsync("/render", content, ct).ConfigureAwait(false);

        if (!res.IsSuccessStatusCode)
        {
            // The sidecar's message names the print route that failed, which is
            // the useful half. It never reaches the caller — a render failure is
            // a 502 with nothing in it, because the URL it mentions is internal.
            var detail = await res.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
            log.LogError("render failed: HTTP {Status} {Detail}", (int)res.StatusCode, detail);
            throw new RenderFailedException($"The render service returned HTTP {(int)res.StatusCode}.");
        }

        return await res.Content.ReadAsByteArrayAsync(ct).ConfigureAwait(false);
    }
}

public sealed class RenderFailedException(string message) : Exception(message);
