/*
 * zztest01-mini-line-check-cleanup-20260923.sql
 *
 * Removes the proof booking made on the ZZTEST01 throwaway centre (unit
 * 6094) on 2026-09-23 while verifying the Smart Report mini bill line and
 * the B2B Sample-ID rule: patient 'ZZ Mini Line Check', bill 26090005
 * (id 33638), one CBC tube (SID 99236896390, never received) and the
 * SMART-MINI custom line. Its clinical-history round trip left nothing.
 *
 * Scoped by centre AND patient name AND date, so it cannot reach the demo
 * booklet patients of api/db/sql/demo/903 (inf:demo-hp) or anything else
 * on the centre. Every deleted row is copied first into the same
 * dbo.inf_zztest01_backup_* tables the 2026-09-09 cleanup used, so it can
 * be put back — into date-suffixed tables (inf_zztest01_backup_*_20260923),
 * because the shared backup tables carry an identity column that a plain
 * INSERT ... SELECT * cannot fill. Idempotent: a second run finds nothing.
 *
 * The centre's account balance is NOT touched here: a client order debits
 * the wallet only at accessioning, and these samples were never received.
 * Check the last SELECT — if currentbalance moved, reset it as the
 * 2026-09-09 script did.
 */
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @mcc INT = 6094;
DECLARE @name NVARCHAR(200) = N'ZZ Mini Line Check';
DECLARE @day DATE = '2026-09-23';

BEGIN TRANSACTION;

SELECT id INTO #pat
FROM dbo.tbl_med_mcc_patient_master
WHERE mcc_code = @mcc AND name = @name AND CAST(sample_time AS DATE) >= @day;

