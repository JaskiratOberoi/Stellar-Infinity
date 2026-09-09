/*
 * typhidot-igg-range-20260909.sql
 *
 * Typhidot IgG (test 2206, CP3121) has never had a reference range in the
 * catalogue: tbl_med_test_normalranges holds no row for it at all, so every
 * result row since 2019 (9,008 of them) was snapshotted with a blank
 * testnormal_range and the report prints "—" where IgM prints "Negative".
 * Both analytes are the same qualitative immunochromatography card; the
 * expected result for either is Negative.
 *
 * Fix, at the user's request on 2026-09-09 (SID 09624546):
 *   1. Give IgG the same six 'Report' rows IgM (test 213) carries — one per
 *      age type (1 years, 2 months, 3 days) and sex — so accessioning in
 *      Infinity, Telo and the legacy LIS (all read this table) snapshots
 *      "Negative" onto every new IgG result row.
 *   2. Backfill the SID that raised it, and every IgG result row not yet
 *      authorised — those reports are still being produced, so the range in
 *      force when they are issued is the corrected one.
 * Result rows already authorised are left as issued.
 *
 * Idempotent: rows are inserted only while IgG has no 'Report' rows; the
 * backfill touches only blank ranges.
 */
SET NOCOUNT ON;
SET XACT_ABORT ON;
BEGIN TRAN;

DECLARE @igg INT = 2206, @igm INT = 213;

IF NOT EXISTS (SELECT 1 FROM dbo.tbl_med_test_normalranges WHERE testid = @igg AND ReportType = N'Report')
BEGIN
    INSERT INTO dbo.tbl_med_test_normalranges
        (deptid, testid, fage, tage, gender, unit, fnormal, tnormal, IsActive, CreatedBy, CreatedDate, ReportType, agetype)
    SELECT deptid, @igg, fage, tage, gender, unit, fnormal, tnormal, 1, N'inf:jas', GETDATE(), ReportType, agetype
    FROM dbo.tbl_med_test_normalranges
    WHERE testid = @igm AND ReportType = N'Report' AND ISNULL(IsActive, 1) = 1;
    PRINT CONCAT('Inserted ', @@ROWCOUNT, ' Report range rows for Typhidot IgG.');
END
ELSE
    PRINT 'Typhidot IgG already has Report range rows; none inserted.';

UPDATE dbo.tbl_med_mcc_patient_test_result
   SET testnormal_range = N'Negative'
 WHERE testid = @igg
   AND ISNULL(testnormal_range, '') = ''
   AND (vailid = '09624546' OR ISNULL(auth, 0) = 0);
PRINT CONCAT('Backfilled ', @@ROWCOUNT, ' IgG result rows.');

COMMIT;

SELECT id, testid, agetype, gender, fage, tage, unit, fnormal, ReportType
FROM dbo.tbl_med_test_normalranges WHERE testid = @igg ORDER BY id;
SELECT id, testcode, testname, value, testunit, testnormal_range, auth
FROM dbo.tbl_med_mcc_patient_test_result WHERE vailid = '09624546' ORDER BY id;
