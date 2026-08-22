/* QUOTED_IDENTIFIER is baked into every procedure and index at creation
   time, not taken from the caller. See script 70 for the failure mode this
   line prevents. */
SET QUOTED_IDENTIFIER ON;
GO
/*
 * 122_table_inf_lab_instrument.sql
 *
 * What each remote site's Synapse agent reports about its instruments:
 *
 *   • inf_lab_instrument_status — ONE row per (site, instrument), overwritten
 *     on every report. This is presence, not history: current status, when it
 *     changed, the last message, and the agent's cumulative counters.
 *
 *   • inf_lab_instrument_day — one row per (site, instrument, calendar day),
 *     upserted from the day slices the agent sends. Kept small deliberately:
 *     the API caps a report at 31 days per instrument, so a site that was
 *     offline for a month can backfill without being able to flood the table.
 *
 * Neither table touches the LIS schema. Interfaced-vs-manual counts come from
 * the LIS result table separately (script 126); these are the AGENT's numbers,
 * and disagreement between the two is signal, not error.
 *
 * Idempotent.
 */
SET NOCOUNT ON;

IF OBJECT_ID('dbo.inf_lab_instrument_status', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.inf_lab_instrument_status (
        id                INT IDENTITY(1,1) NOT NULL
                          CONSTRAINT PK_inf_lab_instrument_status PRIMARY KEY,

        site_id           INT            NOT NULL
                          CONSTRAINT FK_inf_lab_instrument_status_site
                          REFERENCES dbo.inf_lab_site (id),
        -- The agent's own stable identifier for the instrument, from its
        -- config file — NOT an inf_instrument id, which belongs to analysers
        -- posting into THIS system's inbox.
        instrument_key    NVARCHAR(64)   NOT NULL,

        name              NVARCHAR(200)  NULL,
        driver_id         NVARCHAR(100)  NULL,
        protocol          NVARCHAR(32)   NULL,
        transport         NVARCHAR(32)   NULL,   -- tcp-client | tcp-server | serial
        address           NVARCHAR(200)  NULL,
        enabled           BIT            NOT NULL CONSTRAINT DF_inf_lab_instr_enabled DEFAULT 1,

        -- online | offline | listening | error | connecting
        status            NVARCHAR(20)   NOT NULL,
        status_since      DATETIMEOFFSET NULL,
        last_message_at   DATETIMEOFFSET NULL,

        -- Cumulative since the agent started, as the agent counts them.
        messages_received INT            NOT NULL CONSTRAINT DF_inf_lab_instr_msgs    DEFAULT 0,
        results_processed INT            NOT NULL CONSTRAINT DF_inf_lab_instr_results DEFAULT 0,
        result_params     INT            NOT NULL CONSTRAINT DF_inf_lab_instr_params  DEFAULT 0,
        errors            INT            NOT NULL CONSTRAINT DF_inf_lab_instr_errors  DEFAULT 0,

        first_reported_at DATETIMEOFFSET NOT NULL CONSTRAINT DF_inf_lab_instr_first DEFAULT SYSDATETIMEOFFSET(),
        updated_at        DATETIMEOFFSET NOT NULL,

        CONSTRAINT UQ_inf_lab_instrument_status UNIQUE (site_id, instrument_key)
    );

    PRINT 'Created dbo.inf_lab_instrument_status.';
END
ELSE
BEGIN
    PRINT 'dbo.inf_lab_instrument_status already present.';
END
GO

IF OBJECT_ID('dbo.inf_lab_instrument_day', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.inf_lab_instrument_day (
        id             BIGINT IDENTITY(1,1) NOT NULL
                       CONSTRAINT PK_inf_lab_instrument_day PRIMARY KEY,

        site_id        INT            NOT NULL
                       CONSTRAINT FK_inf_lab_instrument_day_site
                       REFERENCES dbo.inf_lab_site (id),
        instrument_key NVARCHAR(64)   NOT NULL,
        [day]          DATE           NOT NULL,

        samples        INT            NOT NULL CONSTRAINT DF_inf_lab_day_samples DEFAULT 0,
        results        INT            NOT NULL CONSTRAINT DF_inf_lab_day_results DEFAULT 0,
        errors         INT            NOT NULL CONSTRAINT DF_inf_lab_day_errors  DEFAULT 0,

        updated_at     DATETIMEOFFSET NOT NULL,

        -- The upsert key: a report re-sending a day overwrites it.
        CONSTRAINT UQ_inf_lab_instrument_day UNIQUE (site_id, instrument_key, [day])
    );

    PRINT 'Created dbo.inf_lab_instrument_day.';
END
ELSE
BEGIN
    PRINT 'dbo.inf_lab_instrument_day already present.';
END
GO

-- The daily throughput screen asks by date range across every site, which the
-- unique constraint (leading on site_id) cannot serve.
IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE name = 'IX_inf_lab_instrument_day_day'
      AND object_id = OBJECT_ID('dbo.inf_lab_instrument_day'))
BEGIN
    CREATE INDEX IX_inf_lab_instrument_day_day
        ON dbo.inf_lab_instrument_day ([day]);
    PRINT 'Created IX_inf_lab_instrument_day_day.';
END
ELSE
BEGIN
    PRINT 'IX_inf_lab_instrument_day_day already present.';
END
GO