SELECT s.id, s.vailid INTO #smp
FROM dbo.tbl_med_mcc_patient_samples s WHERE s.patient_id IN (SELECT id FROM #pat);

SELECT b.id INTO #bill
FROM dbo.tbl_billing_patient_detail b
WHERE b.mcc_code = @mcc AND b.patientname = @name AND CAST(b.bill_date AS DATE) >= @day;

DECLARE @found NVARCHAR(200);
SELECT @found = CONCAT('patients: ', (SELECT COUNT(*) FROM #pat), '  samples: ', (SELECT COUNT(*) FROM #smp), '  bills: ', (SELECT COUNT(*) FROM #bill));
PRINT @found;

-- Backups (created on first run; appended to on a later run that finds rows).
IF OBJECT_ID('dbo.inf_zztest01_backup_results_20260923') IS NULL
    SELECT * INTO dbo.inf_zztest01_backup_results_20260923 FROM dbo.tbl_med_mcc_patient_test_result WHERE vailid IN (SELECT vailid FROM #smp);

IF OBJECT_ID('dbo.inf_zztest01_backup_samples_20260923') IS NULL
    SELECT * INTO dbo.inf_zztest01_backup_samples_20260923 FROM dbo.tbl_med_mcc_patient_samples WHERE id IN (SELECT id FROM #smp);

IF OBJECT_ID('dbo.inf_zztest01_backup_bill_lines_20260923') IS NULL
    SELECT * INTO dbo.inf_zztest01_backup_bill_lines_20260923 FROM dbo.tbl_billing_patient_test_detail WHERE billid IN (SELECT id FROM #bill);

IF OBJECT_ID('dbo.inf_zztest01_backup_custom_lines_20260923') IS NULL
    SELECT * INTO dbo.inf_zztest01_backup_custom_lines_20260923 FROM dbo.telo_custom_test_order WHERE patient_id IN (SELECT id FROM #pat);

IF OBJECT_ID('dbo.inf_zztest01_backup_order_kind_20260923') IS NULL
    SELECT * INTO dbo.inf_zztest01_backup_order_kind_20260923 FROM dbo.telo_order_kind WHERE bill_id IN (SELECT id FROM #bill);

IF OBJECT_ID('dbo.inf_zztest01_backup_bills_20260923') IS NULL
    SELECT * INTO dbo.inf_zztest01_backup_bills_20260923 FROM dbo.tbl_billing_patient_detail WHERE id IN (SELECT id FROM #bill);

IF OBJECT_ID('dbo.inf_zztest01_backup_wallet_20260923') IS NULL
    SELECT * INTO dbo.inf_zztest01_backup_wallet_20260923 FROM dbo.tbl_med_mcc_test_transactions WHERE mccid = @mcc AND patientid IN (SELECT id FROM #pat);

IF OBJECT_ID('dbo.inf_zztest01_backup_patient_tests_20260923') IS NULL
    SELECT * INTO dbo.inf_zztest01_backup_patient_tests_20260923 FROM dbo.tbl_med_mcc_patient_tests WHERE patient_id IN (SELECT id FROM #pat);

IF OBJECT_ID('dbo.inf_zztest01_backup_patient_billing_20260923') IS NULL
    SELECT * INTO dbo.inf_zztest01_backup_patient_billing_20260923 FROM dbo.tbl_med_mcc_patient_billing WHERE patientid IN (SELECT id FROM #pat);

IF OBJECT_ID('dbo.inf_zztest01_backup_clinicaldata_20260923') IS NULL
    SELECT * INTO dbo.inf_zztest01_backup_clinicaldata_20260923 FROM dbo.tbl_med_mcc_patient_clinicaldata WHERE patient_id IN (SELECT id FROM #pat);

IF OBJECT_ID('dbo.inf_zztest01_backup_patients_20260923') IS NULL
    SELECT * INTO dbo.inf_zztest01_backup_patients_20260923 FROM dbo.tbl_med_mcc_patient_master WHERE id IN (SELECT id FROM #pat);

-- Deletes, children first.
DELETE FROM dbo.tbl_med_mcc_patient_test_result WHERE vailid IN (SELECT vailid FROM #smp);
PRINT CONCAT('results deleted: ', @@ROWCOUNT);
DELETE FROM dbo.tbl_med_mcc_patient_samples WHERE id IN (SELECT id FROM #smp);
PRINT CONCAT('samples deleted: ', @@ROWCOUNT);
DELETE FROM dbo.tbl_billing_patient_test_detail WHERE billid IN (SELECT id FROM #bill);
PRINT CONCAT('bill lines deleted: ', @@ROWCOUNT);
DELETE FROM dbo.telo_custom_test_order WHERE patient_id IN (SELECT id FROM #pat);
PRINT CONCAT('custom lines deleted: ', @@ROWCOUNT);
DELETE FROM dbo.telo_order_kind WHERE bill_id IN (SELECT id FROM #bill);
PRINT CONCAT('order kinds deleted: ', @@ROWCOUNT);
DELETE FROM dbo.tbl_billing_patient_detail WHERE id IN (SELECT id FROM #bill);
PRINT CONCAT('bills deleted: ', @@ROWCOUNT);
DELETE FROM dbo.tbl_med_mcc_test_transactions WHERE mccid = @mcc AND patientid IN (SELECT id FROM #pat);
PRINT CONCAT('wallet rows deleted: ', @@ROWCOUNT);
DELETE FROM dbo.tbl_med_mcc_patient_tests WHERE patient_id IN (SELECT id FROM #pat);
PRINT CONCAT('patient tests deleted: ', @@ROWCOUNT);
DELETE FROM dbo.tbl_med_mcc_patient_billing WHERE patientid IN (SELECT id FROM #pat);
PRINT CONCAT('patient billing links deleted: ', @@ROWCOUNT);
DELETE FROM dbo.tbl_med_mcc_patient_clinicaldata WHERE patient_id IN (SELECT id FROM #pat);
PRINT CONCAT('clinical data rows deleted: ', @@ROWCOUNT);
DELETE FROM dbo.tbl_med_mcc_patient_master WHERE id IN (SELECT id FROM #pat);
PRINT CONCAT('patients deleted: ', @@ROWCOUNT);

COMMIT TRANSACTION;

-- What is left on the centre, and whether the wallet moved.
SELECT (SELECT COUNT(*) FROM dbo.tbl_med_mcc_patient_master WHERE mcc_code = @mcc) AS patients,
       (SELECT COUNT(*) FROM dbo.tbl_billing_patient_detail WHERE mcc_code = @mcc) AS bills,
       (SELECT COUNT(*) FROM dbo.tbl_med_mcc_test_transactions WHERE mccid = @mcc) AS wallet_rows;
SELECT mcccode, totaldeposited, currentbalance FROM dbo.tbl_med_mcc_account_master WHERE mcccode = @mcc;
