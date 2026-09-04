namespace Infinity.Api.Reports;

/// <summary>
/// The paper a report will be printed on — the one question the operator is
/// asked, resolved here into the things the pipeline actually needs: whether
/// the letterhead artwork is composited, which page box the print route lays
/// out for, and where the page number sits.
/// </summary>
/// <remarks>
/// <list type="bullet">
/// <item><c>letterhead</c> — Noble's artwork composited into the PDF, for
/// plain paper and digital copies. 26/10/34/10mm.</item>
/// <item><c>noble</c> — NO artwork, the same 26/10/34/10mm: pre-printed Noble
/// stationery, which already carries the header and footer. Before this mode
/// existed a desk printing on Noble paper had only <c>plain</c>, and its report
/// started 14mm below the printed header.</item>
/// <item><c>plain</c> — no artwork, 40/14/40/14mm: a client's own stationery,
/// whose header band is taller than Noble's.</item>
/// </list>
/// The print route reads the same key from <c>?paper=</c> to choose its
/// <c>@page</c> margins, so the layout and the compositing can never disagree;
/// the render sidecar gets <see cref="Headless"/>, <see cref="PageNumberY"/>
/// and <see cref="PageNumberRight"/> so the stamp sits on the same margins.
/// The legacy <c>headless</c> flag still resolves — true is <c>plain</c>, false
/// is <c>letterhead</c> — so an older client keeps getting exactly the document
/// it used to. The key rides in the PDF cache key, because two of the three
/// modes share margins and differ only in artwork.
/// </remarks>
public readonly record struct ReportPaper(string Key, bool Artwork, double PageNumberY, double SideMm)
{
    public static readonly ReportPaper Letterhead = new("letterhead", Artwork: true, PageNumberY: 99, SideMm: 10);
    public static readonly ReportPaper Noble = new("noble", Artwork: false, PageNumberY: 99, SideMm: 10);
    public static readonly ReportPaper Plain = new("plain", Artwork: false, PageNumberY: 116, SideMm: 14);

    /// <summary>Skip the letterhead artwork — what the render sidecar calls <c>headless</c>.</summary>
    public bool Headless => !Artwork;

    /// <summary>The page number's inset from the paper's right edge, in points — the side margin.</summary>
    public double PageNumberRight => SideMm / 25.4 * 72;

    /// <summary>The query fragment the print route reads to pick its margins.</summary>
    public string Query => "&paper=" + Key;

    public static ReportPaper Resolve(string? paper, bool? headless) =>
        paper?.Trim().ToLowerInvariant() switch
        {
            "letterhead" => Letterhead,
            "noble" => Noble,
            "plain" => Plain,
            _ => headless == true ? Plain : Letterhead,
        };
}
