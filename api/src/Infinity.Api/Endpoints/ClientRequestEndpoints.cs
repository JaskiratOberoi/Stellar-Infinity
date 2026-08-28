using Infinity.Api.Auth;
using Infinity.Api.Notifications;
using Infinity.Api.Orders;
using Microsoft.AspNetCore.Mvc;

namespace Infinity.Api.Endpoints;

/// <summary>
/// The two client request channels the legacy LIS grants its centres —
/// Material Request Form (consumables) and Help Request Form — reachable at
/// last from Infinity. MRF rides the LIS's own tables so the storekeeper's
/// approval/dispatch workflow keeps working unchanged; help requests are
/// Infinity-native.
///
/// Scope: a client acts on its OWN centre, checked against the operational
/// scope like ordering — asking for tubes is an operational act. The lab side
/// (user:manage) sees and answers help requests across every centre.
/// </summary>
public static class ClientRequestEndpoints
{
    public static void MapClientRequestEndpoints(this WebApplication app)
    {
        var g = app.MapGroup("/api/requests")
                   .RequireAuthorization()
                   .RequireCapability(Capabilities.OrderView);

        g.MapGet("/mrf/items", GetCatalogue).WithName("MrfCatalogue");
        g.MapGet("/mrf", ListMrf).WithName("MrfList");
        g.MapPost("/mrf", CreateMrf).WithName("MrfCreate");
        g.MapPost("/mrf/{id:int}/cancel", CancelMrf).WithName("MrfCancel");

        g.MapGet("/help", ListHelp).WithName("HelpList");
        g.MapPost("/help", CreateHelp).WithName("HelpCreate");
        g.MapPost("/help/{id:int}/close", CloseHelp).WithName("HelpClose");

        // The lab answering. user:manage, like every cross-centre admin act.
        app.MapPost("/api/requests/help/{id:int}/respond", RespondHelp)
           .RequireAuthorization()
           .RequireCapability(Capabilities.UserManage)
           .WithName("HelpRespond");
    }

    private static async Task<bool> InScopeAsync(
        ScopeRepository scopes, int userId, int mcc, CancellationToken ct)
    {
        var scope = await scopes.GetScopeAsync(userId, ct).ConfigureAwait(false);
        return scope.Contains(mcc);
    }

    // ---- MRF ----------------------------------------------------------------

    private static async Task<IResult> GetCatalogue(ClientRequestRepository repo, CancellationToken ct)
        => Results.Ok(new { items = await repo.CatalogueAsync(ct).ConfigureAwait(false) });

    private static async Task<IResult> ListMrf(
        int mcc,
        System.Security.Claims.ClaimsPrincipal principal,
        ScopeRepository scopes,
        ClientRequestRepository repo,
        CancellationToken ct)
    {
        if (principal.UserId() is not int userId) return Results.Unauthorized();
        if (!await InScopeAsync(scopes, userId, mcc, ct).ConfigureAwait(false)) return Results.NotFound();
        return Results.Ok(new { rows = await repo.ListMrfAsync(mcc, ct).ConfigureAwait(false) });
    }

    public sealed record MrfItemRequest(int ItemId, int Qty);
    public sealed record CreateMrfRequest(int Mcc, IReadOnlyList<MrfItemRequest> Items);

