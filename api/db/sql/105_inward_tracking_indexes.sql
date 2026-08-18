/*
 * 105_inward_tracking_indexes.sql
 *
 * ── PRODUCTION MIGRATION ────────────────────────────────────────────────────
 * Adds the first nonclustered indexes dbo.tbl_acc_inward_sample_tracking has
 * ever had. The table is ~233k rows and its only index is the clustered PK on
 * id (still named PK_tbl_cpath_inward_sample_tracking — a fossil), so every
 * legacy lookup — the (vailid, bunit) dedup check, the per-day slno count, the
 * grid's date window — is a full table scan. Role B measured and confirmed
 * this (docs/contracts/f1-inward-schema.md §1, §9 Q11).
 *
 * At 233k rows each build is sub-second, but this is still DDL on a table the
 * live LIS Inward page writes ~700 times a day: the build takes a brief Sch-M
 * lock. Plain CREATE INDEX (no ONLINE=ON — the server edition is not known to
 * support it, and at this size the window is milliseconds). Run it like any
 * other numbered script; no special timing needed.
 *
 * What each index serves:
 *
 *   IX_inf_inward_vailid (vailid) INCLUDE (bunit, scan_datetime)
 *     - usp_inf_inward_scan's (vailid, bunit) leg lookup — the query the
 *       legacy page runs on EVERY scan as a scan of the whole table.
 *     - Also what makes the scan procedure's UPDLOCK/HOLDLOCK on that lookup a
 *       key-range lock on one vailid instead of a lock on everything.
 *
 *   IX_inf_inward_scan_datetime (scan_datetime, bunit)
 *     - the list's date window.
 *
 *   IX_inf_inward_bunit_scan_datetime (bunit, scan_datetime) INCLUDE (slno)
 *     - the race-safe per-unit slno computation. Leading with bunit keeps its
 *       serializable key-range lock inside one unit instead of blocking every
 *       scanner for the whole day.
 *
 * Idempotent: each index is created only if missing.
 */
SET QUOTED_IDENTIFIER ON;
GO
SET NOCOUNT ON;

IF OBJECT_ID('dbo.tbl_acc_inward_sample_tracking', 'U') IS NULL
BEGIN
    RAISERROR('dbo.tbl_acc_inward_sample_tracking does not exist — wrong database?', 16, 1);
    RETURN;
END
GO

IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE name = 'IX_inf_inward_vailid'
      AND object_id = OBJECT_ID('dbo.tbl_acc_inward_sample_tracking'))
BEGIN
    CREATE NONCLUSTERED INDEX IX_inf_inward_vailid
        ON dbo.tbl_acc_inward_sample_tracking (vailid)
        INCLUDE (bunit, scan_datetime);
    PRINT 'Created IX_inf_inward_vailid.';
END
ELSE
    PRINT 'IX_inf_inward_vailid already present.';
GO

IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE name = 'IX_inf_inward_scan_datetime'
      AND object_id = OBJECT_ID('dbo.tbl_acc_inward_sample_tracking'))
BEGIN
    CREATE NONCLUSTERED INDEX IX_inf_inward_scan_datetime
        ON dbo.tbl_acc_inward_sample_tracking (scan_datetime, bunit);
    PRINT 'Created IX_inf_inward_scan_datetime.';
END
ELSE
    PRINT 'IX_inf_inward_scan_datetime already present.';
GO

IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE name = 'IX_inf_inward_bunit_scan_datetime'
      AND object_id = OBJECT_ID('dbo.tbl_acc_inward_sample_tracking'))
BEGIN
    CREATE NONCLUSTERED INDEX IX_inf_inward_bunit_scan_datetime
        ON dbo.tbl_acc_inward_sample_tracking (bunit, scan_datetime)
        INCLUDE (slno);
    PRINT 'Created IX_inf_inward_bunit_scan_datetime.';
END
ELSE
    PRINT 'IX_inf_inward_bunit_scan_datetime already present.';
GO
