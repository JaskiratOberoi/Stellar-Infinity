using Infinity.Api.Audit;
using Infinity.Api.Auth;

namespace Infinity.Api.Endpoints;

/// <summary>
/// The unified audit feed. Read-only — the writers live where the actions
/// happen; this is the one place the lab READS what both platforms did.
/// </summary>
public static class AuditEndpoints
{
    public static void MapAuditEndpoints(this WebApplication app)
    {
        // user:manage, the super-admin marker — the feed names users, bills,
        // amounts and IPs across every client, which is exactly the set of
        // facts every other endpoint carefully scopes. Same gate as Telo's
        // Audit trail tab.
        app.MapGet("/api/audit", GetTrail)
           .RequireAuthorization()
           .RequireCapability(Capabilities.UserManage)
           .WithName("GetAuditTrail");
    }

    private static async Task<IResult> GetTrail(
        AuditTrailRepository trail,
        CancellationToken ct,
        DateTime? from = null,
        DateTime? to = null,
        string? category = null,
        string? origin = null,
        int? actor = null,
        string? q = null,
        int? bill = null,
        string? sid = null,
        int page = 1,
        int pageSize = 50)
    {
        // The date pair arrives as whole days; the upper bound is exclusive
        // midnight so "to 24/08" includes all of the 24th.
        var toExclusive = to?.Date.AddDays(1);

        var result = await trail.ListAsync(
            from?.Date, toExclusive, category,
            origin is "infinity" or "telo" ? origin : null,
            actor, q, bill, sid, page, pageSize, ct).ConfigureAwait(false);

        var size = Math.Clamp(pageSize, 1, AuditTrailRepository.MaxPageSize);
        return Results.Ok(new
        {
            rows = result.Rows,
            total = result.Total,
            page = Math.Max(1, page),
            pageSize = size,
            pageCount = Math.Max(1, (result.Total + size - 1) / size),
        });
    }
}
