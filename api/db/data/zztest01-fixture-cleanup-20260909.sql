/*
 * zztest01-fixture-cleanup-20260909.sql
 *
 * Removes the throwaway bookings made on the ZZTEST01 test centre (unit
 * 6094) for verifying the Smart Report (2026-09-06) and the printed-status
 * port (2026-09-09), so the centre's ledger carries nothing: 11 patients,
 * 11 bills (26090001–26090011) with their lines, 11 Smart Report custom
 * lines, 11 wallet debits, 41 samples (9990001–9990004, 9995001–9995037) and
 * their 964 result rows. The account master goes back to 0 deposited / 0
 * balance (the ₹10,000 advance was set on the master directly; no deposit
 * detail row exists).
 *
 * Kept on purpose: the centre itself and its login (ZZTEST01, user 7214) for
 * further checks; the audit rows (inf_result_audit is append-only by
 * trigger, inf_audit_log is the record of what was tested) — they name SIDs
 * that no longer exist, which is what an audit of a deleted fixture should
 * say.
 *
 * Every deleted row is copied first into dbo.inf_zztest01_backup_<table>, so
 * the whole thing can be put back. Idempotent: a second run finds nothing.
 */
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @mcc INT = 6094;

BEGIN TRANSACTION;

-- The keys, resolved once.
SELECT id INTO #pat FROM dbo.tbl_med_mcc_patient_master WHERE mcc_code = @mcc;
SELECT s.id, s.vailid INTO #smp FROM dbo.tbl_med_mcc_patient_samples s WHERE s.patient_id IN (SELECT id FROM #pat);
SELECT id INTO #bill FROM dbo.tbl_billing_patient_detail WHERE mcc_code = @mcc;

