using Infinity.Api.Audit;
using Infinity.Api.Auth;
using Infinity.Api.Worksheet;
using Microsoft.AspNetCore.Mvc;

namespace Infinity.Api.Endpoints;

/// <summary>
/// The worksheet: reading a sample for result entry, saving results,
/// authorizing, reopening, and configuring auto-authorization.
///
/// Every route carries its capability as an endpoint FILTER rather than a check
/// inside the handler, so a new route cannot ship ungated — the requirement is
/// visible in the route definition and reviewable in one place. The legacy
/// system checks permissions only to enable or disable a control and never
/// re-checks on the postback, which is how a user without the authorise right
/// could silently clear existing authorisations by pressing Save.
/// </summary>
public static class WorksheetEndpoints
{
    public static void MapWorksheetEndpoints(this WebApplication app)
    {
        var ws = app.MapGroup("/api/worksheet").RequireAuthorization();

        ws.MapGet("/{sid}", GetSample)
          .RequireCapability(Capabilities.PatientView)
          .WithName("GetWorksheetSample");

        ws.MapGet("/{sid}/audit", GetAudit)
          .RequireCapability(Capabilities.PatientView)
          .WithName("GetWorksheetAudit");

        // result:enter is the floor. Amending and authorizing are checked
        // per-edit inside the procedure, against the flags passed below —
        // a save that only enters values must not require the higher rights.
        ws.MapPost("/{sid}/results", SaveResults)
          .RequireCapability(Capabilities.ResultEnter)
          .WithName("SaveWorksheetResults");

        ws.MapPost("/{sid}/reopen", Reopen)
          .RequireCapability(Capabilities.ResultReopen)
          .WithName("ReopenWorksheetSample");

        var auto = app.MapGroup("/api/worksheet-settings/auto-auth")
                      .RequireAuthorization()
                      .RequireCapability(Capabilities.AutoAuthManage);

        auto.MapGet("/", ListAutoAuth).WithName("ListAutoAuth");
        auto.MapGet("/audit", AutoAuthAudit).WithName("AutoAuthAudit");
        // Rate limited: the unlock password is a shared secret a caller can
        // submit repeatedly, so the endpoint that checks it must not be a free
        // oracle. The legacy LIS has no throttling anywhere.
        auto.MapPost("/", SetAutoAuth)
            .RequireRateLimiting(RateLimitPolicies.AutoAuth)
            .WithName("SetAutoAuth");
    }

    private static async Task<IResult> GetSample(
        string sid,
        HttpContext http,
        System.Security.Claims.ClaimsPrincipal principal,
        ScopeRepository scopes,
        WorksheetRepository repo,
        CancellationToken ct)
    {
        if (principal.UserId() is not int userId) return Results.Unauthorized();
        if (!IsValidSid(sid)) return Results.BadRequest(new { error = "A SID of 1-50 characters is required." });

        var scope = await scopes.GetReportClientCodesAsync(userId, principal.Role(), ct).ConfigureAwait(false);
        // Denied and not-found are the same 404, so a user with no scope cannot
        // learn whether a SID exists by probing.
        if (scope.IsDenied) return Results.NotFound();

        var sample = await repo.GetSampleAsync(scope.ClientCodes, sid, ct).ConfigureAwait(false);
        if (sample is null) return Results.NotFound();

        // What the UI may offer, sent alongside the data so the screen does not
        // have to re-derive the rules. This is presentation only — the server
        // enforces each of these independently on the write path.
        return Results.Ok(new
        {
            sample.Header,
            sample.Rows,
            sample.AutoAuthRules,
            permissions = new
            {
                canEnter = principal.HasCapability(Capabilities.ResultEnter),
                canAmend = principal.HasCapability(Capabilities.ResultAmend),
                canAuthorize = principal.HasCapability(Capabilities.ResultAuthorize),
                canReopen = principal.HasCapability(Capabilities.ResultReopen),
                canReject = principal.HasCapability(Capabilities.SampleReject),
            },
        });
    }

