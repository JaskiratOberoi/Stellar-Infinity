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

        ws.MapGet("/{sid}/trend", GetTrend)
          .RequireCapability(Capabilities.PatientView)
          .WithName("GetResultTrend");

        // result:enter is the floor. Amending and authorizing are checked
        // per-edit inside the procedure, against the flags passed below —
        // a save that only enters values must not require the higher rights.
        ws.MapPost("/{sid}/results", SaveResults)
          .RequireCapability(Capabilities.ResultEnter)
          .WithName("SaveWorksheetResults");

        // Attachments — available on EVERY sample, not only tests the LIS
        // flagged Has_graph.
        ws.MapGet("/{sid}/attachments", ListAttachments)
          .RequireCapability(Capabilities.PatientView)
          .WithName("ListAttachments");

        ws.MapGet("/{sid}/attachments/{id:int}", DownloadAttachment)
          .RequireCapability(Capabilities.PatientView)
          .WithName("DownloadAttachment");

        ws.MapPost("/{sid}/attachments", UploadAttachment)
          .RequireCapability(Capabilities.ResultEnter)
          .DisableAntiforgery()
          .WithName("UploadAttachment");

        ws.MapDelete("/{sid}/attachments/{id:int}", DeleteAttachment)
          .RequireCapability(Capabilities.ResultAmend)
          .WithName("DeleteAttachment");

        ws.MapPost("/{sid}/reopen", Reopen)
          .RequireCapability(Capabilities.ResultReopen)
          .WithName("ReopenWorksheetSample");

        // PatientEdit, not ResultEnter: this changes who the sample belongs to
        // rather than what it says, and the two are not the same authority.
        // Technician holds ResultEnter and deliberately does not hold this.
        ws.MapPut("/{sid}/patient", UpdatePatient)
          .RequireCapability(Capabilities.PatientEdit)
          .WithName("UpdateWorksheetPatient");

        var auto = app.MapGroup("/api/worksheet-settings/auto-auth")
                      .RequireAuthorization()
                      .RequireCapability(Capabilities.AutoAuthManage);

        auto.MapGet("/", ListAutoAuth).WithName("ListAutoAuth");
        auto.MapGet("/business-units", ListBusinessUnits).WithName("ListAutoAuthBusinessUnits");
        // The gate the settings screen opens with. Rate limited on the same
        // policy as the write, so it cannot be used as a cheaper guessing
        // oracle than the endpoint it protects.
        auto.MapPost("/unlock", UnlockAutoAuth)
            .RequireRateLimiting(RateLimitPolicies.AutoAuth)
            .WithName("UnlockAutoAuth");
        // Lets a reloaded page ask "am I still through the gate?" without
        // re-prompting. Cheap, and reveals nothing but a boolean.
        auto.MapGet("/unlock", UnlockStatus).WithName("AutoAuthUnlockStatus");
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
                // New capability, so it is absent from tokens issued before this
                // shipped and reads false until they rotate (8h). A hidden
                // button is a safe way to degrade — unlike the channel default,
                // there is nothing here that needs a transition fallback.
                canEditPatient = principal.HasCapability(Capabilities.PatientEdit),
            },
        });
    }

    private static async Task<IResult> GetAudit(
        string sid,
        System.Security.Claims.ClaimsPrincipal principal,
        ScopeRepository scopes,
        WorksheetRepository repo,
        CancellationToken ct,
        int page = 1,
        int pageSize = 200)
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

        var result = await repo.GetAuditAsync(sid, page, pageSize, ct).ConfigureAwait(false);
        return Results.Ok(new
        {
            rows = result.Rows,
            count = result.Rows.Count,
            total = result.Total,
            page = result.Page,
            pageSize = result.PageSize,
            pageCount = result.PageCount,
        });
    }

    /// <summary>
    /// Prior values per analyte for the same person, for the delta trend.
    ///
    /// Gated and scope-checked identically to the audit: the history rows are
    /// not themselves scoped, so confirming the SID is in scope first is what
    /// stops one centre reading another's patients.
    /// </summary>
    private static async Task<IResult> GetTrend(
        string sid,
        System.Security.Claims.ClaimsPrincipal principal,
        ScopeRepository scopes,
        WorksheetRepository repo,
        ResultHistoryRepository history,
        CancellationToken ct,
        int maxPoints = 12)
    {
        if (principal.UserId() is not int userId) return Results.Unauthorized();
        if (!IsValidSid(sid)) return Results.BadRequest(new { error = "A SID of 1-50 characters is required." });

        var scope = await scopes.GetReportClientCodesAsync(userId, principal.Role(), ct).ConfigureAwait(false);
        if (scope.IsDenied) return Results.NotFound();

        var sample = await repo.GetSampleAsync(scope.ClientCodes, sid, ct).ConfigureAwait(false);
        if (sample is null) return Results.NotFound();

        return Results.Ok(await history.GetAsync(sid, maxPoints, ct).ConfigureAwait(false));
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

    /// <summary>
    /// Correct a registered patient's demographics and referral.
    ///
    /// Note what is deliberately NOT checked here: whether the sample is
    /// editable. A sample that is authorised or already printed is exactly the
    /// one whose patient details most often need fixing — the misspelling is
    /// usually noticed when the report comes back — and refusing the edit would
    /// leave the only route a reopen, which is a heavier act with a mandatory
    /// clinical reason attached. Results stay locked either way; this endpoint
    /// cannot touch them.
    /// </summary>
    private static async Task<IResult> UpdatePatient(
        string sid,
        [FromBody] UpdatePatientRequest request,
        System.Security.Claims.ClaimsPrincipal principal,
        ScopeRepository scopes,
        PatientEditRepository patients,
        CancellationToken ct)
    {
        if (principal.UserId() is not int userId) return Results.Unauthorized();
        if (!IsValidSid(sid)) return Results.BadRequest(new { error = "A SID of 1-50 characters is required." });

        // A name that is present but blank would wipe the patient's name via the
        // empty-string-clears convention, which is never what anyone means.
        if (request.Name is not null && request.Name.Trim().Length == 0)
        {
            return Results.BadRequest(new { error = "A patient name cannot be empty." });
        }

        var scope = await scopes.GetReportClientCodesAsync(userId, principal.Role(), ct).ConfigureAwait(false);
        if (scope.IsDenied) return Results.NotFound();

        var result = await patients.UpdateAsync(
            scope.ClientCodes, sid, userId, principal.Identity?.Name,
            new PatientInfoEdit(
                Title: request.Title,
                Name: request.Name?.Trim(),
                Age: request.Age,
                AgeType: request.AgeType,
                Gender: request.Gender,
                RefDoctor: request.RefDoctor,
                RefDoctorOther: request.RefDoctorOther?.Trim(),
                RefCustomer: request.RefCustomer,
                RefCustomerOther: request.RefCustomerOther?.Trim(),
                Mobile: request.Mobile?.Trim(),
                Email: request.Email?.Trim(),
                SampleTime: request.SampleTime,
                ClinicalHistory: request.ClinicalHistory),
            ct).ConfigureAwait(false);

        if (!result.Ok)
        {
            // NOT_FOUND covers "no such SID" and "outside your scope" alike, so
            // the endpoint cannot be used to probe for SIDs.
            return result.ErrorCode switch
            {
                "NOT_FOUND" => Results.NotFound(),
                "BAD_DOCTOR" => Results.BadRequest(new { error = "That referring doctor no longer exists." }),
                "BAD_CUSTOMER" => Results.BadRequest(new { error = "That referring customer no longer exists." }),
                "BAD_AGE_TYPE" => Results.BadRequest(new { error = "Age must be in years, months or days." }),
                "BAD_GENDER" => Results.BadRequest(new { error = "Sex must be male or female." }),
                "BAD_AGE" => Results.BadRequest(new { error = "That age is not a plausible value." }),
                _ => Results.BadRequest(new { error = "The patient could not be updated." }),
            };
        }

        return Results.Ok(new { ok = true, changed = result.Changed });
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

    /* ---- attachments ---- */

    private static async Task<IResult> ListAttachments(
        string sid,
        System.Security.Claims.ClaimsPrincipal principal,
        ScopeRepository scopes,
        WorksheetRepository repo,
        AttachmentRepository attachments,
        CancellationToken ct)
    {
        if (principal.UserId() is not int userId) return Results.Unauthorized();
        if (!IsValidSid(sid)) return Results.BadRequest(new { error = "A SID of 1-50 characters is required." });

        var scope = await scopes.GetReportClientCodesAsync(userId, principal.Role(), ct).ConfigureAwait(false);
        if (scope.IsDenied) return Results.NotFound();
        if (await repo.GetSampleAsync(scope.ClientCodes, sid, ct).ConfigureAwait(false) is null)
            return Results.NotFound();

        var rows = await attachments.ListAsync(sid, ct).ConfigureAwait(false);
        return Results.Ok(new
        {
            rows,
            count = rows.Count,
            maxBytes = AttachmentRepository.MaxBytes,
            canAttach = principal.HasCapability(Capabilities.ResultEnter),
            canRemove = principal.HasCapability(Capabilities.ResultAmend),
        });
    }

    /// <summary>
    /// Stream one attachment.
    ///
    /// The legacy equivalent is graph.ashx?id=N: no authentication and no
    /// ownership check, so anyone who could reach the URL could walk the
    /// integers and pull every patient document in the lab. Here the caller
    /// must be authenticated, hold patient:view, and the file's OWN sample must
    /// fall inside their client-code scope — checked against the value the
    /// database returns, never against anything the caller supplied.
    /// </summary>
    private static async Task<IResult> DownloadAttachment(
        string sid,
        int id,
        System.Security.Claims.ClaimsPrincipal principal,
        ScopeRepository scopes,
        WorksheetRepository repo,
        AttachmentRepository attachments,
        CancellationToken ct)
    {
        if (principal.UserId() is not int userId) return Results.Unauthorized();
        if (!IsValidSid(sid)) return Results.BadRequest(new { error = "A SID of 1-50 characters is required." });

        var scope = await scopes.GetReportClientCodesAsync(userId, principal.Role(), ct).ConfigureAwait(false);
        if (scope.IsDenied) return Results.NotFound();
        if (await repo.GetSampleAsync(scope.ClientCodes, sid, ct).ConfigureAwait(false) is null)
            return Results.NotFound();

        var file = await attachments.GetAsync(id, ct).ConfigureAwait(false);
        if (file is null) return Results.NotFound();

        // The id must belong to the SID the caller was authorised for. Without
        // this the scope check above proves nothing about the file itself.
        if (!string.Equals(file.Vailid?.Trim(), sid.Trim(), StringComparison.OrdinalIgnoreCase))
            return Results.NotFound();

        var ext = (file.FileType ?? ".pdf").ToLowerInvariant();
        var contentType = ext switch
        {
            ".png" => "image/png",
            ".jpg" or ".jpeg" => "image/jpeg",
            _ => "application/pdf",
        };

        // A filename that says what it is. The legacy handler sends every
        // attachment as application/pdf named ff.pdf, so a PNG downloads as a
        // corrupt PDF.
        return Results.File(file.Content, contentType, sid + "-" + id + ext, enableRangeProcessing: true);
    }

    private static async Task<IResult> UploadAttachment(
        string sid,
        HttpRequest request,
        HttpContext http,
        System.Security.Claims.ClaimsPrincipal principal,
        ScopeRepository scopes,
        WorksheetRepository repo,
        AttachmentRepository attachments,
        CancellationToken ct)
    {
        if (principal.UserId() is not int userId) return Results.Unauthorized();
        if (!IsValidSid(sid)) return Results.BadRequest(new { error = "A SID of 1-50 characters is required." });
        if (!request.HasFormContentType) return Results.BadRequest(new { error = "Expected a file upload." });

        var scope = await scopes.GetReportClientCodesAsync(userId, principal.Role(), ct).ConfigureAwait(false);
        if (scope.IsDenied) return Results.NotFound();
        if (await repo.GetSampleAsync(scope.ClientCodes, sid, ct).ConfigureAwait(false) is null)
            return Results.NotFound();

        var form = await request.ReadFormAsync(ct).ConfigureAwait(false);
        var file = form.Files.GetFile("file");
        if (file is null || file.Length == 0) return Results.BadRequest(new { error = "No file was supplied." });

        if (file.Length > AttachmentRepository.MaxBytes)
        {
            var limitMb = AttachmentRepository.MaxBytes / (1024 * 1024);
            return Results.BadRequest(new { error = "That file is too large. The limit is " + limitMb + " MB." });
        }

        var ext = Path.GetExtension(file.FileName ?? "").ToLowerInvariant();

        using var ms = new MemoryStream();
        await file.CopyToAsync(ms, ct).ConfigureAwait(false);
        var bytes = ms.ToArray();

        if (!AttachmentRepository.IsAllowed(ext, bytes, out var problem))
            return Results.BadRequest(new { error = problem });

        int? resultId = int.TryParse(form["resultId"].ToString(), out var rid) && rid > 0 ? rid : null;

        try
        {
            var id = await attachments.AddAsync(
                sid, resultId, ext, bytes, file.FileName, AuditActorAccessor.For(http), ct).ConfigureAwait(false);
            return Results.Ok(new { id });
        }
        catch (WorksheetRefusedException ex)
        {
            return ex.IsPermission
                ? Results.Problem(title: "Forbidden", detail: ex.Message, statusCode: StatusCodes.Status403Forbidden)
                : Results.BadRequest(new { error = ex.Message });
        }
    }

    private static async Task<IResult> DeleteAttachment(
        string sid,
        int id,
        HttpContext http,
        System.Security.Claims.ClaimsPrincipal principal,
        ScopeRepository scopes,
        WorksheetRepository repo,
        AttachmentRepository attachments,
        CancellationToken ct)
    {
        if (principal.UserId() is not int userId) return Results.Unauthorized();
        if (!IsValidSid(sid)) return Results.BadRequest(new { error = "A SID of 1-50 characters is required." });

        var scope = await scopes.GetReportClientCodesAsync(userId, principal.Role(), ct).ConfigureAwait(false);
        if (scope.IsDenied) return Results.NotFound();
        if (await repo.GetSampleAsync(scope.ClientCodes, sid, ct).ConfigureAwait(false) is null)
            return Results.NotFound();

        try
        {
            await attachments.DeleteAsync(id, sid, AuditActorAccessor.For(http), ct).ConfigureAwait(false);
            return Results.Ok(new { removed = id });
        }
        catch (WorksheetRefusedException ex)
        {
            return Results.BadRequest(new { error = ex.Message });
        }
    }


    /* ---- auto-authorization settings ---- */

    private static async Task<IResult> ListAutoAuth(
        AutoAuthRepository repo,
        AutoAuthGate gate,
        CancellationToken ct,
        string? search = null,
        bool onlyEnabled = false,
        int? businessUnitId = null,
        int page = 1,
        int pageSize = 200)
    {
        var result = await repo.ListAsync(search, onlyEnabled, businessUnitId, page, pageSize, ct).ConfigureAwait(false);
        return Results.Ok(new
        {
            rows = result.Rows,
            count = result.Rows.Count,
            total = result.Total,
            page = result.Page,
            pageSize = result.PageSize,
            pageCount = result.PageCount,
            featureEnabled = gate.FeatureEnabled,
            businessUnitId,
        });
    }

    private static async Task<IResult> ListBusinessUnits(AutoAuthRepository repo, CancellationToken ct)
    {
        var units = await repo.GetBusinessUnitsAsync(ct).ConfigureAwait(false);
        return Results.Ok(new { units });
    }

    /// <summary>
    /// Verify the unlock password WITHOUT changing anything.
    ///
    /// The settings screen calls this before it renders any rule, so the list
    /// of which tests release results unread is not on display to anyone who
    /// merely reached the URL. Holding autoauth:manage is still required — the
    /// group filter enforces that before this runs — so this is the second
    /// factor, not the only one.
    ///
    /// A rejected attempt is recorded exactly as a rejected change is: the
    /// signature worth seeing is a run of failures, and it should not matter
    /// whether they came from the gate or from a toggle.
    /// </summary>
    private static async Task<IResult> UnlockAutoAuth(
        [FromBody] AutoAuthUnlockRequest request,
        System.Security.Claims.ClaimsPrincipal principal,
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
            await repo.RecordFailedUnlockAsync(null, null, actor, ct).ConfigureAwait(false);
            return Results.Problem(
                title: "Forbidden",
                detail: "The auto-authorisation password is not correct.",
                statusCode: StatusCodes.Status403Forbidden);
        }

        // Remember it SERVER-side, keyed to this user and session version. The
        // password itself is never persisted anywhere — the browser holds only
        // the fact that a grant exists, which it cannot forge.
        if (principal.UserId() is int uid)
        {
            await gate.GrantAsync(uid, principal.SessionVersion(), ct).ConfigureAwait(false);
        }

        return Results.Ok(new { unlocked = true });
    }

    private static async Task<IResult> UnlockStatus(
        System.Security.Claims.ClaimsPrincipal principal,
        AutoAuthGate gate,
        CancellationToken ct)
    {
        if (principal.UserId() is not int uid) return Results.Unauthorized();
        var unlocked = await gate.HasGrantAsync(uid, principal.SessionVersion(), ct).ConfigureAwait(false);
        return Results.Ok(new { unlocked, featureEnabled = gate.FeatureEnabled });
    }

    private static async Task<IResult> AutoAuthAudit(
        AutoAuthRepository repo, CancellationToken ct, int page = 1, int pageSize = 100)
    {
        var result = await repo.GetAuditAsync(page, pageSize, ct).ConfigureAwait(false);
        return Results.Ok(new
        {
            rows = result.Rows,
            count = result.Rows.Count,
            total = result.Total,
            page = result.Page,
            pageSize = result.PageSize,
            pageCount = result.PageCount,
        });
    }

    /// <summary>
    /// Turn auto-authorization on or off for one scope.
    ///
    /// TWO independent gates, both required. The autoauth:manage capability is
    /// enforced by the group filter above; the unlock is checked here. Holding
    /// the capability says who may ask. The unlock says this change was
    /// deliberate — the difference between a mis-click on a settings screen and
    /// a decision to release results without a person reading them.
    ///
    /// The unlock may be satisfied either by supplying the password on this
    /// request, or by an existing server-side grant earned at the gate. The
    /// grant is what lets a refreshed page keep working without re-prompting;
    /// it lives in the shared cache keyed to user AND session version, so it is
    /// not something the browser can fabricate and it dies when the session is
    /// revoked.
    /// </summary>
    private static async Task<IResult> SetAutoAuth(
        [FromBody] SetAutoAuthRequest request,
        System.Security.Claims.ClaimsPrincipal principal,
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

        if (principal.UserId() is not int uid) return Results.Unauthorized();

        var granted = await gate.HasGrantAsync(uid, principal.SessionVersion(), ct).ConfigureAwait(false);
        // A password on the request still works and still re-grants, so a
        // caller that never visited the gate is not locked out.
        var byPassword = !granted && gate.Verify(request.Password);
        if (byPassword) await gate.GrantAsync(uid, principal.SessionVersion(), ct).ConfigureAwait(false);

        if (!granted && !byPassword)
        {
            await repo.RecordFailedUnlockAsync(request.ScopeType, request.ScopeKey, actor, ct).ConfigureAwait(false);

            // 403 with a deliberately flat message. Saying anything about why it
            // failed would leak information about the stored secret.
            return Results.Problem(
                title: "Forbidden",
                detail: "The auto-authorisation password is not correct.",
                statusCode: StatusCodes.Status403Forbidden);
        }

        if (request.ScopeType is not ("test" or "profile"))
        {
            return Results.BadRequest(new { error = "Scope must be test or profile." });
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
