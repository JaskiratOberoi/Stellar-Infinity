/* QUOTED_IDENTIFIER is baked in at creation time; see script 70. */
SET QUOTED_IDENTIFIER ON;
GO
/*
 * 124_usp_inf_lab_report.sql
 *
 * The write half of a Synapse status report, split into three small procedures
 * the API calls in sequence on one connection: touch the site, upsert each
 * instrument's status row, upsert each reported day slice.
 *
 * Upserts are UPDATE-then-INSERT rather than MERGE, deliberately: only one
 * agent per site ever writes these rows (it holds the site key), so the race
 * MERGE WITH (HOLDLOCK) exists to close cannot occur between two well-behaved
 * callers — and if two agents DO share a key, the unique constraint turns the
 * race into a clean error on the second insert rather than silent interleaving.
 */

-- ----------------------------------------------------------------- touch ----
CREATE OR ALTER PROCEDURE dbo.usp_inf_lab_report_touch
    @site_id       INT,
    @agent_version NVARCHAR(32)  = NULL,
    @lab_name      NVARCHAR(200) = NULL,
    @lab_location  NVARCHAR(200) = NULL
AS
BEGIN
    SET NOCOUNT ON;

    UPDATE dbo.inf_lab_site
    SET last_seen_at  = SYSDATETIMEOFFSET(),
        -- NULL means the agent did not say, not "forget what it said before".
        agent_version = ISNULL(@agent_version, agent_version),
        lab_name      = ISNULL(@lab_name, lab_name),
        lab_location  = ISNULL(@lab_location, lab_location)
    WHERE id = @site_id;
END
GO

-- ---------------------------------------------------------- status upsert ---
CREATE OR ALTER PROCEDURE dbo.usp_inf_lab_instrument_upsert
    @site_id           INT,
    @instrument_key    NVARCHAR(64),
    @name              NVARCHAR(200)  = NULL,
    @driver_id         NVARCHAR(100)  = NULL,
    @protocol          NVARCHAR(32)   = NULL,
    @transport         NVARCHAR(32)   = NULL,
    @address           NVARCHAR(200)  = NULL,
    @enabled           BIT            = 1,
    @status            NVARCHAR(20),
    @status_since      DATETIMEOFFSET = NULL,
    @last_message_at   DATETIMEOFFSET = NULL,
    @messages_received INT            = 0,
    @results_processed INT            = 0,
    @result_params     INT            = 0,
    @errors            INT            = 0
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    UPDATE dbo.inf_lab_instrument_status
    SET name              = @name,
        driver_id         = @driver_id,
        protocol          = @protocol,
        transport         = @transport,
        address           = @address,
        enabled           = @enabled,
        status            = @status,
        status_since      = @status_since,
        last_message_at   = @last_message_at,
        messages_received = @messages_received,
        results_processed = @results_processed,
        result_params     = @result_params,
        errors            = @errors,
        updated_at        = SYSDATETIMEOFFSET()
    WHERE site_id = @site_id AND instrument_key = @instrument_key;

    IF @@ROWCOUNT = 0
    BEGIN
        INSERT INTO dbo.inf_lab_instrument_status
            (site_id, instrument_key, name, driver_id, protocol, transport, address,
             enabled, status, status_since, last_message_at,
             messages_received, results_processed, result_params, errors, updated_at)
        VALUES
            (@site_id, @instrument_key, @name, @driver_id, @protocol, @transport, @address,
             @enabled, @status, @status_since, @last_message_at,
             @messages_received, @results_processed, @result_params, @errors, SYSDATETIMEOFFSET());
    END
END
GO

-- ------------------------------------------------------------- day upsert ---
CREATE OR ALTER PROCEDURE dbo.usp_inf_lab_day_upsert
    @site_id        INT,
    @instrument_key NVARCHAR(64),
    @day            DATE,
    @samples        INT = 0,
    @results        INT = 0,
    @errors         INT = 0
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    UPDATE dbo.inf_lab_instrument_day
    SET samples    = @samples,
        results    = @results,
        errors     = @errors,
        updated_at = SYSDATETIMEOFFSET()
    WHERE site_id = @site_id AND instrument_key = @instrument_key AND [day] = @day;

    IF @@ROWCOUNT = 0
    BEGIN
        INSERT INTO dbo.inf_lab_instrument_day
            (site_id, instrument_key, [day], samples, results, errors, updated_at)
        VALUES
            (@site_id, @instrument_key, @day, @samples, @results, @errors, SYSDATETIMEOFFSET());
    END
END
GO

PRINT 'Created/updated usp_inf_lab_report_touch, usp_inf_lab_instrument_upsert, usp_inf_lab_day_upsert.';
GO
