using System.Security.Claims;
using System.Text.Json;
using Infinity.Api.Auth;
using Infinity.Api.Instruments;
using Infinity.Api.Worksheet;

namespace Infinity.Api.Endpoints;

public static class InstrumentEndpoints
{
    public sealed record IngestRequest(IReadOnlyList<InstrumentReading> Results);

    public static void MapInstrumentEndpoints(this WebApplication app)
    {
        // ---- ingestion: analyser-authenticated, NOT a user JWT --------------
        app.MapPost("/api/instruments/results", Ingest)
           .AllowAnonymous()
           .RequireRateLimiting(RateLimitPolicies.Instrument)
           .WithName("IngestInstrumentResults");

        // ---- operator surface: normal user auth -----------------------------
        var admin = app.MapGroup("/api/instruments")
                       .RequireAuthorization();

        admin.MapGet("/", ListInstruments)
             .RequireCapability(Capabilities.ResultEnter)
             .WithName("ListInstruments");

        admin.MapGet("/inbox", Inbox)
             .RequireCapability(Capabilities.ResultEnter)
             .WithName("InstrumentInbox");

        admin.MapPost("/inbox/{inboxId:long}/replay", Replay)
             .RequireCapability(Capabilities.ResultEnter)
             .WithName("ReplayInboxMessage");

        // Registering an analyser mints a credential that can write results, so
        // it sits behind user:manage rather than result:enter.
        admin.MapPost("/", UpsertInstrument)
             .RequireCapability(Capabilities.UserManage)
             .WithName("UpsertInstrument");
    }

    /// <summary>
    /// Accept a batch of readings from an analyser.
    ///
    /// Every reading is recorded in the inbox whatever its fate, so a message
    /// for a mistyped SID at 2am leaves a visible, replayable row rather than
    /// disappearing into a catch block — the legacy importer's failure mode.
    ///
    /// Returns 200 even when readings did not match: the analyser has
    /// successfully delivered them and should not retry. Whether they applied
    /// is an operational question, answered per reading in the response and on
    /// the inbox screen.
    /// </summary>
    private static async Task<IResult> Ingest(
        IngestRequest request,
        HttpContext http,
        InstrumentAuthenticator authenticator,
        InstrumentRepository repo,
        CancellationToken ct)
    {
        var instrument = await authenticator.AuthenticateAsync(
            http.Request.Headers["X-Instrument-Code"].ToString(),
            http.Request.Headers["X-Instrument-Key"].ToString(),
            ct).ConfigureAwait(false);

        if (instrument is null)
        {
            return Results.Problem(
                title: "Unauthorized",
                detail: "Unknown instrument code or key.",
                statusCode: StatusCodes.Status401Unauthorized);
        }

        if (request.Results is null || request.Results.Count == 0)
            return Results.BadRequest(new { error = "No results supplied." });

        if (request.Results.Count > 500)
            return Results.BadRequest(new { error = "At most 500 readings per request." });

        var outcomes = new List<IngestOutcome>(request.Results.Count);
        foreach (var reading in request.Results)
        {
            // The raw reading is stored alongside the parsed fields so a dispute
            // about what the analyser actually sent can be settled from the row.
            var raw = JsonSerializer.Serialize(reading);
            outcomes.Add(await repo.IngestAsync(instrument.Id, reading, raw, ct).ConfigureAwait(false));
        }

        return Results.Ok(new IngestResponse(
            Accepted: outcomes.Count,
            Applied: outcomes.Count(o => o.MatchStatus == "applied"),
            Unmatched: outcomes.Count(o => o.MatchStatus is "unmatched" or "rejected"),
            Results: outcomes));
    }

    private static async Task<IResult> ListInstruments(InstrumentRepository repo, CancellationToken ct) =>
        Results.Ok(await repo.ListAsync(ct).ConfigureAwait(false));

    private static async Task<IResult> Inbox(
        InstrumentRepository repo,
        CancellationToken ct,
        string? status = null,
        int? instrumentId = null,
        string? sid = null,
        int top = 100)
    {
        var page = await repo.InboxAsync(status, instrumentId, sid, top, ct).ConfigureAwait(false);
        return Results.Ok(page);
    }

    private static async Task<IResult> Replay(
        long inboxId, InstrumentRepository repo, ClaimsPrincipal principal, CancellationToken ct)
    {
        if (principal.UserId() is not int actor) return Results.Unauthorized();

        try
        {
            var outcome = await repo.ReplayAsync(inboxId, actor, ct).ConfigureAwait(false);
            return Results.Ok(outcome);
        }
        catch (Microsoft.Data.SqlClient.SqlException ex) when (ex.Class == 16)
        {
            // The procedure's own validation (already applied, not found).
            return Results.BadRequest(new { error = ex.Message });
        }
    }

    private static async Task<IResult> UpsertInstrument(
        UpsertInstrumentRequest request,
        InstrumentRepository repo,
        ClaimsPrincipal principal,
        CancellationToken ct)
    {
        if (principal.UserId() is not int actor) return Results.Unauthorized();

        if (string.IsNullOrWhiteSpace(request.Code) || request.Code.Trim().Length > 20)
        {
            return Results.BadRequest(new
            {
                error = "A code of 1-20 characters is required — it is written into the LIS machine_name column, which is 20 wide.",
            });
        }

        string? hash = null, hint = null;
        if (!string.IsNullOrWhiteSpace(request.ApiKey))
        {
            if (request.ApiKey.Length < 24)
                return Results.BadRequest(new { error = "An instrument key must be at least 24 characters." });

            hash = PasswordHash.Create(request.ApiKey);
            hint = request.ApiKey[^4..];
        }

        var result = await repo.UpsertAsync(request, hash, hint, actor, ct).ConfigureAwait(false);

        return result.Ok
            ? Results.Ok(new { instrumentId = result.InstrumentId })
            : result.ErrorCode switch
            {
                "VALIDATION" => Results.BadRequest(new { error = result.Message }),
                _ => Results.Problem(title: "Operation failed", detail: result.Message,
                                     statusCode: StatusCodes.Status500InternalServerError),
            };
    }
}
