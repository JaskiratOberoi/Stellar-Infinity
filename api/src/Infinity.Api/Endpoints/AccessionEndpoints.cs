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
    public static void MapAccessionEndpoints(this WebApplication app)
    {
        var g = app.MapGroup("/api/accessioning").RequireAuthorization();

        g.MapGet("/pending", PendingAccessions)
         .RequireCapability(Capabilities.OrderView)
         .WithName("PendingAccessions");

        g.MapGet("/unregistered", PendingRegistrations)
         .RequireCapability(Capabilities.OrderView)
         .WithName("PendingRegistrations");

        g.MapPost("/sids", AddSids)
         .RequireCapability(Capabilities.OrderAccession)
         .WithName("AddSampleIds");

        g.MapPost("/register", Register)
         .RequireCapability(Capabilities.OrderAccession)
         .WithName("RegisterSamples");
    }

    private static async Task<IResult> PendingAccessions(
        System.Security.Claims.ClaimsPrincipal principal,
        ScopeRepository scopes,
        AccessionRepository repo,
        CancellationToken ct,
        int page = 1,
        int pageSize = 100)
    {
        if (principal.UserId() is not int userId) return Results.Unauthorized();

        var scope = await scopes.GetReportClientCodesAsync(userId, principal.Role(), ct).ConfigureAwait(false);
        if (scope.IsDenied) return Empty(pageSize);

        var result = await repo.PendingAccessionsAsync(scope.ClientCodes, page, pageSize, ct).ConfigureAwait(false);
        return Page(result.Rows, result.Total, result.Page, result.PageSize, result.PageCount);
    }

    private static async Task<IResult> PendingRegistrations(
        System.Security.Claims.ClaimsPrincipal principal,
        ScopeRepository scopes,
        AccessionRepository repo,
        CancellationToken ct,
        int page = 1,
        int pageSize = 100)
    {
        if (principal.UserId() is not int userId) return Results.Unauthorized();

        var scope = await scopes.GetReportClientCodesAsync(userId, principal.Role(), ct).ConfigureAwait(false);
        if (scope.IsDenied) return Empty(pageSize);

        var result = await repo.PendingRegistrationsAsync(scope.ClientCodes, page, pageSize, ct).ConfigureAwait(false);
        return Page(result.Rows, result.Total, result.Page, result.PageSize, result.PageCount);
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
        CancellationToken ct)
    {
        if (principal.UserId() is not int userId) return Results.Unauthorized();
        if (body.Sids is null || body.Sids.Count == 0)
            return Results.BadRequest(new { error = "No Sample IDs supplied." });

        // Operational scope, as for order creation: writing to a client's
        // samples is an operational act, not a reporting one.
        var scope = await scopes.GetScopeAsync(userId, ct).ConfigureAwait(false);
        if (scope.Count > 0 && !scope.Contains(body.Mcc)) return Results.NotFound();

        var result = await repo.AddSidsAsync(userId, body.PatientId, body.Mcc, body.Sids, ct)
            .ConfigureAwait(false);

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
