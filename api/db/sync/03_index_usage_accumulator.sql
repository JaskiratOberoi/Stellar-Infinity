/*
 * 03_index_usage_accumulator.sql
 *
 * Accumulates index usage across SQL Server restarts.
 *
 * WHY THIS EXISTS
 *
 * sys.dm_db_index_usage_stats is in-memory and RESETS on every service
 * restart. That is not a footnote here — it invalidated a decision twice in
 * one day:
 *
 *   2026-08-17 09:40  uptime  8.2h  -> "seven indexes served zero reads"
 *   2026-08-18 07:15  uptime  1.1h  -> counters wiped, evidence gone
 *
 * Noble restarted at 01:26 and again at 06:09 (server local, UTC+5:30). Two
 * restarts in 29 hours. Dropping a 4 GB index because it looked idle for an
 * hour would be indefensible, and without this table every restart puts the
 * decision back to zero.
 *
 * The snapshot is cumulative and restart-aware: it stores the delta since the
 * previous sample, detecting a reset by the counters going DOWN (a restart) or
 * the recorded start time changing. Run it hourly from SQL Agent (which is
 * running) or from any scheduler.
 *
 * Read-only against the LIS. Writes one small table in Noble; if even that is
 * unwanted, point it at another database by changing the two object names.
 */
SET NOCOUNT ON;
GO

IF OBJECT_ID('dbo.inf_index_usage_history', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.inf_index_usage_history (
        id              BIGINT IDENTITY(1,1) NOT NULL
                        CONSTRAINT PK_inf_index_usage_history PRIMARY KEY,
        captured_at     DATETIME2      NOT NULL CONSTRAINT DF_iiuh_at DEFAULT SYSUTCDATETIME(),
        server_start    DATETIME       NOT NULL,
        table_name      SYSNAME        NOT NULL,
        index_name      SYSNAME        NULL,
        index_id        INT            NOT NULL,
        size_mb         DECIMAL(12,1)  NULL,
        -- Cumulative since the CURRENT service start.
        seeks           BIGINT         NOT NULL,
        scans           BIGINT         NOT NULL,
        lookups         BIGINT         NOT NULL,
        updates_        BIGINT         NOT NULL,
        -- Delta since the previous capture. Across a restart the raw counters
        -- restart from zero, so the delta IS the post-restart value rather
        -- than a meaningless negative.
        d_seeks         BIGINT         NOT NULL DEFAULT 0,
        d_scans         BIGINT         NOT NULL DEFAULT 0,
        d_lookups       BIGINT         NOT NULL DEFAULT 0,
        was_restart     BIT            NOT NULL DEFAULT 0
    );
    CREATE INDEX IX_iiuh_lookup ON dbo.inf_index_usage_history (table_name, index_name, captured_at);
    PRINT 'Created dbo.inf_index_usage_history.';
END
GO

CREATE OR ALTER PROCEDURE dbo.usp_inf_capture_index_usage
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @start DATETIME = (SELECT sqlserver_start_time FROM sys.dm_os_sys_info);

    ;WITH cur AS (
        SELECT tbl = OBJECT_NAME(i.object_id), idx = i.name, i.index_id, i.object_id,
               size_mb = CAST(ISNULL((SELECT SUM(a.total_pages) FROM sys.partitions p
                          JOIN sys.allocation_units a ON a.container_id = p.partition_id
                          WHERE p.object_id = i.object_id AND p.index_id = i.index_id), 0)
                          * 8.0/1024 AS DECIMAL(12,1)),
               seeks = ISNULL(us.user_seeks, 0), scans = ISNULL(us.user_scans, 0),
               lookups = ISNULL(us.user_lookups, 0), updates_ = ISNULL(us.user_updates, 0)
        FROM sys.indexes i
        LEFT JOIN sys.dm_db_index_usage_stats us
               ON us.object_id = i.object_id AND us.index_id = i.index_id
              AND us.database_id = DB_ID()
        WHERE i.index_id > 0
          AND OBJECTPROPERTY(i.object_id, 'IsUserTable') = 1
    ),
    prev AS (
        SELECT h.table_name, h.index_id, h.seeks, h.scans, h.lookups, h.server_start,
               rn = ROW_NUMBER() OVER (PARTITION BY h.table_name, h.index_id
                                       ORDER BY h.captured_at DESC)
        FROM dbo.inf_index_usage_history h
    )
    INSERT INTO dbo.inf_index_usage_history
        (server_start, table_name, index_name, index_id, size_mb,
         seeks, scans, lookups, updates_, d_seeks, d_scans, d_lookups, was_restart)
    SELECT @start, c.tbl, c.idx, c.index_id, c.size_mb,
           c.seeks, c.scans, c.lookups, c.updates_,
           -- A restart is either a changed start time or counters that went
           -- backwards. In both cases the current value IS the delta.
           CASE WHEN p.server_start IS NULL OR p.server_start <> @start OR c.seeks < p.seeks
                THEN c.seeks ELSE c.seeks - p.seeks END,
           CASE WHEN p.server_start IS NULL OR p.server_start <> @start OR c.scans < p.scans
                THEN c.scans ELSE c.scans - p.scans END,
           CASE WHEN p.server_start IS NULL OR p.server_start <> @start OR c.lookups < p.lookups
                THEN c.lookups ELSE c.lookups - p.lookups END,
           CASE WHEN p.server_start IS NOT NULL AND p.server_start <> @start THEN 1 ELSE 0 END
    FROM cur c
    LEFT JOIN prev p ON p.table_name = c.tbl AND p.index_id = c.index_id AND p.rn = 1;
END
GO

-- The question this table exists to answer, once it has run for a while.
CREATE OR ALTER VIEW dbo.vw_inf_index_usage_total AS
SELECT table_name,
       index_name,
       size_mb        = MAX(size_mb),
       total_reads    = SUM(d_seeks + d_scans + d_lookups),
       observed_from  = MIN(captured_at),
       observed_to    = MAX(captured_at),
       observed_hours = CAST(DATEDIFF(MINUTE, MIN(captured_at), MAX(captured_at))/60.0 AS DECIMAL(10,1)),
       restarts_seen  = SUM(CAST(was_restart AS INT))
FROM dbo.inf_index_usage_history
GROUP BY table_name, index_name;
GO

EXEC dbo.usp_inf_capture_index_usage;
PRINT 'Baseline capture taken.';
GO
