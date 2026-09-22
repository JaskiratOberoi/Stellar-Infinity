using Infinity.Api.Auth;
using Infinity.Api.Orders;
using Microsoft.AspNetCore.Mvc;

namespace Infinity.Api.Endpoints;

/// <summary>
/// Accessioning — the two steps that carry an order onto the bench.
///
/// Until these run, a booked order has no sample the lab can see: the worksheet
/// excludes sample_status &lt;= 1, so a barcode-less order and a Sample Sent one
/// are both invisible there. This is the piece that lets Infinity originate
/// work for its own worksheet rather than depending on someone being in Telo.
///
/// Reads use REPORT scope, matching the worksheet — the two queues are about
/// the same samples the worksheet will show. Writes additionally re-check the
/// specific order, because attaching a barcode or receiving a sample is a
/// stronger act than listing one.
/// </summary>
public static class AccessionEndpoints
{
    /// <summary>
    /// The Sample-ID queue — orders with no barcode yet, and the act of
    /// attaching one — is locked (2026-09-22): it is the B2C counter's job,
    /// so it opens for B2C accounts and, among super admins, for Jas alone.
    /// Every other role, capability or not, is refused here and sees the
    /// tab locked on the page. Username rather than user id so the rule
    /// reads as the lab states it; the LIS login is unique.
    /// </summary>
    private static bool MaySeeSidQueue(System.Security.Claims.ClaimsPrincipal principal) =>
        principal.Role() == InfinityRoles.ClientB2c
        || (principal.Role() == InfinityRoles.SuperAdmin
            && string.Equals(principal.Username()?.Trim(), "Jas", StringComparison.OrdinalIgnoreCase));

    private static IResult SidQueueLocked() => Results.Json(
        new { error = "The Sample-ID queue is locked. Sample IDs are attached by B2C accounts.", code = "SID_QUEUE_LOCKED" },
        statusCode: StatusCodes.Status403Forbidden);

    public static void MapAccessionEndpoints(this WebApplication app)
    {
        var g = app.MapGroup("/api/accessioning").RequireAuthorization();

        g.MapGet("/pending", PendingAccessions)
         .RequireCapability(Capabilities.OrderView)
         .WithName("PendingAccessions");

        g.MapGet("/unregistered", PendingRegistrations)
         .RequireCapability(Capabilities.OrderView)
         .WithName("PendingRegistrations");

        g.MapGet("/tubes/{patientId:int}", OrderTubes)
         .RequireCapability(Capabilities.OrderView)
         .WithName("OrderTubes");

        g.MapPost("/sids", AddSids)
         .RequireCapability(Capabilities.OrderAccession)
         .WithName("AddSampleIds");

        g.MapPost("/register", Register)
         .RequireCapability(Capabilities.OrderAccession)
         .WithName("RegisterSamples");

        g.MapPost("/reject", Reject)
         .RequireCapability(Capabilities.OrderAccession)
         .WithName("RejectSamples");

        g.MapGet("/reject-reasons", RejectReasons)
         .RequireCapability(Capabilities.OrderView)
         .WithName("RejectReasons");
    }

    private static async Task<IResult> PendingAccessions(
        System.Security.Claims.ClaimsPrincipal principal,
        ScopeRepository scopes,
        AccessionRepository repo,
        CancellationToken ct,
        int page = 1,
        int pageSize = 100,
        // 'b2c', 'b2b', or absent for both. A filter on a queue, not a gate:
        // anyone who may see the queue may see either half of it. The channel
        // capabilities govern RAISING an order, not looking at one.
        string? kind = null)
    {
        if (principal.UserId() is not int userId) return Results.Unauthorized();
        if (!MaySeeSidQueue(principal)) return SidQueueLocked();

        var scope = await scopes.GetReportClientCodesAsync(userId, principal.Role(), ct).ConfigureAwait(false);
        if (scope.IsDenied) return Empty(pageSize);

        var result = await repo.PendingAccessionsAsync(scope.ClientCodes, page, pageSize, kind, ct)
            .ConfigureAwait(false);
        return Page(result.Rows, result.Total, result.Page, result.PageSize, result.PageCount);
    }

