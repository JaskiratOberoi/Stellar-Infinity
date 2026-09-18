SET QUOTED_IDENTIFIER ON;
GO
/*
 * zztest01-smart-fixture-male-20260918.sql — a Smart Report test order on the
 * lab's throwaway centre ZZTEST01 (mcc 6094), for reviewing booklet format v2.
 *
 * Modelled on api/db/sql/demo/901_smart_report_demo.sql, and written directly
 * for the same reason: ZZTEST01 has no rate list, so usp_telo_create_order
 * will not bill it, and defeating that check for a fixture is not worth it.
 * No bill is pretended into existence (bill_id 0 on the SMART-RPT line, as
 * the demo does). ZZTEST01 is permanently unlocked, so the report opens.
 *
 * The lab's rule since 2026-09-18: test orders go on ZZTEST only, never on a
 * live client code — a patient on a live code can reach the portal and would
 * download a booklet they did not pay for.
 *
 * The MALE counterpart of ZZSMART01 (gender 1, 46): one patient, one SID (ZZSMART02), twenty authorised results spread across
 * every booklet chapter the body map draws — blood, heart, blood sugar,
 * liver, kidney, thyroid, vitamins, urine, immunity, hormones — with a mix of
 * healthy and flagged readings so the map shows both states.
 *
 * Re-runnable: it clears its own previous rows first. Remove it with
 * the cleanup script beside it.
 */
SET NOCOUNT ON;
SET XACT_ABORT ON;

BEGIN TRAN;

DECLARE @mcc INT = 6094;
DECLARE @sid NVARCHAR(100) = N'ZZSMART02';
DECLARE @who NVARCHAR(50) = N'inf:jas';

DECLARE @old TABLE (pid INT);
INSERT INTO @old (pid)
SELECT id FROM dbo.tbl_med_mcc_patient_master WHERE mcc_code = @mcc AND name = N'ZZ TEST SMART V2 MALE';

DELETE FROM dbo.tbl_med_mcc_patient_test_result WHERE vailid = @sid;
DELETE FROM dbo.tbl_med_mcc_patient_samples     WHERE vailid = @sid;
DELETE FROM dbo.telo_custom_test_order          WHERE patient_id IN (SELECT pid FROM @old);
DELETE FROM dbo.tbl_med_mcc_patient_master      WHERE id IN (SELECT pid FROM @old);

INSERT INTO dbo.tbl_med_mcc_patient_master (name, mcc_code, gender, age, age_type, sample_time, addedby)
VALUES (N'ZZ TEST SMART V2 MALE', @mcc, 1, 46, 1, GETDATE(), @who);

DECLARE @pid INT = SCOPE_IDENTITY();

-- status 7 = Authorized, which is what the reporting list treats as releasable.
INSERT INTO dbo.tbl_med_mcc_patient_samples
    (vailid, patient_id, sample_status, modifieddate, lastmodified_date, business_unit_id, testnames, Sample_ClinicalHistory)
VALUES
    (@sid, @pid, 7, DATEADD(HOUR, -6, GETDATE()), DATEADD(HOUR, -1, GETDATE()), 1,
     N'CBC, Lipids, HbA1c, Glucose, LFT, KFT, TSH, Vitamins, Urine, CRP, Prolactin',
     N'Test sample for the Smart Report format v2 review.');

-- Real catalogue ids and names throughout (the enzymes are 79 BI014 and
-- 81 BI040 — "SGPT" alone matches nothing in the catalogue, and "SGOT%"
-- matches the ratio test, so they are pinned rather than looked up).
DECLARE @sgpt INT = 79;
DECLARE @sgot INT = 81;
DECLARE @sgptCode NVARCHAR(50) = N'BI014';
DECLARE @sgotCode NVARCHAR(50) = N'BI040';

