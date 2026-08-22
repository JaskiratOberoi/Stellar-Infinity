using System.Globalization;
using System.Security.Claims;
using Infinity.Api.Auth;
using Infinity.Api.Interfacing;

namespace Infinity.Api.Endpoints;

public static class InterfacingEndpoints
{
    /// <summary>The screens default to a week; a range can cover at most this many days.</summary>
    private const int MaxRangeDays = 92;

    public static void MapInterfacingEndpoints(this WebApplication app)
    {
        // ---- agent surface: site-key authenticated, NOT a user JWT ----------
        // Both anonymous and both under the Site rate limit, partitioned by
        // X-Site-Code, so one chatty agent cannot starve the others. CSRF does
        // not apply: these requests carry no session cookie, and the CSRF
        // middleware only examines requests that do.
        app.MapGet("/api/interfacing/ping", Ping)
           .AllowAnonymous()
           .RequireRateLimiting(RateLimitPolicies.Site)
           .WithName("InterfacingPing");

        app.MapPost("/api/interfacing/report", Report)
           .AllowAnonymous()
           .RequireRateLimiting(RateLimitPolicies.Site)
           .WithName("InterfacingReport");

        // ---- operator surface: normal user auth -----------------------------
        var admin = app.MapGroup("/api/interfacing")
                       .RequireAuthorization();

        admin.MapGet("/overview", Overview)
             .RequireCapability(Capabilities.AnalyticsView)
             .WithName("InterfacingOverview");

        admin.MapGet("/daily", Daily)
             .RequireCapability(Capabilities.AnalyticsView)
             .WithName("InterfacingDaily");

        admin.MapGet("/result-sources", ResultSources)
             .RequireCapability(Capabilities.AnalyticsView)
             .WithName("InterfacingResultSources");

        // Registering a site mints a credential that can post reports, so the
        // registry sits behind user:manage — same line the instrument registry
        // draws for the same reason.
        admin.MapGet("/sites", ListSites)
             .RequireCapability(Capabilities.UserManage)
             .WithName("ListLabSites");

        admin.MapPost("/sites", UpsertSite)
             .RequireCapability(Capabilities.UserManage)
             .WithName("UpsertLabSite");

        admin.MapGet("/business-units", BusinessUnits)
             .RequireCapability(Capabilities.UserManage)
             .WithName("InterfacingBusinessUnits");
    }

    /// <summary>
    /// Credential check for a Synapse agent — "am I configured correctly?".
    /// Valid creds get the site's registered identity back, so a misinstalled
    /// key surfaces as the WRONG NAME on the agent's own console rather than
    /// as silently misattributed reports.
    /// </summary>
    private static async Task<IResult> Ping(
        HttpContext http,
        SiteAuthenticator authenticator,
        CancellationToken ct)
    {
        var site = await authenticator.AuthenticateAsync(
            http.Request.Headers["X-Site-Code"].ToString(),
            http.Request.Headers["X-Site-Key"].ToString(),
            ct).ConfigureAwait(false);

        // Uniform 401 for unknown, inactive and wrong-key — an anonymous
        // endpoint should not confirm which site codes exist.
        if (site is null)
        {
            return Results.Problem(
                title: "Unauthorized",
                detail: "Unknown site code or key.",
                statusCode: StatusCodes.Status401Unauthorized);
        }

        return Results.Ok(new
        {
            ok = true,
            site = new { code = site.Code, name = site.Name, location = site.Location },
        });
    }

    /// <summary>
    /// Accept one status report from a site's agent.
    ///
    /// Returns 200 whatever the report contained: the agent has successfully
    /// delivered it and should not retry. Rows it could not use (no instrument
    /// key, unparseable day) are skipped, and over-length strings are truncated
    /// to column width — a monitoring channel must not go dark because a lab
    /// edited its config file carelessly.
    /// </summary>
    private static async Task<IResult> Report(
        SiteReport request,
        HttpContext http,
        SiteAuthenticator authenticator,
        InterfacingRepository repo,
        CancellationToken ct)
    {
        var site = await authenticator.AuthenticateAsync(
            http.Request.Headers["X-Site-Code"].ToString(),
            http.Request.Headers["X-Site-Key"].ToString(),
            ct).ConfigureAwait(false);

        if (site is null)
        {
            return Results.Problem(
                title: "Unauthorized",
                detail: "Unknown site code or key.",
                statusCode: StatusCodes.Status401Unauthorized);
        }

        await repo.ReportAsync(site.Id, request, ct).ConfigureAwait(false);

        return Results.Ok(new { ok = true });
    }

