using Infinity.Api.Reads;

namespace Infinity.Api.Reports;

/// <summary>
/// A report is not issued without a signature on it.
/// </summary>
/// <remarks>
/// <para>
/// This used to be best-effort. The report routes read the signatories inside a
/// try/catch commented "print it bare", so a failure to read them produced a
/// finished-looking sheet with an empty space where a pathologist's name
/// belongs. That is the worst outcome available here, because it is the one a
/// reader cannot see is wrong: a missing RESULT is obvious, a missing signature
/// is a page of numbers that nobody has put their name to and that still looks
/// exactly like a report.
/// </para>
/// <para>
/// It cost us a real one. A collation fault in usp_inf_report_extras threw on
/// every call for a day, and every report issued in that window went out
/// unsigned without anything, anywhere, saying so.
/// </para>
/// <para>
/// So: no signatory, no render. Refusing is loud, recoverable and obviously
/// wrong to whoever sees it; issuing an unsigned report is none of those.
/// </para>
/// <para>
/// Two causes, deliberately given different statuses, because they want
/// different people:
/// <list type="bullet">
/// <item><b>503</b> — the signatories could not be READ. Transient, ours, and
/// worth retrying. It should page somebody.</item>
/// <item><b>409</b> — they were read and there are none. Nothing to retry: a
/// business unit needs signatories configured, or the department needs a
/// default in Department_View_Sign. A person has to go and fix data.</item>
/// </list>
/// One <c>error</c> code across both, so a client handles the refusal once and
/// shows the message.
/// </para>
/// </remarks>
public static class ReportSignoff
{
    public const string ErrorCode = "NO_SIGNATORY";

    /// <summary>The extras, or the refusal to render without them.</summary>
    public sealed record Outcome(ReportExtras? Extras, IResult? Refusal);

    /// <summary>
    /// A signatory only counts when it has an IMAGE. A name with no signature
    /// against it is an attribution, not a signature, and the whole point of
    /// this gate is the mark on the page.
    /// </summary>
    private static bool IsSigned(ReportExtras extras) =>
        extras.Signers.Any(s => !string.IsNullOrEmpty(s.SignatureDataUrl));

    public static async Task<Outcome> RequireAsync(
        ReportExtrasRepository extras,
        string sid,
        ILoggerFactory loggers,
        CancellationToken ct)
    {
        var log = loggers.CreateLogger("ReportSignoff");

        ReportExtras more;
        try
        {
            more = await extras.GetAsync(sid, ct).ConfigureAwait(false);
        }
        catch (Exception ex) when (!ct.IsCancellationRequested)
        {
            // The data layer logs the SqlException itself; this line records the
            // DECISION, which is the part that explains a refused download.
            log.LogError(ex, "report.unsigned.refused sid={Sid} reason=unavailable", sid);
            return new Outcome(null, Results.Json(new
            {
                error = ErrorCode,
                reason = "unavailable",
                message = "This report cannot be issued right now: its signatories could not be read. "
                        + "Please try again in a moment.",
            }, statusCode: StatusCodes.Status503ServiceUnavailable));
        }

        if (!IsSigned(more))
        {
            log.LogWarning("report.unsigned.refused sid={Sid} reason=none-configured", sid);
            return new Outcome(null, Results.Json(new
            {
                error = ErrorCode,
                reason = "none-configured",
                message = "This report has no signatory. No doctor is configured to sign for this "
                        + "processing unit, and its departments have no default signatory either — "
                        + "so it cannot be issued. Please have a signatory configured.",
            }, statusCode: StatusCodes.Status409Conflict));
        }

        return new Outcome(more, null);
    }
}