    /// <summary>
    /// Every Sample Sent tube in scope, whoever registered it, with the legacy
    /// Accession page's filters. Dates are yyyy-MM-dd on the registration
    /// date and optional; origin is lis | telo | infinity; unit is the
    /// client's business unit.
    /// </summary>
    private static async Task<IResult> PendingRegistrations(
        System.Security.Claims.ClaimsPrincipal principal,
        ScopeRepository scopes,
        AccessionRepository repo,
        CancellationToken ct,
        int page = 1,
        int pageSize = 100,
        string? from = null,
        string? to = null,
        string? sid = null,
        string? patient = null,
        string? origin = null,
        int? unit = null)
    {
        if (principal.UserId() is not int userId) return Results.Unauthorized();

        var scope = await scopes.GetReportClientCodesAsync(userId, principal.Role(), ct).ConfigureAwait(false);
        if (scope.IsDenied) return Empty(pageSize);

        static DateOnly? Day(string? s) =>
            DateOnly.TryParseExact(s, "yyyy-MM-dd", out var d) ? d : null;

        var filter = new RegistrationFilter(
            From: Day(from), To: Day(to),
            Sid: sid, Patient: patient,
            Origin: origin is "lis" or "telo" or "infinity" ? origin : null,
            BusinessUnit: unit);

        var result = await repo.PendingRegistrationsAsync(scope.ClientCodes, page, pageSize, filter, ct)
            .ConfigureAwait(false);
        return Page(result.Rows, result.Total, result.Page, result.PageSize, result.PageCount);
    }

    private static async Task<IResult> RejectReasons(AccessionRepository repo, CancellationToken ct) =>
        Results.Ok(new { reasons = await repo.RejectReasonsAsync(ct).ConfigureAwait(false) });

    public sealed record RejectRequest(IReadOnlyList<string> Vailids, string? Reason);

    /// <summary>
    /// Reject Sample Sent tubes at the desk — the legacy page's Reject tick.
    /// The reason is one of the LIS's own list, or free text; both land in
    /// reject_comments as the legacy writes it.
    /// </summary>
    private static async Task<IResult> Reject(
        [FromBody] RejectRequest body,
        System.Security.Claims.ClaimsPrincipal principal,
        AccessionRepository repo,
        Audit.AuditLog audit,
        HttpContext http,
        CancellationToken ct)
    {
        if (principal.UserId() is not int userId) return Results.Unauthorized();

        var username = principal.Username();
        if (string.IsNullOrWhiteSpace(username))
            return Results.BadRequest(new { error = "The acting user could not be identified." });

        if (body.Vailids is null || body.Vailids.Count == 0)
            return Results.BadRequest(new { error = "No Sample IDs supplied." });
        var reason = body.Reason?.Trim();
        if (string.IsNullOrWhiteSpace(reason))
            return Results.BadRequest(new { error = "A reason is required to reject a sample." });
        if (reason.Length > 200) reason = reason[..200];

        var ip = Audit.AuditIp.From(http);
        var result = await repo.RejectAsync(userId, username!, body.Vailids, reason, ip, ct).ConfigureAwait(false);

        if (result.Ok)
        {
            var rejected = result.Details.Where(d => d.Outcome == "rejected").Select(d => d.Vailid).ToList();
            audit.Log("sample.rejected", actor: userId, ip: ip,
                sid: rejected.Count == 1 ? rejected[0] : null,
                details: new { rejected = result.Rejected, skipped = result.Skipped, reason,
                               sids = rejected.Take(50).ToList() });
        }
        return result.Ok
            ? Results.Ok(result)
            : Results.BadRequest(new { error = result.Message, code = result.ErrorCode });
    }

    /// <summary>The tubes one order needs, for the barcode form.</summary>
    /*
     * Which tubes an order needs.
     *
     * Scoped, which it was not: the handler checked only that SOMEONE was
     * logged in and then answered for any patient id, so a collection centre
     * could read another centre's test names and the SID already issued
     * against them. Found by the G40 route sweep with a client token.
     *
     * The patient's OWNING centre decides, read from the database rather than
     * taken from the caller.
     */
    private static async Task<IResult> OrderTubes(
        int patientId,
        System.Security.Claims.ClaimsPrincipal principal,
        ScopeRepository scopes,
        AccessionRepository repo,
        CancellationToken ct)
    {
        if (principal.UserId() is not int userId) return Results.Unauthorized();

        var scope = await scopes.GetReportClientCodesAsync(userId, principal.Role(), ct).ConfigureAwait(false);
        if (scope.IsDenied) return Results.NotFound();

        if (!scope.IsUnrestricted)
        {
            var owner = await repo.PatientClientCodeAsync(patientId, ct).ConfigureAwait(false);
            if (owner is null
                || !scope.ClientCodes.Contains(owner.Trim(), StringComparer.OrdinalIgnoreCase))
            {
                return Results.NotFound();
            }
        }

        return Results.Ok(new { tubes = await repo.OrderTubesAsync(patientId, ct).ConfigureAwait(false) });
    }

    public sealed record AddSidsRequest(int PatientId, int Mcc, IReadOnlyList<SampleSid> Sids);

