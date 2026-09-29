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
/// plain paper and digital copies. 23/10/28/10mm.</item>
/// <item><c>noble</c> — NO artwork, the same 23/10/28/10mm: pre-printed Noble
/// stationery, which already carries the header and footer. Before this mode
/// existed a desk printing on Noble paper had only <c>plain</c>, and its report
/// started 14mm below the printed header.</item>
/// <item><c>plain</c> — no artwork, 40/14/40/14mm: a client's own stationery,
/// whose header band is taller than Noble's.</item>
/// <item><c>lh:{id}</c> — a client's own letterhead profile (inf_letterhead,
/// script 171): its own margins, a taller first-sheet header if it has one,
/// its artwork composited when it is a digital letterhead, and the printer's
/// nudge. Resolved by <see cref="LetterheadPapers"/>, which checks the caller
/// may use it.</item>
/// </list>
/// The print route reads the same key from <c>?paper=</c> to choose its
/// <c>@page</c> margins, so the layout and the compositing can never disagree;
/// the render sidecar gets <see cref="Headless"/>, <see cref="PageNumberY"/>
/// and <see cref="PageNumberRight"/> so the stamp sits on the same margins.
/// The legacy <c>headless</c> flag still resolves — true is <c>plain</c>, false
/// is <c>letterhead</c> — so an older client keeps getting exactly the document
/// it used to. The key rides in the PDF cache key, because two of the three
/// modes share margins and differ only in artwork; a profile's key carries its
/// version, so an edited letterhead never serves a PDF laid out for the old one.
/// </remarks>
public readonly record struct ReportPaper(string Key, bool Artwork, double PageNumberY, double SideMm)
{
    // 82pt ≈ 28.9mm: just above the 28mm foot band the print route lays out
    // for Noble's paper, on the footer's own baseline. 116pt ≈ 40.9mm for the
    // client's 40mm sheet.
    public static readonly ReportPaper Letterhead = new("letterhead", Artwork: true, PageNumberY: 82, SideMm: 10);
    public static readonly ReportPaper Noble = new("noble", Artwork: false, PageNumberY: 82, SideMm: 10);
    public static readonly ReportPaper Plain = new("plain", Artwork: false, PageNumberY: 116, SideMm: 14);

    /// <summary>The profile id for a client letterhead; null for Noble's three.</summary>
    public int? LetterheadId { get; init; }

    /// <summary>A client letterhead's artwork and nudge for the sidecar; null for Noble's three.</summary>
    public PaperInk? Ink { get; init; }

    /// <summary>Skip the letterhead artwork — what the render sidecar calls <c>headless</c>.</summary>
    public bool Headless => !Artwork;

    /// <summary>The page number's inset from the paper's right edge, in points — the side margin.</summary>
    public double PageNumberRight => SideMm / 25.4 * 72;

    /// <summary>The query fragment the print route reads to pick its margins.</summary>
    public string Query => "&paper=" + (LetterheadId is int id ? "lh:" + id.ToString(System.Globalization.CultureInfo.InvariantCulture) : Key);

    public static ReportPaper Resolve(string? paper, bool? headless) =>
        paper?.Trim().ToLowerInvariant() switch
        {
            "letterhead" => Letterhead,
            "noble" => Noble,
            "plain" => Plain,
            _ => headless == true ? Plain : Letterhead,
        };

    /// <summary>The <c>lh:{id}</c> in a paper value, if that is what it is.</summary>
    public static int? LetterheadIdOf(string? paper) =>
        paper is not null && paper.StartsWith("lh:", StringComparison.OrdinalIgnoreCase)
        && int.TryParse(paper.AsSpan(3), System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out var id)
        && id > 0 ? id : null;

    /// <summary>A client letterhead profile as a paper.</summary>
    public static ReportPaper For(LetterheadProfile p, LetterheadArtwork? art)
    {
        static double Pt(decimal mm) => (double)mm / 25.4 * 72;
        var composite = p.Kind == "digital" && art is not null;
        return new ReportPaper(
            Key: $"lh{p.Id}v{p.Version}",
            Artwork: composite,
            // Just above the foot band, as Noble's 82pt sits just above its
            // 28mm: the band plus 0.9mm.
            PageNumberY: Pt(p.BottomMm + 0.9m),
            SideMm: (double)p.SideMm)
        {
            LetterheadId = p.Id,
            Ink = new PaperInk(
                composite ? Convert.ToBase64String(art!.Bytes) : null,
                composite ? art!.Mime : null,
                Pt(p.NudgeXMm),
                Pt(p.NudgeYMm)),
        };
    }
}