    private static async Task<IResult> CreateMrf(
        [FromBody] CreateMrfRequest body,
        System.Security.Claims.ClaimsPrincipal principal,
        ScopeRepository scopes,
        ClientRequestRepository repo,
        Reads.CatalogRepository catalog,
        Audit.AuditLog audit,
        Mailer mail,
        HttpContext http,
        CancellationToken ct)
    {
        if (principal.UserId() is not int userId) return Results.Unauthorized();
        if (!await InScopeAsync(scopes, userId, body.Mcc, ct).ConfigureAwait(false)) return Results.NotFound();
        if (body.Items is not { Count: > 0 })
            return Results.BadRequest(new { error = "A material request needs at least one item." });
        if (body.Items.Count > 100)
            return Results.BadRequest(new { error = "Up to 100 items per request." });

        var itemsJson = System.Text.Json.JsonSerializer.Serialize(
            body.Items.Select(i => new { itemId = i.ItemId, qty = i.Qty }));

        var r = await repo.CreateMrfAsync(body.Mcc, userId, itemsJson, ct).ConfigureAwait(false);
        if (!r.Ok) return Results.BadRequest(new { error = r.Message, code = r.ErrorCode });

        audit.Log("mrf.created", actor: userId, ip: Audit.AuditIp.From(http),
            details: new { mcc = body.Mcc, requestId = r.Id, items = body.Items.Count });

        // The notification carries EVERYTHING — the storekeeper should not
        // need to open anything to know what to pull off the shelf.
        try
        {
            var clientCode = await catalog.ClientCodeAsync(body.Mcc, ct).ConfigureAwait(false);
            var items = await repo.CatalogueAsync(ct).ConfigureAwait(false);
            var byId = items.ToDictionary(i => i.Id);
            var who = principal.Username() ?? $"user #{userId}";
            decimal estimate = 0;
            var lines = string.Join("", body.Items.Select(i =>
            {
                byId.TryGetValue(i.ItemId, out var item);
                var rate = item?.Price ?? 0;
                estimate += rate * i.Qty;
                return $"<tr><td style='padding:4px 10px;border-bottom:1px solid #eee'>{Mailer.H(item?.Name ?? $"Item #{i.ItemId}")}</td>"
                     + $"<td style='padding:4px 10px;border-bottom:1px solid #eee;text-align:right'>{i.Qty}</td>"
                     + $"<td style='padding:4px 10px;border-bottom:1px solid #eee;text-align:right'>₹{rate:N2}</td></tr>";
            }));
            mail.Send(
                $"MRF #{r.Id} — {clientCode ?? body.Mcc.ToString()} — {body.Items.Count} item(s)",
                $"<div style='font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#222'>"
                + $"<h2 style='margin:0 0 4px'>Material request #{r.Id}</h2>"
                + $"<p style='margin:0 0 12px;color:#555'>Raised on Infinity by <b>{Mailer.H(who)}</b> for "
                + $"<b>{Mailer.H(clientCode ?? $"centre {body.Mcc}")}</b> · {DateTime.Now:dd MMM yyyy, hh:mm tt}</p>"
                + "<table style='border-collapse:collapse'>"
                + "<tr><th style='padding:4px 10px;text-align:left;border-bottom:2px solid #ccc'>Item</th>"
                + "<th style='padding:4px 10px;text-align:right;border-bottom:2px solid #ccc'>Qty</th>"
                + "<th style='padding:4px 10px;text-align:right;border-bottom:2px solid #ccc'>Rate</th></tr>"
                + lines
                + $"<tr><td style='padding:6px 10px;font-weight:bold'>Estimate</td><td></td>"
                + $"<td style='padding:6px 10px;text-align:right;font-weight:bold'>₹{estimate:N2}</td></tr>"
                + "</table>"
                + "<p style='color:#777;font-size:12px'>Approve and dispatch in the LIS as usual — this request is already in the inventory queue (status OPEN).</p>"
                + "</div>");
        }
        catch (Exception) when (!ct.IsCancellationRequested) { /* the request stands */ }

        return Results.Ok(new { ok = true, id = r.Id });
    }

    private static async Task<IResult> CancelMrf(
        int id,
        [FromBody] MccOnlyRequest body,
        System.Security.Claims.ClaimsPrincipal principal,
        ScopeRepository scopes,
        ClientRequestRepository repo,
        Reads.CatalogRepository catalog,
        Audit.AuditLog audit,
        Mailer mail,
        HttpContext http,
        CancellationToken ct)
    {
        if (principal.UserId() is not int userId) return Results.Unauthorized();
        if (!await InScopeAsync(scopes, userId, body.Mcc, ct).ConfigureAwait(false)) return Results.NotFound();

        var r = await repo.CancelMrfAsync(body.Mcc, userId, id, ct).ConfigureAwait(false);
        if (!r.Ok) return Results.BadRequest(new { error = r.Message, code = r.ErrorCode });

        audit.Log("mrf.cancelled", actor: userId, ip: Audit.AuditIp.From(http),
            details: new { mcc = body.Mcc, requestId = id });

        try
        {
            var clientCode = await catalog.ClientCodeAsync(body.Mcc, ct).ConfigureAwait(false);
            mail.Send(
                $"MRF #{id} cancelled — {clientCode ?? body.Mcc.ToString()}",
                $"<div style='font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#222'>"
                + $"<p><b>{Mailer.H(clientCode ?? $"centre {body.Mcc}")}</b> cancelled material request "
                + $"<b>#{id}</b> before approval · {DateTime.Now:dd MMM yyyy, hh:mm tt}. Nothing to dispatch.</p></div>");
        }
        catch (Exception) when (!ct.IsCancellationRequested) { /* the cancel stands */ }

        return Results.Ok(new { ok = true });
    }

    public sealed record MccOnlyRequest(int Mcc);

    // ---- help requests ------------------------------------------------------

    private static async Task<IResult> ListHelp(
        System.Security.Claims.ClaimsPrincipal principal,
        ScopeRepository scopes,
        ClientRequestRepository repo,
        CancellationToken ct,
        int? mcc = null)
    {
        if (principal.UserId() is not int userId) return Results.Unauthorized();

        // The lab's cross-centre view is the user:manage privilege; everyone
        // else must name a centre inside their own scope.
        if (mcc is null)
        {
            if (!principal.HasCapability(Capabilities.UserManage)) return Results.NotFound();
            return Results.Ok(new { rows = await repo.ListHelpAsync(null, ct).ConfigureAwait(false) });
        }
        if (!await InScopeAsync(scopes, userId, mcc.Value, ct).ConfigureAwait(false)) return Results.NotFound();
        return Results.Ok(new { rows = await repo.ListHelpAsync(mcc, ct).ConfigureAwait(false) });
    }

