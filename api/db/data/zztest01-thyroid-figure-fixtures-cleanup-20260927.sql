SET QUOTED_IDENTIFIER ON;
GO
/* Removes the six Thyroid Profile I review orders on ZZTEST01 (ZZTHY01 to
   ZZTHY06; added by zztest01-thyroid-figure-fixtures-20260927.sql). Keyed on
   the fixture SIDs, never on a name a real patient could share. */
SET NOCOUNT ON;
SET XACT_ABORT ON;
BEGIN TRAN;
DECLARE @old TABLE (pid INT);
INSERT INTO @old (pid)
SELECT DISTINCT s.patient_id FROM dbo.tbl_med_mcc_patient_samples s JOIN dbo.tbl_med_mcc_patient_master p ON p.id = s.patient_id
WHERE p.mcc_code = 6094 AND s.vailid LIKE N'ZZTHY0[0-9]';
DELETE FROM dbo.tbl_med_mcc_patient_test_result WHERE vailid LIKE N'ZZTHY0[0-9]';
DELETE FROM dbo.tbl_med_mcc_patient_samples     WHERE vailid LIKE N'ZZTHY0[0-9]';
DELETE FROM dbo.tbl_med_mcc_patient_tests       WHERE patient_id IN (SELECT pid FROM @old);
DELETE FROM dbo.tbl_med_mcc_patient_master      WHERE id IN (SELECT pid FROM @old);
COMMIT;
SELECT removed_patients = (SELECT COUNT(*) FROM @old);
GO
