SET QUOTED_IDENTIFIER ON;
GO
/* Removes the eight definition-built MDCARE-package Smart Report review orders on
   ZZTEST01 (ZZMDP01A-ZZMDP08Q, added by zztest01-smart-mdcare-packages-defs-20260929.sql).
   Keyed on the fixture SIDs, never on a name a real patient could share. */
SET NOCOUNT ON;
SET XACT_ABORT ON;
BEGIN TRAN;
DECLARE @old TABLE (pid INT);
INSERT INTO @old (pid)
SELECT DISTINCT s.patient_id FROM dbo.tbl_med_mcc_patient_samples s JOIN dbo.tbl_med_mcc_patient_master p ON p.id = s.patient_id
WHERE p.mcc_code = 6094 AND s.vailid LIKE N'ZZMDP[0-9][0-9][A-Z]';
DELETE FROM dbo.tbl_med_mcc_patient_test_result WHERE vailid LIKE N'ZZMDP[0-9][0-9][A-Z]';
DELETE FROM dbo.tbl_med_mcc_patient_samples     WHERE vailid LIKE N'ZZMDP[0-9][0-9][A-Z]';
DELETE FROM dbo.telo_custom_test_order          WHERE patient_id IN (SELECT pid FROM @old);
DELETE FROM dbo.tbl_med_mcc_patient_tests       WHERE patient_id IN (SELECT pid FROM @old);
DELETE FROM dbo.tbl_med_mcc_patient_master      WHERE id IN (SELECT pid FROM @old);
COMMIT;
SELECT removed_patients = (SELECT COUNT(*) FROM @old);
GO
