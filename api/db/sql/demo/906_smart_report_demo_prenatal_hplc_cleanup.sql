SET QUOTED_IDENTIFIER ON;
GO
/*
 * 906_smart_report_demo_prenatal_hplc_cleanup.sql — removes what 905 created.
 *
 * Deletes only rows that demo wrote: the ZZTEST01 (mcc 6094) patients added
 * by inf:demo-pn, their order lines, tubes, results and SMART-RPT entitlement.
 */
SET NOCOUNT ON;
SET XACT_ABORT ON;

BEGIN TRAN;

DECLARE @pids TABLE (pid INT);
INSERT INTO @pids (pid)
SELECT id FROM dbo.tbl_med_mcc_patient_master WHERE mcc_code = 6094 AND addedby = N'inf:demo-pn';

DELETE FROM dbo.tbl_med_mcc_patient_test_result WHERE vailid IN (SELECT vailid FROM dbo.tbl_med_mcc_patient_samples WHERE patient_id IN (SELECT pid FROM @pids));
DELETE FROM dbo.tbl_med_mcc_patient_samples     WHERE patient_id IN (SELECT pid FROM @pids);
DELETE FROM dbo.telo_custom_test_order          WHERE patient_id IN (SELECT pid FROM @pids);
DELETE FROM dbo.tbl_med_mcc_patient_tests       WHERE patient_id IN (SELECT pid FROM @pids);
DELETE FROM dbo.tbl_med_mcc_patient_master      WHERE id IN (SELECT pid FROM @pids);

COMMIT;

SELECT removed_patients = (SELECT COUNT(*) FROM @pids);
GO
