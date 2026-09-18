SET QUOTED_IDENTIFIER ON;
GO
/*
 * zztest01-smart-fixture-cleanup-20260918.sql — removes what the fixture wrote.
 *
 * Deletes only the ZZTEST01 patient named 'ZZ TEST SMART V2', its sample
 * ZZSMART01, its results and its SMART-RPT entitlement. Matched on the patient
 * and the SID, so it cannot reach anything else on the centre.
 */
SET NOCOUNT ON;
SET XACT_ABORT ON;

BEGIN TRAN;

DECLARE @pids TABLE (pid INT);
INSERT INTO @pids (pid)
SELECT id FROM dbo.tbl_med_mcc_patient_master WHERE mcc_code = 6094 AND name = N'ZZ TEST SMART V2';

DELETE FROM dbo.tbl_med_mcc_patient_test_result WHERE vailid = N'ZZSMART01';
DELETE FROM dbo.tbl_med_mcc_patient_samples     WHERE vailid = N'ZZSMART01';
DELETE FROM dbo.telo_custom_test_order          WHERE patient_id IN (SELECT pid FROM @pids);
DELETE FROM dbo.tbl_med_mcc_patient_master      WHERE id IN (SELECT pid FROM @pids);

COMMIT;

SELECT removed_patients = (SELECT COUNT(*) FROM @pids);
GO
