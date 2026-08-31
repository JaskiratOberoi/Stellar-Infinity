/* =============================================================================
 * Infinity-only interpretation images, so the shared LIS table can go back to
 * the versions the legacy LIS prints correctly.
 *
 * The modernised HCV / HBV interpretation panels (2026-08-30) were loaded into
 * dbo.tbl_med_test_master_attachment — which the OLD LIS also prints from, and
 * it renders them incorrectly. The panels belong to Infinity's reports only.
 *
 * So: dbo.inf_test_attachment_override holds Infinity's own image per test id.
 * Infinity's report read (CatalogueDetailRepository) prefers a row here over
 * the shared table; the LIS never looks at this table. The shared table is
 * restored to the ORIGINAL images from dbo.inf_attachment_backup — the
 * earliest backup per attachment id (later rows are interim modern drafts,
 * backed up before the wide-format rebuild replaced them).
 *
 * Idempotent: the copy into the override only runs when the override is empty
 * for that test, and the restore only runs while the live row still differs
 * from the original. Re-running after the swap changes nothing.
 * ========================================================================== */

IF OBJECT_ID('dbo.inf_test_attachment_override', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.inf_test_attachment_override (
        testid      INT            NOT NULL PRIMARY KEY,
        attachment  VARBINARY(MAX) NOT NULL,
        note        NVARCHAR(200)  NULL,
        updated_at  DATETIME2(0)   NOT NULL CONSTRAINT DF_inf_att_override_at DEFAULT SYSDATETIME()
    );
END
GO

SET XACT_ABORT ON;
BEGIN TRAN;

/* 1 ─ Capture the CURRENT (modern, wide) panels as Infinity's own copies.
 *     Runs only while the override has no row for that test, so a later
 *     rerun cannot overwrite a deliberately updated override with whatever
 *     the shared table happens to hold by then. */
INSERT INTO dbo.inf_test_attachment_override (testid, attachment, note)
SELECT a.testid, a.attachment,
       N'Modern wide-format interpretation panel (2026-08-30); LIS keeps its original.'
FROM dbo.tbl_med_test_master_attachment a
WHERE a.id IN (31, 34)   -- 31 = HCV (test 352), 34 = HBV (test 350)
  AND NOT EXISTS (SELECT 1 FROM dbo.inf_test_attachment_override o
                  WHERE o.testid = a.testid);

/* 2 ─ Put the ORIGINAL images back in the shared table, from the EARLIEST
 *     backup row per attachment id (rows 1 and 2; rows 3 and 4 are interim
 *     modern drafts). Guarded so it only fires while the live row differs
 *     from that original, and refuses to run at all unless the override
 *     already holds the modern copy — the new image must never exist
 *     nowhere. */
IF (SELECT COUNT(*) FROM dbo.inf_test_attachment_override WHERE testid IN (350, 352)) <> 2
BEGIN
    ROLLBACK TRAN;
    THROW 50001, 'Override rows for tests 350/352 missing; refusing to restore the shared table.', 1;
END

UPDATE a
SET a.attachment = ob.attachment
FROM dbo.tbl_med_test_master_attachment a
CROSS APPLY (SELECT TOP 1 b.attachment
             FROM dbo.inf_attachment_backup b
             WHERE b.attachment_id = a.id
             ORDER BY b.id ASC) ob
WHERE a.id IN (31, 34)
  AND HASHBYTES('SHA2_256', a.attachment) <> HASHBYTES('SHA2_256', ob.attachment);

COMMIT TRAN;
GO

/* Read-back for the operator applying this: live should now equal the earliest
 * backup, and the override should hold the modern panels. */
SELECT a.id, a.testid,
       live_is_original = CASE WHEN HASHBYTES('SHA2_256', a.attachment) =
                                     HASHBYTES('SHA2_256', ob.attachment)
                               THEN 1 ELSE 0 END,
       override_len = (SELECT DATALENGTH(o.attachment)
                       FROM dbo.inf_test_attachment_override o
                       WHERE o.testid = a.testid)
FROM dbo.tbl_med_test_master_attachment a
CROSS APPLY (SELECT TOP 1 b.attachment
             FROM dbo.inf_attachment_backup b
             WHERE b.attachment_id = a.id
             ORDER BY b.id ASC) ob
WHERE a.id IN (31, 34);
