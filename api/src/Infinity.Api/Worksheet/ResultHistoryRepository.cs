using System.Data;
using Infinity.Api.Auth;
using Infinity.Api.Data;
using Infinity.Api.Domain;
using Microsoft.Data.SqlClient;

namespace Infinity.Api.Worksheet;

public sealed record HistoryPoint(
    string? Value,
    string? Sid,
    DateTimeOffset? DrawnAt,
    bool IsCurrent);

/// <param name="TestKey">
/// "testid:paramid". The only value here that identifies a single analyte —
/// TestCode names the whole panel and repeats across every parameter in it.
/// </param>
public sealed record AnalyteHistory(
    string TestKey,
    string? TestCode,
    string? TestName,
    string? Unit,
    IReadOnlyList<HistoryPoint> Points);

/// <summary>
/// How the prior visits were identified. Surfaced to the UI because a trend the
/// operator cannot audit is a trend they should not act on.
/// </summary>
/// <param name="MatchedOn">visit | name+mobile+gender | none</param>
/// <param name="HasMobile">
/// False means no cross-visit history was even attempted. Most registrations
/// have no mobile recorded, so an empty trend is usually THIS and not evidence
/// that the patient has never been tested.
/// </param>
public sealed record HistoryMatch(string MatchedOn, int PriorVisits, bool HasMobile);

public sealed record ResultHistory(HistoryMatch Match, IReadOnlyList<AnalyteHistory> Analytes);

public sealed class ResultHistoryRepository(NobleConnectionFactory db, SqlRetry retry)
{
    public Task<ResultHistory> GetAsync(string sid, int maxPoints = 12, CancellationToken ct = default) =>
        retry.ExecuteAsync("history.results", token =>
            db.QueryAsync("history.results", async (conn, inner) =>
            {
                await using var cmd = new SqlCommand("dbo.usp_inf_result_history", conn)
                {
                    CommandType = CommandType.StoredProcedure,
                    // Matching walks a 3.4M-row table; the mobile index makes it
                    // quick, but a patient with many visits deserves headroom.
                    CommandTimeout = 30,
                };
                cmd.Parameters.Add("@sid", SqlDbType.NVarChar, 50).Value = sid;
                cmd.Parameters.Add("@max_points", SqlDbType.Int).Value = maxPoints;

                await using var r = await cmd.ExecuteReaderAsync(inner).ConfigureAwait(false);

                // The procedure returns the series already grouped by test_key
                // and ordered by date, so one pass builds it without a
                // dictionary. Grouping is on test_key ("testid:paramid"), NOT
                // on test_code: a CBC differential shares one code across
                // twenty-odd parameters, and grouping on the code stacks them
                // all into one meaningless line.
                var analytes = new List<AnalyteHistory>();
                List<HistoryPoint>? points = null;
                string? key = null, code = null, name = null, unit = null;

                void Flush()
                {
                    if (key is not null && points is { Count: > 0 })
                        analytes.Add(new AnalyteHistory(key, code, name, unit, points));
                }

                while (await r.ReadAsync(inner).ConfigureAwait(false))
                {
                    var thisKey = r.GetOrdinalString("test_key") ?? "";
                    if (thisKey != key)
                    {
                        Flush();
                        key = thisKey;
                        code = r.GetOrdinalString("test_code");
                        name = r.GetOrdinalString("test_name");
                        unit = r.GetOrdinalString("unit");
                        points = [];
                    }

                    points!.Add(new HistoryPoint(
                        r.GetOrdinalString("value"),
                        r.GetOrdinalString("vailid"),
                        NobleTime.ToIst(r.GetOrdinalDateTime("drawn_at")),
                        r.GetOrdinalBool("is_current")));
                }
                Flush();

                var match = new HistoryMatch("none", 0, false);
                if (await r.NextResultAsync(inner).ConfigureAwait(false)
                    && await r.ReadAsync(inner).ConfigureAwait(false))
                {
                    match = new HistoryMatch(
                        r.GetOrdinalString("matched_on") ?? "none",
                        r.GetOrdinalInt32("prior_visits") ?? 0,
                        r.GetOrdinalBool("has_mobile"));
                }

                // A single point is the current result with nothing to compare
                // it to — not a trend. Dropping it keeps the UI free of flat
                // one-dot charts that imply a history that does not exist.
                var withHistory = analytes.Where(a => a.Points.Count > 1).ToArray();

                return new ResultHistory(match, withHistory);
            }, token), ct);
}

internal static class HistoryReaderExtensions
{
    public static DateTime? GetOrdinalDateTime(this SqlDataReader r, string column)
    {
        var i = r.GetOrdinal(column);
        return r.IsDBNull(i) ? null : r.GetDateTime(i);
    }
}