-- auth = 1 throughout: the booklet withholds anything the lab has not signed out.
-- patientid is REQUIRED (the 901 demo left it null): usp_inf_report_extras
-- reaches the signing doctors through result.patientid → patient → centre →
-- business unit, and a result with no patient resolves to no signatory, which
-- the booklet refuses to issue.
INSERT INTO dbo.tbl_med_mcc_patient_test_result
    (vailid, patientid, testid, testcode, testname, testtype, value, testunit, testnormal_range, abnormal, auth, updateddate, addedby)
SELECT @sid, @pid, testid, testcode, testname, N'Test', value, testunit, testnormal_range, abnormal, 1, GETDATE(), @who
FROM (VALUES
    (233, N'HE011', N'Hemoglobin', N'12.4', N'g/dL', N'13.0 - 17.0', 1),
    (233, N'HE011', N'Platelet Count', N'235', N'10^3/µL', N'150 - 450', 0),
    (233, N'HE011', N'Total Leukocyte Count', N'7.46', N'x1000/µL', N'4.0 - 11.0', 0),
    (104, N'BI079', N'Cholesterol - Total', N'188', N'mg/dL', N'Desirable < 200', 0),
    (102, N'BI077', N'Cholesterol - HDL', N'58', N'mg/dL', N'> 40', 0),
    (103, N'BI078', N'Cholesterol - LDL', N'96', N'mg/dL', N'Optimal < 100', 0),
    (168, N'BI218', N'Triglycerides', N'132', N'mg/dL', N'Normal < 150', 0),
    (291, N'BI127', N'Glycated Hemoglobin (HBA1c)', N'6.4', N'%', N'4.0 - 5.6', 1),
    (284, N'BI114', N'Glucose - Fasting', N'126', N'mg/dL', N'74 - 110', 1),
    (@sgpt, @sgptCode, N'Alanine amino Transferase - (ALT / SGPT)', N'31', N'U/L', N'< 45', 0),
    (@sgot, @sgotCode, N'Aspartate Aminotransferase (AST/SGOT)', N'30', N'U/L', N'< 40', 0),
    (89, N'BI048', N'Bilirubin Total', N'0.7', N'mg/dL', N'0.2 - 1.2', 0),
    (114, N'BI089', N'Creatinine', N'1.4', N'mg/dL', N'0.7 - 1.3', 1),
    (172, N'BI224', N'Urea', N'26', N'mg/dL', N'15 - 40', 0),
    (170, N'BI221', N'Thyroid Stimulating Hormone (TSH)', N'2.10', N'uIU/ml', N'0.35 - 5.50', 0),
    (175, N'BI235', N'Vitamin B12', N'410', N'pg/ml', N'180 - 914', 0),
    (74, N'BI005', N'VITAMIN D', N'14', N'ng/mL', N'30 - 100', 1),
    (34, N'CP004', N'Urine pH', N'6.0', N'', N'4.5 - 8.0', 0),
    (113, N'MS024', N'C-Reactive Protein (CRP)', N'9.8', N'mg/L', N'< 5', 1),
    (150, N'BI180', N'Prolactin', N'14', N'ng/mL', N'4 - 23', 0)
) v (testid, testcode, testname, value, testunit, testnormal_range, abnormal);

-- The paid extra. THIS row is what entitles the patient to the booklet — see
-- SmartReportAccessRepository. bill_id 0: no bill exists for a fixture that
-- never went through billing, and the column carries no foreign key.
INSERT INTO dbo.telo_custom_test_order
    (bill_id, patient_id, custom_test_id, code, name, unit_amount, qty, mcc_code, created_by)
VALUES
    (0, @pid, 3, N'SMART-RPT', N'Smart Report', 99, 1, @mcc, @who);

COMMIT;

SELECT fixture_sid = @sid, fixture_pid = @pid, sgpt_id = @sgpt, sgot_id = @sgot,
       results = (SELECT COUNT(*) FROM dbo.tbl_med_mcc_patient_test_result WHERE vailid = @sid),
       flagged = (SELECT COUNT(*) FROM dbo.tbl_med_mcc_patient_test_result WHERE vailid = @sid AND abnormal = 1);
GO
