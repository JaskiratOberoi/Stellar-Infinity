/*
 * 01_enable_change_tracking.sql — phase 1 of the stellar replica
 * (docs/noble-db-modernization.md).
 *
 * Turns on SQL Server Change Tracking for the core tables, plus
 * ALLOW_SNAPSHOT_ISOLATION so the initial load can snapshot consistently.
 *
 * Deliberately NOT in api/db/sql/: DeploySql applies that folder wholesale on
 * every deploy, and infrastructure toggles should not ride along with
 * procedure updates. This folder is applied by hand, on purpose.
 *
 * WHAT THIS DOES TO THE LIVE SYSTEM — READ BEFORE RUNNING
 *
 *   - CHANGE_TRACKING at the database level starts an internal version
 *     counter. Per-table, the engine records (PK, version, operation) for
 *     every insert/update/delete into internal tables — a few dozen bytes per
 *     write. LISTEC and Telo notice nothing; no schema, procedure or
 *     application change is involved.
 *   - Each per-table ALTER takes a brief schema-modification lock. On a busy
 *     table it queues behind in-flight statements for a moment — the same
 *     class of pause as creating a small index. This script enables the big
 *     four last so the cheap ones land first.
 *   - ALLOW_SNAPSHOT_ISOLATION ON permits sessions to *opt in* to snapshot
 *     reads. It does not change the behaviour of any existing query — unlike
 *     READ_COMMITTED_SNAPSHOT, which this script deliberately DOES NOT touch,
 *     because that one changes read semantics for every connection including
 *     LISTEC's. Row versions start being kept in tempdb; at this workload's
 *     write rate that overhead is small.
 *   - Retention 7 days, AUTO_CLEANUP ON: the sync service may be down a week
 *     before a re-snapshot is needed; expired versions clean themselves up.
 *
 * Reversal, at any time, instant:
 *   ALTER TABLE <t> DISABLE CHANGE_TRACKING;             -- per table
 *   ALTER DATABASE Noble SET CHANGE_TRACKING = OFF;      -- after all tables
 *   ALTER DATABASE Noble SET ALLOW_SNAPSHOT_ISOLATION OFF;
 *
 * Idempotent: every step checks before it acts, so re-running is a no-op.
 * Runnable as nobleone (db_owner) — verified: needs no sysadmin, no SQL Agent.
 */
SET NOCOUNT ON;
GO

-------------------------------------------------------------------------------
-- 1. Snapshot isolation (opt-in only; see header).
-------------------------------------------------------------------------------
IF (SELECT snapshot_isolation_state FROM sys.databases WHERE database_id = DB_ID()) = 0
BEGIN
    ALTER DATABASE Noble SET ALLOW_SNAPSHOT_ISOLATION ON;
    PRINT 'ALLOW_SNAPSHOT_ISOLATION: enabled.';
END
ELSE
    PRINT 'ALLOW_SNAPSHOT_ISOLATION: already on.';
GO

-------------------------------------------------------------------------------
-- 2. Change tracking, database level.
-------------------------------------------------------------------------------
IF NOT EXISTS (SELECT 1 FROM sys.change_tracking_databases WHERE database_id = DB_ID())
BEGIN
    ALTER DATABASE Noble SET CHANGE_TRACKING = ON
        (CHANGE_RETENTION = 7 DAYS, AUTO_CLEANUP = ON);
    PRINT 'CHANGE_TRACKING (database): enabled, 7-day retention, auto cleanup.';
END
ELSE
    PRINT 'CHANGE_TRACKING (database): already on.';
GO

-------------------------------------------------------------------------------
-- 3. Per-table. TRACK_COLUMNS_UPDATED OFF everywhere: the sync refetches the
--    whole row by PK, so per-column bitmaps would be pure overhead.
--
--    Order matters only for lock comfort: masters and small tables first,
--    the four big movers last.
-------------------------------------------------------------------------------
DECLARE @tables TABLE (seq INT IDENTITY(1,1), name SYSNAME);
INSERT INTO @tables (name) VALUES
    -- masters and lookups
    ('tbl_med_mcc_unit_master'),
    ('tbl_med_user_master'),
    ('tbl_med_test_master'),
    ('tbl_med_mcc_doctors'),
    ('tbl_med_mcc_customer'),
    ('tbl_med_sample_master'),
    ('tbl_med_mcc_patient_samples_status_master'),
    -- billing
    ('tbl_billing_patient_detail'),
    ('tbl_billing_patient_test_detail'),
    ('tbl_billing_patient_amount_receipt'),
    ('tbl_med_mcc_account_detail'),
    -- clinical, small to large
    ('tbl_med_mcc_patient_test_result_attachment'),
    ('tbl_med_mcc_patient_clinicaldata'),
    ('tbl_med_mcc_patient_tests'),
    ('tbl_med_mcc_test_transactions'),
    ('tbl_med_mcc_patient_master'),
    ('tbl_med_mcc_patient_samples'),
    ('tbl_med_mcc_patient_test_result');

DECLARE @seq INT = 1, @name SYSNAME, @sql NVARCHAR(400);
WHILE @seq <= (SELECT MAX(seq) FROM @tables)
BEGIN
    SELECT @name = name FROM @tables WHERE seq = @seq;

    IF EXISTS (SELECT 1 FROM sys.change_tracking_tables
               WHERE object_id = OBJECT_ID('dbo.' + @name))
        PRINT CONCAT(@name, ': already tracked.');
    ELSE IF OBJECT_ID('dbo.' + @name) IS NULL
        PRINT CONCAT(@name, ': !! TABLE NOT FOUND — skipped.');
    ELSE
    BEGIN
        SET @sql = CONCAT('ALTER TABLE dbo.', QUOTENAME(@name),
                          ' ENABLE CHANGE_TRACKING WITH (TRACK_COLUMNS_UPDATED = OFF);');
        EXEC sys.sp_executesql @sql;
        PRINT CONCAT(@name, ': tracking enabled.');
    END

    SET @seq += 1;
END
GO

-------------------------------------------------------------------------------
-- 4. Verify and report the low-water mark. The version printed here is the
--    floor for the initial load: snapshot after this, then apply
--    CHANGETABLE(CHANGES ..., <this version>) to catch up.
-------------------------------------------------------------------------------
SELECT db_ct = (SELECT COUNT(*) FROM sys.change_tracking_databases WHERE database_id = DB_ID()),
       tracked_tables = (SELECT COUNT(*) FROM sys.change_tracking_tables),
       snapshot_isolation = (SELECT snapshot_isolation_state_desc FROM sys.databases WHERE database_id = DB_ID()),
       current_version = CHANGE_TRACKING_CURRENT_VERSION();

SELECT tracked = OBJECT_NAME(object_id), min_valid_version
FROM sys.change_tracking_tables
ORDER BY tracked;
GO
