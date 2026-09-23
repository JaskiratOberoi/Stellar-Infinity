/*
 * result-html-to-lines-20260923.sql
 *
 * The two result values Infinity's descriptive editor saved as HTML on
 * 2026-09-23 (sample 9472904, MACROSCOPIC / MICROSCOPIC DESCRIPTION), rewritten
 * as the plain lines the legacy LIS stores and shows. The LIS worksheet preview
 * printed the tags literally ("<div>VOLUME: 30&nbsp; ML</div>…"). Content is
 * unchanged: one line per <div>, a blank line for an empty one, &nbsp; a space.
 *
 * Scoped to the two ids, which are the only values in the table carrying a
 * <div> (checked over the last 300,000 rows). The originals are copied first.
 */
SET NOCOUNT ON;
SET XACT_ABORT ON;
BEGIN TRANSACTION;

IF OBJECT_ID('dbo.inf_result_value_backup_20260923') IS NULL
    SELECT id, vailid, testname, value, updatedby, updateddate
    INTO dbo.inf_result_value_backup_20260923
    FROM dbo.tbl_med_mcc_patient_test_result
    WHERE id IN (73861804, 73861805);

UPDATE dbo.tbl_med_mcc_patient_test_result
SET value = LTRIM(RTRIM(
    REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
        value,
        N'<div><br></div>', CHAR(13) + CHAR(10)),   -- an empty paragraph: a blank line
        N'</div><div>',     CHAR(13) + CHAR(10)),   -- paragraph boundary: a line break
        N'<br>',            CHAR(13) + CHAR(10)),
        N'<br/>',           CHAR(13) + CHAR(10)),
        N'<div>',           N''),
        N'</div>',          N''),
        N'&nbsp;',          N' '),
        N'&amp;',           N'&')))
WHERE id IN (73861804, 73861805) AND value LIKE N'%<div%';

PRINT CONCAT('rewritten: ', @@ROWCOUNT);
COMMIT TRANSACTION;

SELECT id, testname, REPLACE(REPLACE(value, CHAR(13), N''), CHAR(10), N' | ') AS lines
FROM dbo.tbl_med_mcc_patient_test_result WHERE id IN (73861804, 73861805);
