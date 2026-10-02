/*
 * abc-test-order-cleanup-20261002.sql
 *
 * Removes ONE test order Jas placed on client ABC (unit 1) on 2026-10-02
 * 12:45 through Infinity (addedby inf:184) to test the Smart Report:
 *   patient 3748143 "Mr Test", bill 34821 (26100001), SID 234582360
 *   (CBES1, registered), one SMART-RPT line charged at Rs 49.
 * Everything the order left is removed — including the two wallet debits
 * (Rs 70 for the test at accession, Rs 49 for the Smart Report), so ABC's
 * account balance is restored — except the user activity log row, which is
 * audit and stays. Every row is copied to inf_abc_backup_*_20261002 first.
 * Guarded on the exact ids and on the order still being what it was.
 */
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @pid INT = 3748143, @bill INT = 34821, @sid NVARCHAR(50) = N'234582360', @mcc INT = 1;

IF NOT EXISTS (SELECT 1 FROM dbo.tbl_med_mcc_patient_master WHERE id = @pid AND mcc_code = @mcc AND name = N'Test' AND addedby = N'inf:184')
    THROW 50000, 'Patient 3748143 is not the ABC test order; stop.', 1;
IF NOT EXISTS (SELECT 1 FROM dbo.tbl_billing_patient_detail WHERE id = @bill AND medid = CAST(@pid AS VARCHAR(20)) AND mcc_code = @mcc)
    THROW 50000, 'Bill 34821 does not belong to patient 3748143; stop.', 1;

/* ---- backups ---- */
IF OBJECT_ID('dbo.inf_abc_backup_patient_20261002') IS NULL
    SELECT * INTO dbo.inf_abc_backup_patient_20261002 FROM dbo.tbl_med_mcc_patient_master WHERE id = @pid;
IF OBJECT_ID('dbo.inf_abc_backup_samples_20261002') IS NULL
    SELECT * INTO dbo.inf_abc_backup_samples_20261002 FROM dbo.tbl_med_mcc_patient_samples WHERE patient_id = @pid;
IF OBJECT_ID('dbo.inf_abc_backup_tests_20261002') IS NULL
    SELECT * INTO dbo.inf_abc_backup_tests_20261002 FROM dbo.tbl_med_mcc_patient_tests WHERE patient_id = @pid;
IF OBJECT_ID('dbo.inf_abc_backup_results_20261002') IS NULL
    SELECT * INTO dbo.inf_abc_backup_results_20261002 FROM dbo.tbl_med_mcc_patient_test_result WHERE vailid = @sid;
IF OBJECT_ID('dbo.inf_abc_backup_custom_order_20261002') IS NULL
    SELECT * INTO dbo.inf_abc_backup_custom_order_20261002 FROM dbo.telo_custom_test_order WHERE patient_id = @pid;
IF OBJECT_ID('dbo.inf_abc_backup_custom_charge_20261002') IS NULL
    SELECT * INTO dbo.inf_abc_backup_custom_charge_20261002 FROM dbo.telo_custom_line_charge WHERE bill_id = @bill;
IF OBJECT_ID('dbo.inf_abc_backup_transactions_20261002') IS NULL
    SELECT * INTO dbo.inf_abc_backup_transactions_20261002 FROM dbo.tbl_med_mcc_test_transactions WHERE patientid = @pid AND mccid = @mcc;
IF OBJECT_ID('dbo.inf_abc_backup_bill_20261002') IS NULL
    SELECT * INTO dbo.inf_abc_backup_bill_20261002 FROM dbo.tbl_billing_patient_detail WHERE id = @bill;
IF OBJECT_ID('dbo.inf_abc_backup_bill_tests_20261002') IS NULL
    SELECT * INTO dbo.inf_abc_backup_bill_tests_20261002 FROM dbo.tbl_billing_patient_test_detail WHERE billid = @bill;
IF OBJECT_ID('dbo.inf_abc_backup_order_kind_20261002') IS NULL
    SELECT * INTO dbo.inf_abc_backup_order_kind_20261002 FROM dbo.telo_order_kind WHERE bill_id = @bill;

/* ---- the order ---- */
BEGIN TRANSACTION;

DELETE FROM dbo.telo_custom_line_charge          WHERE bill_id = @bill;
PRINT CONCAT('custom line charges: ', @@ROWCOUNT);
DELETE FROM dbo.telo_custom_test_order           WHERE patient_id = @pid AND bill_id = @bill;
PRINT CONCAT('custom lines: ', @@ROWCOUNT);
DELETE FROM dbo.tbl_med_mcc_test_transactions    WHERE patientid = @pid AND mccid = @mcc;
PRINT CONCAT('wallet debits: ', @@ROWCOUNT);
DELETE FROM dbo.tbl_med_mcc_patient_test_result  WHERE vailid = @sid;
PRINT CONCAT('results: ', @@ROWCOUNT);
DELETE FROM dbo.tbl_med_mcc_patient_samples      WHERE patient_id = @pid AND vailid = @sid;
PRINT CONCAT('samples: ', @@ROWCOUNT);
DELETE FROM dbo.tbl_med_mcc_patient_tests        WHERE patient_id = @pid;
PRINT CONCAT('tests: ', @@ROWCOUNT);
DELETE FROM dbo.telo_order_kind                  WHERE bill_id = @bill;
PRINT CONCAT('order kind: ', @@ROWCOUNT);
DELETE FROM dbo.tbl_billing_patient_test_detail  WHERE billid = @bill;
PRINT CONCAT('bill lines: ', @@ROWCOUNT);
DELETE FROM dbo.tbl_billing_patient_detail       WHERE id = @bill;
PRINT CONCAT('bill: ', @@ROWCOUNT);
DELETE FROM dbo.tbl_med_mcc_patient_master       WHERE id = @pid;
PRINT CONCAT('patient: ', @@ROWCOUNT);

COMMIT TRANSACTION;

SELECT (SELECT COUNT(*) FROM dbo.tbl_med_mcc_patient_master WHERE id = @pid) patient_left,
       (SELECT COUNT(*) FROM dbo.tbl_med_mcc_patient_samples WHERE vailid = @sid) sample_left,
       (SELECT COUNT(*) FROM dbo.tbl_billing_patient_detail WHERE id = @bill) bill_left,
       (SELECT COUNT(*) FROM dbo.tbl_med_mcc_test_transactions WHERE patientid = @pid) debits_left;