    private static async Task<IResult> Overview(InterfacingRepository repo, CancellationToken ct) =>
        Results.Ok(await repo.OverviewAsync(ct).ConfigureAwait(false));

    private static async Task<IResult> Daily(
        InterfacingRepository repo,
        CancellationToken ct,
        string? from = null,
        string? to = null)
    {
        var (f, t, error) = ParseRange(from, to);
        if (error is not null) return error;

        var rows = await repo.DailyAsync(f, t, ct).ConfigureAwait(false);
        return Results.Ok(new { rows, from = Iso(f), to = Iso(t) });
    }

    private static async Task<IResult> ResultSources(
        InterfacingRepository repo,
        CancellationToken ct,
        string? from = null,
        string? to = null)
    {
        var (f, t, error) = ParseRange(from, to);
        if (error is not null) return error;

        var rows = await repo.ResultSourcesAsync(f, t, ct).ConfigureAwait(false);
        return Results.Ok(new { rows, from = Iso(f), to = Iso(t) });
    }

    private static async Task<IResult> ListSites(InterfacingRepository repo, CancellationToken ct) =>
        Results.Ok(new { sites = await repo.ListSitesAsync(ct).ConfigureAwait(false) });

    private static async Task<IResult> BusinessUnits(InterfacingRepository repo, CancellationToken ct) =>
        Results.Ok(new { units = await repo.BusinessUnitsAsync(ct).ConfigureAwait(false) });

    private static async Task<IResult> UpsertSite(
        UpsertSiteRequest request,
        InterfacingRepository repo,
        ClaimsPrincipal principal,
        CancellationToken ct)
    {
        if (principal.UserId() is not int actor) return Results.Unauthorized();

        if (string.IsNullOrWhiteSpace(request.Code) || request.Code.Trim().Length > 20)
        {
            return Results.BadRequest(new
            {
                error = "A site code of 1-20 characters is required — the agent sends it as X-Site-Code.",
            });
        }

        if (string.IsNullOrWhiteSpace(request.Name) || request.Name.Trim().Length > 200)
        {
            return Results.BadRequest(new { error = "A name of 1-200 characters is required." });
        }

        var outcome = await repo.UpsertSiteAsync(request, actor, ct).ConfigureAwait(false);

        return outcome.Ok
            ? Results.Ok(new { site = outcome.Site, apiKey = outcome.ApiKey })
            : outcome.ErrorCode switch
            {
                "VALIDATION" => Results.BadRequest(new { error = outcome.Message }),
                _ => Results.Problem(title: "Operation failed", detail: outcome.Message,
                                     statusCode: StatusCodes.Status500InternalServerError),
            };
    }

    private static string Iso(DateTime d) => d.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);

    /// <summary>
    /// Resolve a from/to pair. Defaults to the last 7 IST days; refuses an
    /// inverted range and anything over <see cref="MaxRangeDays"/> days —
    /// the result-sources aggregation runs against the live LIS, and the range
    /// cap is what keeps a careless query string from becoming a table scan.
    /// </summary>
    private static (DateTime From, DateTime To, IResult? Error) ParseRange(string? from, string? to)
    {
        var today = DateTime.ParseExact(
            Reads.StatsRepository.TodayIst(), "yyyy-MM-dd", CultureInfo.InvariantCulture);

        var t = today;
        if (to is not null
            && !DateTime.TryParseExact(to, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out t))
        {
            return (default, default, Results.BadRequest(new { error = "'to' must be yyyy-MM-dd." }));
        }

        var f = t.AddDays(-6);
        if (from is not null
            && !DateTime.TryParseExact(from, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out f))
        {
            return (default, default, Results.BadRequest(new { error = "'from' must be yyyy-MM-dd." }));
        }

        if (f > t)
        {
            return (default, default, Results.BadRequest(new { error = "'from' must not be after 'to'." }));
        }

        if ((t - f).TotalDays > MaxRangeDays)
        {
            return (default, default, Results.BadRequest(new
            {
                error = $"The range may cover at most {MaxRangeDays} days.",
            }));
        }

        return (f, t, null);
    }
}
