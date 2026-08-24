using System.Data;
using System.Text.Json;
using System.Threading.Channels;
using Infinity.Api.Data;
using Microsoft.Data.SqlClient;

namespace Infinity.Api.Audit;

/// <summary>
/// The audit trail's writer — Infinity's port of Telo's <c>audit()</c>
/// (lib/audit.ts), same contract: every consequential action emits one event,
/// to two sinks. The log stream gets it immediately (it ships with the
/// container logs, as before), and dbo.inf_audit_log gets it best-effort, for
/// the in-app viewer.
///
/// An audit insert must never fail, slow, or hold up the business action that
/// emitted it. So <see cref="Log"/> is synchronous and cheap: it serialises
/// the event and drops it on a bounded channel; one background task drains
/// the channel into the table. When Noble is down or the channel is full the
/// event still exists in the log stream — the table is the queryable copy,
/// not the only copy — and the drop itself is logged.
///
/// NEVER pass passwords, card data, or full PII in <paramref name="details"/>
/// — identifiers and outcomes only. The details object is serialised to
/// camelCase JSON exactly as Telo's writer does, so the two platforms'
/// payloads read the same in the combined viewer.
/// </summary>
public sealed class AuditLog : IDisposable
{
    private sealed record Row(
        string Kind, int? ActorId, string? Username,
        int? BillId, string? Sid, string? Ip, string? Details);

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private readonly NobleConnectionFactory _db;
    private readonly ILogger<AuditLog> _logger;
    private readonly Channel<Row> _queue;
    private readonly Task _drain;
    private readonly CancellationTokenSource _stopping = new();

    public AuditLog(NobleConnectionFactory db, ILogger<AuditLog> logger)
    {
        _db = db;
        _logger = logger;
        // 4096 pending events is minutes of headroom at this system's rates;
        // past that, dropping newest is the correct failure mode — the log
        // stream still has every event, and blocking a login on an audit
        // backlog would invert the whole point of fire-and-forget.
        _queue = Channel.CreateBounded<Row>(new BoundedChannelOptions(4096)
        {
            SingleReader = true,
            FullMode = BoundedChannelFullMode.DropWrite,
        });
        _drain = Task.Run(DrainAsync);
    }

    /// <summary>
    /// Record one event. Synchronous and non-throwing by contract.
    /// </summary>
    /// <param name="kind">
    /// Dotted machine-readable kind, e.g. <c>order.placed</c> — the same
    /// vocabulary as Telo's where the action exists in both platforms, so the
    /// combined viewer needs one label table, not two.
    /// </param>
    /// <param name="billId">
    /// The one bill this event concerns, when it concerns exactly one — a
    /// real column, so the order dialog can show a bill's history without
    /// scanning JSON. Do NOT also put it in <paramref name="details"/>.
    /// </param>
    public void Log(
        string kind,
        int? actor = null,
        string? username = null,
        int? billId = null,
        string? sid = null,
        string? ip = null,
        object? details = null)
    {
        string? json = null;
        try
        {
            if (details is not null)
            {
                json = JsonSerializer.Serialize(details, Json);
                if (json == "{}") json = null;
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "audit.serialize.failed kind={Kind}", kind);
        }

        // Sink 1: the log stream, unconditionally.
        _logger.LogInformation("audit kind={Kind} actor={Actor} bill={BillId} sid={Sid} details={Details}",
            kind, actor, billId, sid, json);

        // Sink 2: the table, best-effort.
        var row = new Row(
            kind.Length > 60 ? kind[..60] : kind,
            actor,
            Trunc(username, 50),
            billId,
            Trunc(sid, 50),
            Trunc(ip, 45),
            Trunc(json, 2000));
        if (!_queue.Writer.TryWrite(row))
            _logger.LogWarning("audit.queue.full kind={Kind}", kind);
    }

    private static string? Trunc(string? s, int max) =>
        s is null ? null : s.Length > max ? s[..max] : s;

    private async Task DrainAsync()
    {
        var ct = _stopping.Token;
        await foreach (var row in _queue.Reader.ReadAllAsync(ct).ConfigureAwait(false))
        {
            try
            {
                await using var conn = await _db.OpenAsync(ct).ConfigureAwait(false);
                await using var cmd = NobleConnectionFactory.CreateCommand(conn, """
                    INSERT INTO dbo.inf_audit_log (kind, actor_id, username, bill_id, sid, ip, details)
                    VALUES (@kind, @actor, @username, @bill, @sid, @ip, @details);
                    """);
                cmd.Parameters.Add("@kind", SqlDbType.VarChar, 60).Value = row.Kind;
                cmd.Parameters.Add("@actor", SqlDbType.Int).Value = (object?)row.ActorId ?? DBNull.Value;
                cmd.Parameters.Add("@username", SqlDbType.NVarChar, 50).Value = (object?)row.Username ?? DBNull.Value;
                cmd.Parameters.Add("@bill", SqlDbType.Int).Value = (object?)row.BillId ?? DBNull.Value;
                cmd.Parameters.Add("@sid", SqlDbType.NVarChar, 50).Value = (object?)row.Sid ?? DBNull.Value;
                cmd.Parameters.Add("@ip", SqlDbType.VarChar, 45).Value = (object?)row.Ip ?? DBNull.Value;
                cmd.Parameters.Add("@details", SqlDbType.NVarChar, 2000).Value = (object?)row.Details ?? DBNull.Value;
                await cmd.ExecuteNonQueryAsync(ct).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                return;
            }
            catch (Exception ex)
            {
                // Table missing, Noble briefly down — the log stream above
                // already has the event. Named so ops can grep for losses.
                _logger.LogWarning(ex, "audit.persist.failed kind={Kind}", row.Kind);
            }
        }
    }

    public void Dispose()
    {
        _queue.Writer.TryComplete();
        _stopping.Cancel();
        try { _drain.Wait(TimeSpan.FromSeconds(2)); } catch { /* draining best-effort */ }
        _stopping.Dispose();
    }
}

/// <summary>
/// The caller's address as the API saw it, for the audit trail. The nginx in
/// front of this API sets X-Forwarded-For; cloudflared in front of THAT
/// appends too, and the first entry is the real client.
/// </summary>
public static class AuditIp
{
    public static string? From(HttpContext http)
    {
        var fwd = http.Request.Headers["X-Forwarded-For"].FirstOrDefault();
        if (!string.IsNullOrWhiteSpace(fwd))
        {
            var first = fwd.Split(',')[0].Trim();
            if (first.Length > 0) return first;
        }
        return http.Connection.RemoteIpAddress?.ToString();
    }
}
