SET QUOTED_IDENTIFIER ON;
GO
/*
 * zztest01-smart-fixture-cleanup-20260918.sql — removes what the fixture wrote.
 *
 * Deletes only the ZZTEST01 patients 'ZZ TEST SMART V2' and 'ZZ TEST SMART V2
 * MALE', their samples ZZSMART01 and ZZSMART02, their results and their SMART-RPT
 * entitlements. Matched on the patient
 * and the SID, so it cannot reach anything else on the centre.
 */
SET NOCOUNT ON;
SET XACT_ABORT ON;

BEGIN TRAN;

DECLARE @pids TABLE (pid INT);
INSERT INTO @pids (pid)
SELECT id FROM dbo.tbl_med_mcc_patient_master WHERE mcc_code = 6094 AND name IN (N'ZZ TEST SMART V2', N'ZZ TEST SMART V2 MALE');

DELETE FROM dbo.tbl_med_mcc_patient_test_result WHERE vailid IN (N'ZZSMART01', N'ZZSMART02');
DELETE FROM dbo.tbl_med_mcc_patient_samples     WHERE vailid IN (N'ZZSMART01', N'ZZSMART02');
DELETE FROM dbo.telo_custom_test_order          WHERE patient_id IN (SELECT pid FROM @pids);
DELETE FROM dbo.tbl_med_mcc_patient_master      WHERE id IN (SELECT pid FROM @pids);

COMMIT;

SELECT removed_patients = (SELECT COUNT(*) FROM @pids);
GO
