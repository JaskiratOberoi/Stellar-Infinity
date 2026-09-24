SET QUOTED_IDENTIFIER ON;
GO
/* Removes the four HEALTH CARE PROFILE Smart Report review orders on ZZTEST01
   (ZZHCP1A–ZZHCP4D, patients Meera Iyer / Vikram Sethi / Kavita Rao / Arvind
   Malhotra, added 2026-09-24 by zztest01-smart-hcp-fixtures-20260924.sql).
   Keyed on the fixture SIDs, never on a name a real patient could share. */
SET NOCOUNT ON;
SET XACT_ABORT ON;
BEGIN TRAN;
DECLARE @old TABLE (pid INT);
INSERT INTO @old (pid)
SELECT DISTINCT s.patient_id FROM dbo.tbl_med_mcc_patient_samples s JOIN dbo.tbl_med_mcc_patient_master p ON p.id = s.patient_id
WHERE p.mcc_code = 6094 AND s.vailid LIKE N'ZZHCP[1-4][A-D]';
DELETE FROM dbo.tbl_med_mcc_patient_test_result WHERE vailid LIKE N'ZZHCP[1-4][A-D]';
DELETE FROM dbo.tbl_med_mcc_patient_samples     WHERE vailid LIKE N'ZZHCP[1-4][A-D]';
DELETE FROM dbo.telo_custom_test_order          WHERE patient_id IN (SELECT pid FROM @old);
DELETE FROM dbo.tbl_med_mcc_patient_tests       WHERE patient_id IN (SELECT pid FROM @old);
DELETE FROM dbo.tbl_med_mcc_patient_master      WHERE id IN (SELECT pid FROM @old);
COMMIT;
SELECT removed_patients = (SELECT COUNT(*) FROM @old);
GO