    /// <summary>
    /// Attach barcodes to an order's tubes.
    ///
    /// Barcodes are globally unique across Noble, so the procedure rejects one
    /// already used anywhere — including by the legacy LIS. Its message is
    /// passed through verbatim, because "that barcode is on another sample" is
    /// the one thing the operator holding the label needs to hear.
    /// </summary>
    private static async Task<IResult> AddSids(
        [FromBody] AddSidsRequest body,
        System.Security.Claims.ClaimsPrincipal principal,
        ScopeRepository scopes,
        AccessionRepository repo,
        Audit.AuditLog audit,
        HttpContext http,
        CancellationToken ct)
    {
        if (principal.UserId() is not int userId) return Results.Unauthorized();
        if (!MaySeeSidQueue(principal)) return SidQueueLocked();
        if (body.Sids is null || body.Sids.Count == 0)
            return Results.BadRequest(new { error = "No Sample IDs supplied." });

        // Operational scope, as for order creation: writing to a client's
        // samples is an operational act, not a reporting one.
        //
        // Membership, NOT `Count > 0 &&` — GetScopeAsync returns an explicit
        // list, so an empty one means no clients rather than all of them. The
        // earlier form let a user with no scope barcode anyone's samples.
        var scope = await scopes.GetScopeAsync(userId, ct).ConfigureAwait(false);
        if (!scope.Contains(body.Mcc)) return Results.NotFound();

        var result = await repo.AddSidsAsync(userId, body.PatientId, body.Mcc, body.Sids, ct)
            .ConfigureAwait(false);

        if (result.Ok)
            audit.Log("sample.sids_attached", actor: userId, ip: Audit.AuditIp.From(http),
                details: new { mcc = body.Mcc, patientId = body.PatientId, count = body.Sids.Count });
        return result.Ok
            ? Results.Ok(result)
            : Results.BadRequest(new { error = result.Message, code = result.ErrorCode });
    }

    public sealed record RegisterRequest(IReadOnlyList<string> Vailids);

    /// <summary>
    /// Receive the samples into the LIS. This is the moment they appear on the
    /// worksheet.
    /// </summary>
    private static async Task<IResult> Register(
        [FromBody] RegisterRequest body,
        System.Security.Claims.ClaimsPrincipal principal,
        AccessionRepository repo,
        Audit.AuditLog audit,
        HttpContext http,
        CancellationToken ct)
    {
        if (principal.UserId() is not int userId) return Results.Unauthorized();

        var username = principal.Username();
        if (string.IsNullOrWhiteSpace(username))
            return Results.BadRequest(new { error = "The acting user could not be identified." });

        if (body.Vailids is null || body.Vailids.Count == 0)
            return Results.BadRequest(new { error = "No Sample IDs supplied." });

        // Scope is enforced by the procedure resolving each barcode to a sample
        // it can see; a barcode belonging elsewhere simply does not register.
        var result = await repo.AccessionAsync(userId, username!, body.Vailids, ct).ConfigureAwait(false);

        var ip = Audit.AuditIp.From(http);
        var registered = result.Details.Where(d => d.Outcome == "registered").Select(d => d.Vailid).ToList();

        // What the legacy page does beside the register: the receiving unit
        // onto the tube, and the LIS's own activity row. Best effort after the
        // register has committed — a failure here must not read as "not
        // registered" to a desk that has just put a rack through.
        if (result.Ok && registered.Count > 0)
        {
            try
            {
                await repo.StampRegisteredAsync(userId, username!, registered, ip, ct).ConfigureAwait(false);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                http.RequestServices.GetRequiredService<ILoggerFactory>()
                    .CreateLogger("Accession")
                    .LogError(ex, "accession.stamp.failed user={User} sids={Sids}", userId, registered.Count);
            }
        }

        // The moment the wallet debit happens (CheckTransCash), so the trail
        // must carry it: this row is what "when was this charged" resolves to.
        if (result.Ok)
            audit.Log("sample.accessioned", actor: userId, ip: ip,
                sid: registered.Count == 1 ? registered[0] : (body.Vailids.Count == 1 ? body.Vailids[0] : null),
                details: new { registered = result.Registered, skipped = result.Skipped,
                               sids = registered.Take(50).ToList(),
                               skippedSids = result.Details.Where(d => d.Outcome != "registered")
                                                   .Select(d => d.Vailid).Take(50).ToList() });
        return result.Ok
            ? Results.Ok(result)
            : Results.BadRequest(new { error = result.Message, code = result.ErrorCode });
    }

    private static IResult Empty(int pageSize) => Results.Ok(new
    {
        rows = Array.Empty<object>(), count = 0, total = 0, page = 1, pageSize, pageCount = 0,
    });

    private static IResult Page<T>(IReadOnlyList<T> rows, int total, int page, int pageSize, int pageCount) =>
        Results.Ok(new { rows, count = rows.Count, total, page, pageSize, pageCount });
}