-- Backups (created on first run; appended to on a re-run that finds rows).
IF OBJECT_ID('dbo.inf_zztest01_backup_results') IS NULL
    SELECT * INTO dbo.inf_zztest01_backup_results FROM dbo.tbl_med_mcc_patient_test_result WHERE vailid IN (SELECT vailid FROM #smp);
ELSE
    INSERT INTO dbo.inf_zztest01_backup_results SELECT * FROM dbo.tbl_med_mcc_patient_test_result WHERE vailid IN (SELECT vailid FROM #smp);

IF OBJECT_ID('dbo.inf_zztest01_backup_samples') IS NULL
    SELECT * INTO dbo.inf_zztest01_backup_samples FROM dbo.tbl_med_mcc_patient_samples WHERE id IN (SELECT id FROM #smp);
ELSE
    INSERT INTO dbo.inf_zztest01_backup_samples SELECT * FROM dbo.tbl_med_mcc_patient_samples WHERE id IN (SELECT id FROM #smp);

IF OBJECT_ID('dbo.inf_zztest01_backup_bill_lines') IS NULL
    SELECT * INTO dbo.inf_zztest01_backup_bill_lines FROM dbo.tbl_billing_patient_test_detail WHERE billid IN (SELECT id FROM #bill);
ELSE
    INSERT INTO dbo.inf_zztest01_backup_bill_lines SELECT * FROM dbo.tbl_billing_patient_test_detail WHERE billid IN (SELECT id FROM #bill);

IF OBJECT_ID('dbo.inf_zztest01_backup_custom_lines') IS NULL
    SELECT * INTO dbo.inf_zztest01_backup_custom_lines FROM dbo.telo_custom_test_order WHERE bill_id IN (SELECT id FROM #bill);
ELSE
    INSERT INTO dbo.inf_zztest01_backup_custom_lines SELECT * FROM dbo.telo_custom_test_order WHERE bill_id IN (SELECT id FROM #bill);

IF OBJECT_ID('dbo.inf_zztest01_backup_order_kind') IS NULL
    SELECT * INTO dbo.inf_zztest01_backup_order_kind FROM dbo.telo_order_kind WHERE bill_id IN (SELECT id FROM #bill);
ELSE
    INSERT INTO dbo.inf_zztest01_backup_order_kind SELECT * FROM dbo.telo_order_kind WHERE bill_id IN (SELECT id FROM #bill);

IF OBJECT_ID('dbo.inf_zztest01_backup_bills') IS NULL
    SELECT * INTO dbo.inf_zztest01_backup_bills FROM dbo.tbl_billing_patient_detail WHERE id IN (SELECT id FROM #bill);
ELSE
    INSERT INTO dbo.inf_zztest01_backup_bills SELECT * FROM dbo.tbl_billing_patient_detail WHERE id IN (SELECT id FROM #bill);

IF OBJECT_ID('dbo.inf_zztest01_backup_wallet') IS NULL
    SELECT * INTO dbo.inf_zztest01_backup_wallet FROM dbo.tbl_med_mcc_test_transactions WHERE mccid = @mcc;
ELSE
    INSERT INTO dbo.inf_zztest01_backup_wallet SELECT * FROM dbo.tbl_med_mcc_test_transactions WHERE mccid = @mcc;

-- The patient's booked tests, billing link and clinical data: children of
-- the patient row by foreign key (the first run rolled back on the first).
IF OBJECT_ID('dbo.inf_zztest01_backup_patient_tests') IS NULL
    SELECT * INTO dbo.inf_zztest01_backup_patient_tests FROM dbo.tbl_med_mcc_patient_tests WHERE patient_id IN (SELECT id FROM #pat);
ELSE
    INSERT INTO dbo.inf_zztest01_backup_patient_tests SELECT * FROM dbo.tbl_med_mcc_patient_tests WHERE patient_id IN (SELECT id FROM #pat);

IF OBJECT_ID('dbo.inf_zztest01_backup_patient_billing') IS NULL
    SELECT * INTO dbo.inf_zztest01_backup_patient_billing FROM dbo.tbl_med_mcc_patient_billing WHERE patientid IN (SELECT id FROM #pat);
ELSE
    INSERT INTO dbo.inf_zztest01_backup_patient_billing SELECT * FROM dbo.tbl_med_mcc_patient_billing WHERE patientid IN (SELECT id FROM #pat);

IF OBJECT_ID('dbo.inf_zztest01_backup_clinicaldata') IS NULL
    SELECT * INTO dbo.inf_zztest01_backup_clinicaldata FROM dbo.tbl_med_mcc_patient_clinicaldata WHERE patient_id IN (SELECT id FROM #pat);
ELSE
    INSERT INTO dbo.inf_zztest01_backup_clinicaldata SELECT * FROM dbo.tbl_med_mcc_patient_clinicaldata WHERE patient_id IN (SELECT id FROM #pat);

IF OBJECT_ID('dbo.inf_zztest01_backup_patients') IS NULL
    SELECT * INTO dbo.inf_zztest01_backup_patients FROM dbo.tbl_med_mcc_patient_master WHERE id IN (SELECT id FROM #pat);
ELSE
    INSERT INTO dbo.inf_zztest01_backup_patients SELECT * FROM dbo.tbl_med_mcc_patient_master WHERE id IN (SELECT id FROM #pat);

IF OBJECT_ID('dbo.inf_zztest01_backup_account') IS NULL
    SELECT * INTO dbo.inf_zztest01_backup_account FROM dbo.tbl_med_mcc_account_master WHERE mcccode = @mcc;

-- Deletes, children first.
DELETE FROM dbo.tbl_med_mcc_patient_test_result WHERE vailid IN (SELECT vailid FROM #smp);
PRINT CONCAT('results deleted: ', @@ROWCOUNT);
DELETE FROM dbo.tbl_med_mcc_patient_samples WHERE id IN (SELECT id FROM #smp);
PRINT CONCAT('samples deleted: ', @@ROWCOUNT);
DELETE FROM dbo.tbl_billing_patient_test_detail WHERE billid IN (SELECT id FROM #bill);
PRINT CONCAT('bill lines deleted: ', @@ROWCOUNT);
DELETE FROM dbo.telo_custom_test_order WHERE bill_id IN (SELECT id FROM #bill);
PRINT CONCAT('custom lines deleted: ', @@ROWCOUNT);
DELETE FROM dbo.telo_order_kind WHERE bill_id IN (SELECT id FROM #bill);
PRINT CONCAT('order kinds deleted: ', @@ROWCOUNT);
DELETE FROM dbo.tbl_billing_patient_detail WHERE id IN (SELECT id FROM #bill);
PRINT CONCAT('bills deleted: ', @@ROWCOUNT);
DELETE FROM dbo.tbl_med_mcc_test_transactions WHERE mccid = @mcc;
PRINT CONCAT('wallet debits deleted: ', @@ROWCOUNT);
DELETE FROM dbo.tbl_med_mcc_patient_tests WHERE patient_id IN (SELECT id FROM #pat);
PRINT CONCAT('patient tests deleted: ', @@ROWCOUNT);
DELETE FROM dbo.tbl_med_mcc_patient_billing WHERE patientid IN (SELECT id FROM #pat);
PRINT CONCAT('patient billing links deleted: ', @@ROWCOUNT);
DELETE FROM dbo.tbl_med_mcc_patient_clinicaldata WHERE patient_id IN (SELECT id FROM #pat);
PRINT CONCAT('clinical data rows deleted: ', @@ROWCOUNT);
DELETE FROM dbo.tbl_med_mcc_patient_master WHERE id IN (SELECT id FROM #pat);
PRINT CONCAT('patients deleted: ', @@ROWCOUNT);

UPDATE dbo.tbl_med_mcc_account_master
   SET totaldeposited = 0, currentbalance = 0,
       lastupdatedby = N'inf:jas', lastupdateddate = GETDATE()
 WHERE mcccode = @mcc;
PRINT CONCAT('account reset: ', @@ROWCOUNT);

COMMIT TRANSACTION;

-- What is left on the centre.
SELECT (SELECT COUNT(*) FROM dbo.tbl_med_mcc_patient_master WHERE mcc_code = @mcc) AS patients,
       (SELECT COUNT(*) FROM dbo.tbl_billing_patient_detail WHERE mcc_code = @mcc) AS bills,
       (SELECT COUNT(*) FROM dbo.tbl_med_mcc_test_transactions WHERE mccid = @mcc) AS wallet_rows,
       (SELECT COUNT(*) FROM dbo.tbl_med_mcc_patient_samples WHERE vailid LIKE '999%' AND patient_id IN (SELECT id FROM dbo.inf_zztest01_backup_patients)) AS samples_left;
SELECT mcccode, totaldeposited, currentbalance FROM dbo.tbl_med_mcc_account_master WHERE mcccode = @mcc;