    public sealed record CreateHelpRequest(int Mcc, string Category, string Subject, string? Detail);

    private static async Task<IResult> CreateHelp(
        [FromBody] CreateHelpRequest body,
        System.Security.Claims.ClaimsPrincipal principal,
        ScopeRepository scopes,
        ClientRequestRepository repo,
        Reads.CatalogRepository catalog,
        Audit.AuditLog audit,
        Mailer mail,
        HttpContext http,
        CancellationToken ct)
    {
        if (principal.UserId() is not int userId) return Results.Unauthorized();
        if (!await InScopeAsync(scopes, userId, body.Mcc, ct).ConfigureAwait(false)) return Results.NotFound();

        var category = body.Category?.Trim().ToLowerInvariant();
        if (category is not ("technical" or "general"))
            return Results.BadRequest(new { error = "Category must be technical or general." });
        var subject = body.Subject?.Trim();
        if (string.IsNullOrEmpty(subject))
            return Results.BadRequest(new { error = "A subject is required." });
        if (subject.Length > 200) subject = subject[..200];
        var detail = string.IsNullOrWhiteSpace(body.Detail) ? null : body.Detail.Trim();
        if (detail?.Length > 2000) detail = detail[..2000];

        var r = await repo.CreateHelpAsync(body.Mcc, userId, category, subject, detail, ct).ConfigureAwait(false);

        audit.Log("help.created", actor: userId, ip: Audit.AuditIp.From(http),
            details: new { mcc = body.Mcc, requestId = r.Id, category });

        try
        {
            var clientCode = await catalog.ClientCodeAsync(body.Mcc, ct).ConfigureAwait(false);
            var who = principal.Username() ?? $"user #{userId}";
            mail.Send(
                $"Help request #{r.Id} — {clientCode ?? body.Mcc.ToString()} — {Mailer.H(subject)}",
                $"<div style='font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#222'>"
                + $"<h2 style='margin:0 0 4px'>{Mailer.H(subject)}</h2>"
                + $"<p style='margin:0 0 10px;color:#555'>{(category == "technical" ? "Technical" : "General")} · "
                + $"raised by <b>{Mailer.H(who)}</b> for <b>{Mailer.H(clientCode ?? $"centre {body.Mcc}")}</b> · "
                + $"{DateTime.Now:dd MMM yyyy, hh:mm tt}</p>"
                + (detail is null ? "" : $"<p style='white-space:pre-wrap'>{Mailer.H(detail)}</p>")
                + "<p style='color:#777;font-size:12px'>Answer it on Infinity → Admin → Help desk; the centre sees the reply on their Requests page.</p>"
                + "</div>");
        }
        catch (Exception) when (!ct.IsCancellationRequested) { /* the ticket stands */ }

        return Results.Ok(new { ok = true, id = r.Id });
    }

    private static async Task<IResult> CloseHelp(
        int id,
        [FromBody] MccOnlyRequest body,
        System.Security.Claims.ClaimsPrincipal principal,
        ScopeRepository scopes,
        ClientRequestRepository repo,
        Audit.AuditLog audit,
        HttpContext http,
        CancellationToken ct)
    {
        if (principal.UserId() is not int userId) return Results.Unauthorized();
        if (!await InScopeAsync(scopes, userId, body.Mcc, ct).ConfigureAwait(false)) return Results.NotFound();

        // The client path is mcc-scoped in the UPDATE itself, so a ticket id
        // from another centre updates nothing and 404s honestly.
        var r = await repo.UpdateHelpAsync(id, body.Mcc, "closed", null, null, ct).ConfigureAwait(false);
        if (!r.Ok) return Results.NotFound();

        audit.Log("help.closed", actor: userId, ip: Audit.AuditIp.From(http),
            details: new { mcc = body.Mcc, requestId = id });
        return Results.Ok(new { ok = true });
    }

    public sealed record RespondHelpRequest(string? Response, string Status);

    private static async Task<IResult> RespondHelp(
        int id,
        [FromBody] RespondHelpRequest body,
        System.Security.Claims.ClaimsPrincipal principal,
        ClientRequestRepository repo,
        Audit.AuditLog audit,
        HttpContext http,
        CancellationToken ct)
    {
        if (principal.UserId() is not int userId) return Results.Unauthorized();
        var status = body.Status?.Trim().ToLowerInvariant();
        if (status is not ("open" or "in_progress" or "closed"))
            return Results.BadRequest(new { error = "Status must be open, in_progress or closed." });
        var response = string.IsNullOrWhiteSpace(body.Response) ? null : body.Response.Trim();
        if (response?.Length > 2000) response = response[..2000];

        var r = await repo.UpdateHelpAsync(id, null, status, response, userId, ct).ConfigureAwait(false);
        if (!r.Ok) return Results.NotFound();

        audit.Log("help.responded", actor: userId, ip: Audit.AuditIp.From(http),
            details: new { requestId = id, status });
        return Results.Ok(new { ok = true });
    }
}
