SET QUOTED_IDENTIFIER ON;
GO
/* Removes the eight mini-profile Smart Report fixtures (ZZMINI01–08) on ZZTEST01. */
SET NOCOUNT ON;
SET XACT_ABORT ON;
BEGIN TRAN;
DECLARE @old TABLE (pid INT);
INSERT INTO @old (pid)
SELECT id FROM dbo.tbl_med_mcc_patient_master WHERE mcc_code = 6094 AND name LIKE N'ZZ TEST MINI %';
DELETE FROM dbo.tbl_med_mcc_patient_test_result WHERE vailid LIKE N'ZZMINI0_';
DELETE FROM dbo.tbl_med_mcc_patient_samples     WHERE vailid LIKE N'ZZMINI0_';
DELETE FROM dbo.telo_custom_test_order          WHERE patient_id IN (SELECT pid FROM @old);
DELETE FROM dbo.tbl_med_mcc_patient_master      WHERE id IN (SELECT pid FROM @old);
COMMIT;
SELECT removed_patients = (SELECT COUNT(*) FROM @old);
GO