    private static async Task<IResult> GetAudit(
        string sid,
        System.Security.Claims.ClaimsPrincipal principal,
        ScopeRepository scopes,
        WorksheetRepository repo,
        CancellationToken ct,
        int top = 200)
    {
        if (principal.UserId() is not int userId) return Results.Unauthorized();
        if (!IsValidSid(sid)) return Results.BadRequest(new { error = "A SID of 1-50 characters is required." });

        var scope = await scopes.GetReportClientCodesAsync(userId, principal.Role(), ct).ConfigureAwait(false);
        if (scope.IsDenied) return Results.NotFound();

        // Confirm the SID is in scope before returning its history — the audit
        // rows are not themselves scoped, so this is the check that stops one
        // centre reading another's activity.
        var sample = await repo.GetSampleAsync(scope.ClientCodes, sid, ct).ConfigureAwait(false);
        if (sample is null) return Results.NotFound();

        var rows = await repo.GetAuditAsync(sid, top, ct).ConfigureAwait(false);
        return Results.Ok(new { rows, count = rows.Count });
    }

    private static async Task<IResult> SaveResults(
        string sid,
        [FromBody] SaveResultsRequest request,
        HttpContext http,
        System.Security.Claims.ClaimsPrincipal principal,
        ScopeRepository scopes,
        WorksheetRepository repo,
        ResultWriteRepository writes,
        CancellationToken ct)
    {
        if (principal.UserId() is not int userId) return Results.Unauthorized();
        if (!IsValidSid(sid)) return Results.BadRequest(new { error = "A SID of 1-50 characters is required." });
        if (request.Edits is null || request.Edits.Count == 0)
        {
            return Results.BadRequest(new { error = "No edits were supplied." });
        }

        // A grid holds tens of rows, not thousands. A batch far outside that is
        // either a bug or an attempt to make one request do unbounded work.
        if (request.Edits.Count > 500)
        {
            return Results.BadRequest(new { error = "Too many edits in one save (limit 500)." });
        }

        var scope = await scopes.GetReportClientCodesAsync(userId, principal.Role(), ct).ConfigureAwait(false);
        if (scope.IsDenied) return Results.NotFound();

        // Scope check BEFORE the write. The procedure does not know about client
        // codes, so this is the only thing standing between an authenticated
        // user and another centre's results.
        var sample = await repo.GetSampleAsync(scope.ClientCodes, sid, ct).ConfigureAwait(false);
        if (sample is null) return Results.NotFound();

        var actor = AuditActorAccessor.For(http);

        try
        {
            var outcome = await writes.SaveAsync(
                sid, request, actor,
                canEnter: principal.HasCapability(Capabilities.ResultEnter),
                canAmend: principal.HasCapability(Capabilities.ResultAmend),
                canAuthorize: principal.HasCapability(Capabilities.ResultAuthorize),
                ct).ConfigureAwait(false);

            return Results.Ok(outcome);
        }
        catch (WorksheetRefusedException ex)
        {
            return ex.IsPermission
                ? Results.Problem(title: "Forbidden", detail: ex.Message, statusCode: StatusCodes.Status403Forbidden)
                : Results.BadRequest(new { error = ex.Message });
        }
    }

