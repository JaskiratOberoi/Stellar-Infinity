/* QUOTED_IDENTIFIER is baked in at creation time; see script 70. */
SET QUOTED_IDENTIFIER ON;
GO
/*
 * 125_usp_inf_interfacing_read.sql
 *
 * The read half of the Interfacing screen: everything it shows about SITES and
 * their instruments comes from the two inf_lab_* tables, which are Infinity's
 * own and small — no LIS table is touched here. (The interfaced-vs-manual
 * counts, which DO read the LIS, live in script 126.)
 */

-- -------------------------------------------------------------- overview ----
/*
 * Result set 1: every site, with its business unit's name.
 * Result set 2: every instrument status row, carrying today's day slice so the
 *               screen can show "today: N samples / N results" without a second
 *               query. @today comes from the API because "today" is the LAB's
 *               calendar (IST), not the database server's.
 *
 * Alert derivation (disconnected / stuck-connecting / stale) is deliberately
 * NOT done here: it depends on "minutes ago" thresholds, and a procedure that
 * bakes wall-clock arithmetic into its rows returns answers that age between
 * the query and the render. The API computes it from the timestamps returned.
 */
CREATE OR ALTER PROCEDURE dbo.usp_inf_interfacing_overview
    @today DATE = NULL
AS
BEGIN
    SET NOCOUNT ON;

    IF @today IS NULL SET @today = CONVERT(DATE, SYSDATETIME());

    SELECT
        s.id, s.code, s.name, s.location, s.business_unit_id,
        business_unit_name = bu.BusinessUnitName,
        s.api_key_hint, s.is_active,
        s.agent_version, s.lab_name, s.lab_location,
        s.created_at, s.last_seen_at
    FROM dbo.inf_lab_site s
    LEFT JOIN dbo.tbl_med_business_unit_master bu ON bu.id = s.business_unit_id
    ORDER BY s.is_active DESC, s.code;

    SELECT
        i.site_id, i.instrument_key, i.name, i.driver_id, i.protocol,
        i.transport, i.address, i.enabled, i.status, i.status_since,
        i.last_message_at, i.messages_received, i.results_processed,
        i.result_params, i.errors, i.first_reported_at, i.updated_at,
        today_samples = ISNULL(d.samples, 0),
        today_results = ISNULL(d.results, 0),
        today_errors  = ISNULL(d.errors, 0)
    FROM dbo.inf_lab_instrument_status i
    LEFT JOIN dbo.inf_lab_instrument_day d
           ON d.site_id = i.site_id
          AND d.instrument_key = i.instrument_key
          AND d.[day] = @today
    ORDER BY i.site_id, i.instrument_key;
END
GO

-- ----------------------------------------------------------------- daily ----
/*
 * Day slices in a range, one row per site per instrument per day — the finest
 * grain stored, joined to the site for its code/name and to the status row for
 * the instrument's display name. Per-site-per-day totals are a client-side
 * fold over these rows; returning both grains would send every number twice.
 */
CREATE OR ALTER PROCEDURE dbo.usp_inf_interfacing_daily
    @from DATE,
    @to   DATE
AS
BEGIN
    SET NOCOUNT ON;

    SELECT
        d.site_id,
        s.code,
        s.name,
        d.instrument_key,
        instrument_name = i.name,
        d.[day],
        d.samples,
        d.results,
        d.errors
    FROM dbo.inf_lab_instrument_day d
    INNER JOIN dbo.inf_lab_site s ON s.id = d.site_id
    LEFT JOIN dbo.inf_lab_instrument_status i
           ON i.site_id = d.site_id AND i.instrument_key = d.instrument_key
    WHERE d.[day] BETWEEN @from AND @to
    ORDER BY d.[day] DESC, s.code, d.instrument_key;
END
GO

PRINT 'Created/updated usp_inf_interfacing_overview, usp_inf_interfacing_daily.';
GO
