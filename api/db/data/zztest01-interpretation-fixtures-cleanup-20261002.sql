/*
 * zztest01-interpretation-fixtures-cleanup-20261002.sql - removes the four
 * ZZINT01-04 review orders on ZZTEST01 (mcc 6094) that
 * zztest01-interpretation-fixtures-20261002.sql created. Fixtures only;
 * the draft texts in inf_test_interpretation stay.
 */
SET NOCOUNT ON;
SET XACT_ABORT ON;
BEGIN TRAN;
DECLARE @old TABLE (pid INT);
INSERT INTO @old (pid)
SELECT DISTINCT s.patient_id FROM dbo.tbl_med_mcc_patient_samples s JOIN dbo.tbl_med_mcc_patient_master p ON p.id = s.patient_id
WHERE p.mcc_code = 6094 AND s.vailid LIKE N'ZZINT0[0-9]';
DELETE FROM dbo.tbl_med_mcc_patient_test_result WHERE vailid LIKE N'ZZINT0[0-9]';
DELETE FROM dbo.tbl_med_mcc_patient_samples     WHERE vailid LIKE N'ZZINT0[0-9]';
DELETE FROM dbo.tbl_med_mcc_patient_tests       WHERE patient_id IN (SELECT pid FROM @old);
DELETE FROM dbo.tbl_med_mcc_patient_master      WHERE id IN (SELECT pid FROM @old);
COMMIT;
SELECT COUNT(*) AS zzint_left FROM dbo.tbl_med_mcc_patient_samples WHERE vailid LIKE N'ZZINT0[0-9]';
