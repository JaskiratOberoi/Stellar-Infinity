using System.Data;
using System.Globalization;
// Admin supplies GetOrdinalDateTimeOffset / GetOrdinalNullableBool;
// Auth supplies GetOrdinalString / GetOrdinalInt32 / GetOrdinalBool.
using Infinity.Api.Admin;
using Infinity.Api.Auth;
using Infinity.Api.Data;
using Infinity.Api.Worksheet;
using Microsoft.Data.SqlClient;

namespace Infinity.Api.Interfacing;

/// <summary>
/// Reads and writes for the Interfacing screen and the Synapse report intake.
///
/// Everything here goes through the inf_lab_* tables except
/// <see cref="ResultSourcesAsync"/>, which aggregates the LIS's own result
/// table — that one is range-limited, mirrors the worksheet's indexed join
/// topology, and is cached, because the table underneath it is 67 million rows
/// on a database the live LIS is also serving.
/// </summary>
public sealed class InterfacingRepository(
    NobleConnectionFactory db,
    SqlRetry retry,
    Caching.InfinityCache cache,
    SiteAuthenticator authenticator)
{
    /// <summary>A report names at most this many instruments; the rest are ignored.</summary>
    private const int MaxInstruments = 100;

    /// <summary>Day slices stored per instrument per report — a month of backfill, not a flood.</summary>
    private const int MaxDaysPerInstrument = 31;

    /// <summary>A site whose agent has not reported for this long is offline.</summary>
    private static readonly TimeSpan SiteStaleAfter = TimeSpan.FromMinutes(3);

    /// <summary>An instrument 'connecting' for longer than this is stuck, not starting.</summary>
    private static readonly TimeSpan StuckConnectingAfter = TimeSpan.FromMinutes(10);

    /// <summary>How long an interfaced-vs-manual aggregation is reused.</summary>
    private static readonly TimeSpan ResultSourcesTtl = TimeSpan.FromSeconds(300);

    /// <summary>Matches what the framework would produce: camelCase.</summary>
    private static readonly System.Text.Json.JsonSerializerOptions WebJson =
        new(System.Text.Json.JsonSerializerDefaults.Web);

    // ------------------------------------------------------------ report ----

    /// <summary>
    /// Apply one status report: touch the site, then upsert each instrument's
    /// status row and its day slices, sequentially on one connection.
    ///
    /// Not wrapped in SqlRetry as a whole: the agent re-sends the complete
    /// picture on every interval anyway, so a report lost to a transient fault
    /// is corrected by the next one rather than replayed here.
    /// </summary>
    public Task ReportAsync(int siteId, SiteReport report, CancellationToken ct = default) =>
        db.QueryAsync<object?>("interfacing.report", async (conn, inner) =>
        {
            await using (var touch = db.CreateWriteCommand(conn, "dbo.usp_inf_lab_report_touch"))
            {
                touch.Parameters.Add("@site_id", SqlDbType.Int).Value = siteId;
                touch.Parameters.Add("@agent_version", SqlDbType.NVarChar, 32).Value =
                    (object?)Trunc(report.AgentVersion, 32) ?? DBNull.Value;
                touch.Parameters.Add("@lab_name", SqlDbType.NVarChar, 200).Value =
                    (object?)Trunc(report.LabName, 200) ?? DBNull.Value;
                touch.Parameters.Add("@lab_location", SqlDbType.NVarChar, 200).Value =
                    (object?)Trunc(report.LabLocation, 200) ?? DBNull.Value;
                await touch.ExecuteNonQueryAsync(inner).ConfigureAwait(false);
            }

            if (report.Instruments is null) return null;

            foreach (var instrument in report.Instruments.Take(MaxInstruments))
            {
                // A row the agent could not name is a row nothing can be keyed
                // on. Skipped rather than failing the whole report.
                var key = Trunc(instrument.Key, 64);
                if (key is null) continue;

                await using (var up = db.CreateWriteCommand(conn, "dbo.usp_inf_lab_instrument_upsert"))
                {
                    up.Parameters.Add("@site_id", SqlDbType.Int).Value = siteId;
                    up.Parameters.Add("@instrument_key", SqlDbType.NVarChar, 64).Value = key;
                    up.Parameters.Add("@name", SqlDbType.NVarChar, 200).Value =
                        (object?)Trunc(instrument.Name, 200) ?? DBNull.Value;
                    up.Parameters.Add("@driver_id", SqlDbType.NVarChar, 100).Value =
                        (object?)Trunc(instrument.DriverId, 100) ?? DBNull.Value;
                    up.Parameters.Add("@protocol", SqlDbType.NVarChar, 32).Value =
                        (object?)Trunc(instrument.Protocol, 32) ?? DBNull.Value;
                    up.Parameters.Add("@transport", SqlDbType.NVarChar, 32).Value =
                        (object?)Trunc(instrument.Transport, 32) ?? DBNull.Value;
                    up.Parameters.Add("@address", SqlDbType.NVarChar, 200).Value =
                        (object?)Trunc(instrument.Address, 200) ?? DBNull.Value;
                    up.Parameters.Add("@enabled", SqlDbType.Bit).Value = instrument.Enabled;
                    // The column is NOT NULL; an agent that omitted the status
                    // still reported, and 'unknown' is the honest word for it.
                    up.Parameters.Add("@status", SqlDbType.NVarChar, 20).Value =
                        Trunc(instrument.Status, 20) ?? "unknown";
                    up.Parameters.Add("@status_since", SqlDbType.DateTimeOffset).Value =
                        (object?)instrument.StatusSince ?? DBNull.Value;
                    up.Parameters.Add("@last_message_at", SqlDbType.DateTimeOffset).Value =
                        (object?)instrument.LastMessageAt ?? DBNull.Value;
                    up.Parameters.Add("@messages_received", SqlDbType.Int).Value = instrument.MessagesReceived;
                    up.Parameters.Add("@results_processed", SqlDbType.Int).Value = instrument.ResultsProcessed;
                    up.Parameters.Add("@result_params", SqlDbType.Int).Value = instrument.ResultParamsProcessed;
                    up.Parameters.Add("@errors", SqlDbType.Int).Value = instrument.Errors;
                    await up.ExecuteNonQueryAsync(inner).ConfigureAwait(false);
                }

                if (instrument.Days is null) continue;

                foreach (var day in instrument.Days.Take(MaxDaysPerInstrument))
                {
                    if (!DateTime.TryParseExact(day.Date, "yyyy-MM-dd", CultureInfo.InvariantCulture,
                                                DateTimeStyles.None, out var date))
                    {
                        continue;
                    }

                    await using var dayCmd = db.CreateWriteCommand(conn, "dbo.usp_inf_lab_day_upsert");
                    dayCmd.Parameters.Add("@site_id", SqlDbType.Int).Value = siteId;
                    dayCmd.Parameters.Add("@instrument_key", SqlDbType.NVarChar, 64).Value = key;
                    dayCmd.Parameters.Add("@day", SqlDbType.Date).Value = date;
                    dayCmd.Parameters.Add("@samples", SqlDbType.Int).Value = day.Samples;
                    dayCmd.Parameters.Add("@results", SqlDbType.Int).Value = day.Results;
                    dayCmd.Parameters.Add("@errors", SqlDbType.Int).Value = day.Errors;
                    await dayCmd.ExecuteNonQueryAsync(inner).ConfigureAwait(false);
                }
            }

            return null;
        }, ct);

    // ---------------------------------------------------------- overview ----

    private sealed record RawInstrument(
        int SiteId, string Key, string? Name, string? DriverId, string? Protocol,
        string? Transport, string? Address, bool Enabled, string Status,
        DateTimeOffset? StatusSince, DateTimeOffset? LastMessageAt,
        int MessagesReceived, int ResultsProcessed, int ResultParams, int Errors,
        int TodaySamples, int TodayResults, int TodayErrors, DateTimeOffset? UpdatedAt);

    public Task<InterfacingOverview> OverviewAsync(CancellationToken ct = default) =>
        retry.ExecuteAsync("interfacing.overview", token =>
            db.QueryAsync("interfacing.overview", async (conn, inner) =>
            {
                await using var cmd = db.CreateWriteCommand(conn, "dbo.usp_inf_interfacing_overview");
                // "Today" is the lab's calendar, not the database server's.
                cmd.Parameters.Add("@today", SqlDbType.Date).Value =
                    DateTime.ParseExact(Reads.StatsRepository.TodayIst(), "yyyy-MM-dd", CultureInfo.InvariantCulture);

                await using var r = await cmd.ExecuteReaderAsync(inner).ConfigureAwait(false);

                // ---- result set 1: sites
                var sites = new List<(int Id, string Code, string Name, string? Location,
                                      int? BusinessUnitId, string? BusinessUnitName, bool IsActive,
                                      string? AgentVersion, string? LabName, string? LabLocation,
                                      DateTimeOffset? LastSeenAt)>();
                while (await r.ReadAsync(inner).ConfigureAwait(false))
                {
                    sites.Add((
                        r.GetOrdinalInt32("id") ?? 0,
                        r.GetOrdinalString("code") ?? "",
                        r.GetOrdinalString("name") ?? "",
                        r.GetOrdinalString("location"),
                        r.GetOrdinalInt32("business_unit_id"),
                        r.GetOrdinalString("business_unit_name"),
                        r.GetOrdinalBool("is_active"),
                        r.GetOrdinalString("agent_version"),
                        r.GetOrdinalString("lab_name"),
                        r.GetOrdinalString("lab_location"),
                        r.GetOrdinalDateTimeOffset("last_seen_at")));
                }

                // ---- result set 2: instrument status rows, grouped by site
                var bySite = new Dictionary<int, List<RawInstrument>>();
                await r.NextResultAsync(inner).ConfigureAwait(false);
                while (await r.ReadAsync(inner).ConfigureAwait(false))
                {
                    var row = new RawInstrument(
                        r.GetOrdinalInt32("site_id") ?? 0,
                        r.GetOrdinalString("instrument_key") ?? "",
                        r.GetOrdinalString("name"),
                        r.GetOrdinalString("driver_id"),
                        r.GetOrdinalString("protocol"),
                        r.GetOrdinalString("transport"),
                        r.GetOrdinalString("address"),
                        r.GetOrdinalBool("enabled"),
                        r.GetOrdinalString("status") ?? "unknown",
                        r.GetOrdinalDateTimeOffset("status_since"),
                        r.GetOrdinalDateTimeOffset("last_message_at"),
                        r.GetOrdinalInt32("messages_received") ?? 0,
                        r.GetOrdinalInt32("results_processed") ?? 0,
                        r.GetOrdinalInt32("result_params") ?? 0,
                        r.GetOrdinalInt32("errors") ?? 0,
                        r.GetOrdinalInt32("today_samples") ?? 0,
                        r.GetOrdinalInt32("today_results") ?? 0,
                        r.GetOrdinalInt32("today_errors") ?? 0,
                        r.GetOrdinalDateTimeOffset("updated_at"));

                    if (!bySite.TryGetValue(row.SiteId, out var list))
                    {
                        bySite[row.SiteId] = list = [];
                    }
                    list.Add(row);
                }

                return Compose(sites, bySite);
            }, token), ct);

    /// <summary>
    /// Turn raw rows into the overview, deriving alerts against the clock.
    ///
    /// The rules, in the order they win:
    ///   • status offline/error            → "disconnected"
    ///   • connecting for over ten minutes → "stuck-connecting"
    ///   • agent silent for over 3 minutes → "stale" (site offline), unless the
    ///     instrument already carries a sharper alert
    /// A disabled instrument never alerts — someone switched it off on
    /// purpose — and a deactivated SITE never alerts for the same reason.
    /// </summary>
    private static InterfacingOverview Compose(
        List<(int Id, string Code, string Name, string? Location,
              int? BusinessUnitId, string? BusinessUnitName, bool IsActive,
              string? AgentVersion, string? LabName, string? LabLocation,
              DateTimeOffset? LastSeenAt)> sites,
        Dictionary<int, List<RawInstrument>> bySite)
    {
        var now = DateTimeOffset.UtcNow;
        var overview = new List<SiteOverview>(sites.Count);
        var alerts = new List<InterfacingAlert>();

        foreach (var s in sites)
        {
            var online = s.IsActive
                && s.LastSeenAt is DateTimeOffset seen
                && now - seen < SiteStaleAfter;

            var raw = bySite.TryGetValue(s.Id, out var list) ? list : new List<RawInstrument>();
            var instruments = new List<SiteInstrument>(raw.Count);

            foreach (var i in raw)
            {
                InstrumentAlert? alert = null;
                if (s.IsActive && i.Enabled)
                {
                    if (i.Status is "offline" or "error")
                    {
                        alert = new InstrumentAlert("disconnected", i.StatusSince);
                    }
                    else if (i.Status == "connecting"
                             && i.StatusSince is DateTimeOffset since
                             && now - since > StuckConnectingAfter)
                    {
                        alert = new InstrumentAlert("stuck-connecting", since);
                    }

                    if (alert is null && !online)
                    {
                        alert = new InstrumentAlert("stale", s.LastSeenAt);
                    }
                }

                instruments.Add(new SiteInstrument(
                    i.Key, i.Name, i.DriverId, i.Protocol, i.Transport, i.Address,
                    i.Enabled, i.Status, i.StatusSince, i.LastMessageAt,
                    i.MessagesReceived, i.ResultsProcessed, i.ResultParams, i.Errors,
                    i.TodaySamples, i.TodayResults, i.TodayErrors, i.UpdatedAt, alert));

                if (alert is not null)
                {
                    alerts.Add(new InterfacingAlert(
                        s.Id, s.Code, s.Name, i.Key, i.Name, alert.Kind, alert.Since));
                }
            }

            overview.Add(new SiteOverview(
                s.Id, s.Code, s.Name, s.Location, s.BusinessUnitId, s.BusinessUnitName,
                s.IsActive, online, s.LastSeenAt, s.AgentVersion, s.LabName, s.LabLocation,
                instruments));
        }

        return new InterfacingOverview(overview, alerts);
    }

    // ------------------------------------------------------------- daily ----

    public Task<IReadOnlyList<InterfacingDailyRow>> DailyAsync(
        DateTime from, DateTime to, CancellationToken ct = default) =>
        retry.ExecuteAsync("interfacing.daily", token =>
            db.QueryAsync("interfacing.daily", async (conn, inner) =>
            {
                await using var cmd = db.CreateWriteCommand(conn, "dbo.usp_inf_interfacing_daily");
                cmd.Parameters.Add("@from", SqlDbType.Date).Value = from.Date;
                cmd.Parameters.Add("@to", SqlDbType.Date).Value = to.Date;

                await using var r = await cmd.ExecuteReaderAsync(CommandBehavior.SingleResult, inner).ConfigureAwait(false);
                var rows = new List<InterfacingDailyRow>();
                while (await r.ReadAsync(inner).ConfigureAwait(false))
                {
                    rows.Add(new InterfacingDailyRow(
                        r.GetOrdinalInt32("site_id") ?? 0,
                        r.GetOrdinalString("code") ?? "",
                        r.GetOrdinalString("name") ?? "",
                        r.GetOrdinalString("instrument_key") ?? "",
                        r.GetOrdinalString("instrument_name"),
                        r.GetDateTime(r.GetOrdinal("day")).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
                        r.GetOrdinalInt32("samples") ?? 0,
                        r.GetOrdinalInt32("results") ?? 0,
                        r.GetOrdinalInt32("errors") ?? 0));
                }
                return (IReadOnlyList<InterfacingDailyRow>)rows;
            }, token), ct);

    // ---------------------------------------------------- result sources ----

    /// <summary>
    /// Interfaced-vs-manual counts from the LIS result table, cached for five
    /// minutes per date range: the aggregation reads a shared production
    /// database, and every admin polling the screen re-asking it would turn a
    /// monitoring page into load on the LIS.
    /// </summary>
    public async Task<IReadOnlyList<ResultSourceRow>> ResultSourcesAsync(
        DateTime from, DateTime to, CancellationToken ct = default)
    {
        var key = $"interfacing:sources:{from:yyyyMMdd}:{to:yyyyMMdd}";

        var hit = await cache.GetAsync(key, ct).ConfigureAwait(false);
        if (hit is not null)
        {
            var cached = System.Text.Json.JsonSerializer.Deserialize<List<ResultSourceRow>>(hit, WebJson);
            if (cached is not null) return cached;
        }

        var rows = await retry.ExecuteAsync("interfacing.sources", token =>
            db.QueryAsync("interfacing.sources", async (conn, inner) =>
            {
                await using var cmd = db.CreateWriteCommand(conn, "dbo.usp_inf_interfacing_result_sources");
                cmd.Parameters.Add("@from", SqlDbType.Date).Value = from.Date;
                cmd.Parameters.Add("@to", SqlDbType.Date).Value = to.Date;

                await using var r = await cmd.ExecuteReaderAsync(CommandBehavior.SingleResult, inner).ConfigureAwait(false);
                var list = new List<ResultSourceRow>();
                while (await r.ReadAsync(inner).ConfigureAwait(false))
                {
                    list.Add(new ResultSourceRow(
                        r.GetDateTime(r.GetOrdinal("day")).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
                        r.GetOrdinalInt32("business_unit_id"),
                        r.GetOrdinalString("business_unit_code"),
                        r.GetOrdinalString("business_unit_name"),
                        r.GetOrdinalString("machine_name"),
                        r.GetOrdinalString("entry_mode") ?? "manual",
                        Convert.ToInt64(r.GetValue(r.GetOrdinal("result_count")))));
                }
                return (IReadOnlyList<ResultSourceRow>)list;
            }, token), ct).ConfigureAwait(false);

        await cache.SetAsync(key, System.Text.Json.JsonSerializer.Serialize(rows, WebJson),
                             ResultSourcesTtl, ct).ConfigureAwait(false);
        return rows;
    }

    // ------------------------------------------------------ site registry ----

    public Task<IReadOnlyList<LabSite>> ListSitesAsync(CancellationToken ct = default) =>
        retry.ExecuteAsync("interfacing.sites", token =>
            db.QueryAsync("interfacing.sites", async (conn, inner) =>
            {
                await using var cmd = db.CreateWriteCommand(conn, "dbo.usp_inf_lab_site_list");
                await using var r = await cmd.ExecuteReaderAsync(CommandBehavior.SingleResult, inner).ConfigureAwait(false);

                var list = new List<LabSite>();
                while (await r.ReadAsync(inner).ConfigureAwait(false))
                {
                    list.Add(ReadSite(r));
                }
                return (IReadOnlyList<LabSite>)list;
            }, token), ct);

    /// <summary>
    /// Create or update a site. The API key is minted HERE, server-side, when
    /// creating or when rotation is requested: 32 random bytes, shown to the
    /// caller exactly once, stored only as a pbkdf2 hash with a 6-character
    /// hint so an operator can tell which key a site has installed.
    /// </summary>
    public Task<UpsertSiteOutcome> UpsertSiteAsync(
        UpsertSiteRequest request, int actor, CancellationToken ct = default) =>
        db.QueryAsync("interfacing.site.upsert", async (conn, inner) =>
        {
            string? apiKey = null, hash = null, hint = null;
            if (request.Id is null || request.RotateKey)
            {
                apiKey = GenerateKey();
                hash = PasswordHash.Create(apiKey);
                hint = apiKey[..6];
            }

            await using var cmd = db.CreateWriteCommand(conn, "dbo.usp_inf_lab_site_upsert");
            cmd.Parameters.Add("@id", SqlDbType.Int).Value = (object?)request.Id ?? DBNull.Value;
            cmd.Parameters.Add("@code", SqlDbType.NVarChar, 20).Value = request.Code.Trim();
            cmd.Parameters.Add("@name", SqlDbType.NVarChar, 200).Value = request.Name.Trim();
            cmd.Parameters.Add("@location", SqlDbType.NVarChar, 200).Value =
                (object?)Trunc(request.Location, 200) ?? DBNull.Value;
            cmd.Parameters.Add("@business_unit_id", SqlDbType.Int).Value =
                (object?)request.BusinessUnitId ?? DBNull.Value;
            cmd.Parameters.Add("@is_active", SqlDbType.Bit).Value = request.IsActive;
            cmd.Parameters.Add("@api_key_hash", SqlDbType.NVarChar, 200).Value = (object?)hash ?? DBNull.Value;
            cmd.Parameters.Add("@api_key_hint", SqlDbType.NVarChar, 8).Value = (object?)hint ?? DBNull.Value;
            cmd.Parameters.Add("@actor_user_id", SqlDbType.Int).Value = actor;

            await using var r = await cmd.ExecuteReaderAsync(CommandBehavior.SingleResult, inner).ConfigureAwait(false);
            if (!await r.ReadAsync(inner).ConfigureAwait(false))
            {
                return new UpsertSiteOutcome(false, "INTERNAL", "The operation returned no result.", null, null);
            }

            if (!r.GetOrdinalBool("ok"))
            {
                return new UpsertSiteOutcome(
                    false,
                    r.GetOrdinalString("error_code"),
                    r.GetOrdinalString("message"),
                    null, null);
            }

            var site = ReadSite(r);

            // Rotation and deactivation must bite before the 60-second lookup
            // cache expires — a revoked key that keeps working for a minute is
            // a minute of results from a credential someone just distrusted.
            await authenticator.InvalidateAsync(site.Code, inner).ConfigureAwait(false);

            return new UpsertSiteOutcome(true, null, null, site, apiKey);
        }, ct);

    public Task<IReadOnlyList<SiteBusinessUnit>> BusinessUnitsAsync(CancellationToken ct = default) =>
        retry.ExecuteAsync("interfacing.units", token =>
            db.QueryAsync("interfacing.units", async (conn, inner) =>
            {
                await using var cmd = db.CreateWriteCommand(conn, "dbo.usp_inf_business_units");
                await using var r = await cmd.ExecuteReaderAsync(CommandBehavior.SingleResult, inner).ConfigureAwait(false);

                var list = new List<SiteBusinessUnit>();
                while (await r.ReadAsync(inner).ConfigureAwait(false))
                {
                    list.Add(new SiteBusinessUnit(
                        r.GetOrdinalInt32("id") ?? 0,
                        r.GetOrdinalString("code"),
                        r.GetOrdinalString("name")));
                }
                return (IReadOnlyList<SiteBusinessUnit>)list;
            }, token), ct);

    // ------------------------------------------------------------ helpers ----

    /// <summary>Maps the site projection shared by list and upsert.</summary>
    private static LabSite ReadSite(SqlDataReader r) =>
        new(
            r.GetOrdinalInt32("id") ?? 0,
            r.GetOrdinalString("code") ?? "",
            r.GetOrdinalString("name") ?? "",
            r.GetOrdinalString("location"),
            r.GetOrdinalInt32("business_unit_id"),
            r.GetOrdinalString("business_unit_name"),
            r.GetOrdinalString("api_key_hint"),
            r.GetOrdinalBool("is_active"),
            r.GetOrdinalString("agent_version"),
            r.GetOrdinalString("lab_name"),
            r.GetOrdinalString("lab_location"),
            r.GetOrdinalDateTimeOffset("created_at"),
            r.GetOrdinalDateTimeOffset("last_seen_at"),
            r.GetOrdinalInt32("instrument_count") ?? 0);

    /// <summary>
    /// 32 random bytes as lowercase hex — 64 characters, config-file friendly
    /// (no characters a YAML or .env parser could misread).
    /// </summary>
    private static string GenerateKey() =>
        Convert.ToHexString(System.Security.Cryptography.RandomNumberGenerator.GetBytes(32))
            .ToLowerInvariant();

    /// <summary>
    /// Trim, and truncate to the column width rather than erroring: a report
    /// must not be refused because a lab typed a long address into its config.
    /// Whitespace-only collapses to null.
    /// </summary>
    private static string? Trunc(string? s, int max)
    {
        if (string.IsNullOrWhiteSpace(s)) return null;
        var t = s.Trim();
        return t.Length <= max ? t : t[..max];
    }
}
