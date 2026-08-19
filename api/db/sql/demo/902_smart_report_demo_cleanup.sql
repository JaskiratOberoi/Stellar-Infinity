SET QUOTED_IDENTIFIER ON;
GO
/*
 * 902_smart_report_demo_cleanup.sql — removes what 901 created.
 *
 * Deletes only rows this demo wrote: the ABC patient named 'DEMO SMART REPORT',
 * its sample, its results and its SMART-RPT entitlement. Matched on the patient
 * and the SID rather than on addedby alone, so it cannot reach anything else.
 *
 * It does NOT re-lock ABC. The demo released that client through
 * usp_inf_set_client_unlock, and taking a release away is its own decision with
 * its own audit row — do it from the Client Accounts screen, or by calling that
 * procedure with @unlocked = 0, so the reason is recorded either way.
 */
SET NOCOUNT ON;
SET XACT_ABORT ON;

BEGIN TRAN;

DECLARE @pids TABLE (pid INT);
INSERT INTO @pids (pid)
SELECT id FROM dbo.tbl_med_mcc_patient_master
WHERE mcc_code = 1 AND name = N'DEMO SMART REPORT';

DELETE FROM dbo.tbl_med_mcc_patient_test_result WHERE vailid = N'DEMOSMART1';
DELETE FROM dbo.tbl_med_mcc_patient_samples     WHERE vailid = N'DEMOSMART1';
DELETE FROM dbo.telo_custom_test_order          WHERE patient_id IN (SELECT pid FROM @pids);
DELETE FROM dbo.tbl_med_mcc_patient_master      WHERE id IN (SELECT pid FROM @pids);

COMMIT;

SELECT removed_patients = (SELECT COUNT(*) FROM @pids);
GO
