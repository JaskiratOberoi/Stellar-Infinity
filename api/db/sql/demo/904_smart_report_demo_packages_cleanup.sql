SET QUOTED_IDENTIFIER ON;
GO
/*
 * 904_smart_report_demo_packages_cleanup.sql — removes what 903 created.
 *
 * Deletes only rows that demo wrote: the ZZTEST01 (mcc 6094) patients added
 * by inf:demo-hp, their order lines, tubes, results and SMART-RPT entitlement.
 * Matched on the centre AND the writer, so it cannot reach anything else
 * booked on that centre by a person.
 */
SET NOCOUNT ON;
SET XACT_ABORT ON;

BEGIN TRAN;

DECLARE @pids TABLE (pid INT);
INSERT INTO @pids (pid)
SELECT id FROM dbo.tbl_med_mcc_patient_master WHERE mcc_code = 6094 AND addedby = N'inf:demo-hp';

DELETE FROM dbo.tbl_med_mcc_patient_test_result WHERE vailid IN (SELECT vailid FROM dbo.tbl_med_mcc_patient_samples WHERE patient_id IN (SELECT pid FROM @pids));
DELETE FROM dbo.tbl_med_mcc_patient_samples     WHERE patient_id IN (SELECT pid FROM @pids);
DELETE FROM dbo.telo_custom_test_order          WHERE patient_id IN (SELECT pid FROM @pids);
DELETE FROM dbo.tbl_med_mcc_patient_tests       WHERE patient_id IN (SELECT pid FROM @pids);
DELETE FROM dbo.tbl_med_mcc_patient_master      WHERE id IN (SELECT pid FROM @pids);

COMMIT;

SELECT removed_patients = (SELECT COUNT(*) FROM @pids);
GO