    private static async Task<IResult> Reopen(
        string sid,
        [FromBody] ReopenRequest request,
        HttpContext http,
        System.Security.Claims.ClaimsPrincipal principal,
        ScopeRepository scopes,
        WorksheetRepository repo,
        ResultWriteRepository writes,
        CancellationToken ct)
    {
        if (principal.UserId() is not int userId) return Results.Unauthorized();
        if (!IsValidSid(sid)) return Results.BadRequest(new { error = "A SID of 1-50 characters is required." });

        // Checked here as well as in the procedure so the operator gets a clear
        // message rather than a database error, and so the rule is visible at
        // the boundary.
        if (string.IsNullOrWhiteSpace(request.Reason) || request.Reason.Trim().Length < 10)
        {
            return Results.BadRequest(new
            {
                error = "Reopening an authorised sample requires a reason of at least 10 characters.",
            });
        }

        var scope = await scopes.GetReportClientCodesAsync(userId, principal.Role(), ct).ConfigureAwait(false);
        if (scope.IsDenied) return Results.NotFound();

        var sample = await repo.GetSampleAsync(scope.ClientCodes, sid, ct).ConfigureAwait(false);
        if (sample is null) return Results.NotFound();

        try
        {
            var (before, after) = await writes.ReopenAsync(sid, request.Reason.Trim(), AuditActorAccessor.For(http), ct)
                                              .ConfigureAwait(false);
            return Results.Ok(new { statusBefore = before, statusAfter = after });
        }
        catch (WorksheetRefusedException ex)
        {
            return ex.IsPermission
                ? Results.Problem(title: "Forbidden", detail: ex.Message, statusCode: StatusCodes.Status403Forbidden)
                : Results.BadRequest(new { error = ex.Message });
        }
    }

    /* ---- auto-authorization settings ---- */

    private static async Task<IResult> ListAutoAuth(
        AutoAuthRepository repo,
        AutoAuthGate gate,
        CancellationToken ct,
        string? search = null,
        bool onlyEnabled = false,
        int top = 200)
    {
        var rows = await repo.ListAsync(search, onlyEnabled, top, ct).ConfigureAwait(false);
        return Results.Ok(new { rows, count = rows.Count, featureEnabled = gate.FeatureEnabled });
    }

    private static async Task<IResult> AutoAuthAudit(
        AutoAuthRepository repo, CancellationToken ct, int top = 100)
    {
        var rows = await repo.GetAuditAsync(top, ct).ConfigureAwait(false);
        return Results.Ok(new { rows, count = rows.Count });
    }

    /// <summary>
    /// Turn auto-authorization on or off for one scope.
    ///
    /// TWO independent gates, both required. The autoauth:manage capability is
    /// enforced by the group filter above; the unlock password is checked here.
    /// Holding the capability says who may ask. The password says this change
    /// was deliberate — it is the difference between a mis-click on a settings
    /// screen and a decision to release results without a person reading them.
    /// </summary>
    private static async Task<IResult> SetAutoAuth(
        [FromBody] SetAutoAuthRequest request,
        HttpContext http,
        AutoAuthGate gate,
        AutoAuthRepository repo,
        CancellationToken ct)
    {
        var actor = AuditActorAccessor.For(http);

        if (!gate.FeatureEnabled)
        {
            return Results.Problem(
                title: "Disabled",
                detail: "Auto-authorisation is switched off for this deployment.",
                statusCode: StatusCodes.Status403Forbidden);
        }

        if (!gate.Verify(request.Password))
        {
            await repo.RecordFailedUnlockAsync(request.ScopeType, request.ScopeKey, actor, ct).ConfigureAwait(false);

            // 403 with a deliberately flat message. Saying anything about why it
            // failed would leak information about the stored secret.
            return Results.Problem(
                title: "Forbidden",
                detail: "The auto-authorisation password is not correct.",
                statusCode: StatusCodes.Status403Forbidden);
        }

        if (request.ScopeType is not ("test" or "profile" or "department"))
        {
            return Results.BadRequest(new { error = "Scope must be test, profile or department." });
        }

        if (string.IsNullOrWhiteSpace(request.ScopeKey))
        {
            return Results.BadRequest(new { error = "A scope key is required." });
        }

        try
        {
            await repo.SetAsync(request, actor, ct).ConfigureAwait(false);
            return Results.Ok(new { request.ScopeType, request.ScopeKey, request.Enabled });
        }
        catch (WorksheetRefusedException ex)
        {
            return Results.BadRequest(new { error = ex.Message });
        }
    }

    private static bool IsValidSid(string? sid) =>
        !string.IsNullOrWhiteSpace(sid) && sid.Length <= 50;
}
