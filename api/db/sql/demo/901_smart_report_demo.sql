SET QUOTED_IDENTIFIER ON;
GO
/*
 * 901_smart_report_demo.sql — DEMO DATA. Not part of the schema.
 *
 * One sample under the ABC testing client (mcc 1) so the Smart Report booklet
 * can be opened and looked at. Numbered 900+ and kept in its own folder so it
 * is never picked up by a "run every file" deploy of the real migrations.
 *
 * ── WHY THE ROWS ARE WRITTEN DIRECTLY ─────────────────────────────────────
 * The honest route is an order through dbo.usp_telo_create_order, and that was
 * tried first. It refused the basket, correctly: ABC is an inactive testing
 * client with no rate list, and the procedure will not bill unpriced items.
 * Defeating that check for a demo would mean weakening the one thing standing
 * between a mis-configured client and a wrong bill, so the sample is written
 * directly instead and no bill is pretended into existence.
 *
 * Nothing here touches a real client. ABC is the lab's own testing code —
 * inactive, and already carrying DUMMY patients.
 *
 * The panel fills several booklet chapters — blood, heart, blood sugar,
 * thyroid, vitamins — with a mix of healthy and flagged readings so the
 * badges, gauges and the action plan all have something to show.
 *
 * Re-runnable: it clears its own previous rows first.
 * Remove it with 902_smart_report_demo_cleanup.sql.
 */
SET NOCOUNT ON;
SET XACT_ABORT ON;

BEGIN TRAN;

DECLARE @sid NVARCHAR(100) = N'DEMOSMART1';

DECLARE @old TABLE (pid INT);
INSERT INTO @old (pid)
SELECT id FROM dbo.tbl_med_mcc_patient_master
WHERE mcc_code = 1 AND name = N'DEMO SMART REPORT';

DELETE FROM dbo.tbl_med_mcc_patient_test_result WHERE vailid = @sid;
DELETE FROM dbo.tbl_med_mcc_patient_samples     WHERE vailid = @sid;
DELETE FROM dbo.telo_custom_test_order          WHERE patient_id IN (SELECT pid FROM @old);
DELETE FROM dbo.tbl_med_mcc_patient_master      WHERE id IN (SELECT pid FROM @old);

INSERT INTO dbo.tbl_med_mcc_patient_master (name, mcc_code, gender, age, age_type, sample_time, addedby)
VALUES (N'DEMO SMART REPORT', 1, 2, 42, 1, GETDATE(), N'inf:demo');

DECLARE @pid INT = SCOPE_IDENTITY();

-- status 7 = Authorized, which is what the reporting list treats as releasable.
INSERT INTO dbo.tbl_med_mcc_patient_samples
    (vailid, patient_id, sample_status, modifieddate, lastmodified_date, business_unit_id, testnames, Sample_ClinicalHistory)
VALUES
    (@sid, @pid, 7, DATEADD(HOUR, -6, GETDATE()), DATEADD(HOUR, -1, GETDATE()), 1,
     N'Complete Blood Count, Lipids, HbA1c, TSH, Vitamins',
     N'Demo sample for the Smart Report booklet.');

-- auth = 1 throughout: the booklet deliberately excludes anything the lab has
-- not signed out, so an unauthorised row would simply be withheld from it.
INSERT INTO dbo.tbl_med_mcc_patient_test_result
    (vailid, testid, testcode, testname, testtype, value, testunit, testnormal_range, abnormal, auth, updateddate, addedby)
VALUES
    (@sid, 233, N'HE011', N'Hemoglobin',            N'Test', N'16.0',  N'g/dL',     N'12.0 - 15.0',     1, 1, GETDATE(), N'inf:demo'),
    (@sid, 233, N'HE011', N'Platelet Count',        N'Test', N'235',   N'10^3/µL',  N'150 - 450',       0, 1, GETDATE(), N'inf:demo'),
    (@sid, 233, N'HE011', N'Total Leukocyte Count', N'Test', N'7.46',  N'x1000/µL', N'4.0 - 11.0',      0, 1, GETDATE(), N'inf:demo'),
    (@sid, 104, N'BI079', N'Cholesterol - Total',   N'Test', N'244',   N'mg/dL',    N'Desirable < 200', 1, 1, GETDATE(), N'inf:demo'),
    (@sid, 102, N'BI077', N'Cholesterol - HDL',     N'Test', N'58',    N'mg/dL',    N'> 40',            0, 1, GETDATE(), N'inf:demo'),
    (@sid, 291, N'BI127', N'Glycated Hemoglobin (HBA1c)',        N'Test', N'5.4',  N'%',       N'4.0 - 5.6',   0, 1, GETDATE(), N'inf:demo'),
    (@sid, 170, N'BI221', N'Thyroid Stimulating Hormone (TSH)',  N'Test', N'6.20', N'uIU/ml',  N'0.35 - 5.50', 1, 1, GETDATE(), N'inf:demo'),
    (@sid, 175, N'BI235', N'Vitamin B12',           N'Test', N'145',   N'pg/ml',    N'180 - 914',       1, 1, GETDATE(), N'inf:demo'),
    (@sid,  74, N'BI005', N'VITAMIN D',             N'Test', N'38',    N'ng/mL',    N'30 - 100',        0, 1, GETDATE(), N'inf:demo');

-- The paid extra. THIS row is what entitles the patient to the booklet — see
-- SmartReportAccessRepository. bill_id 0 because no bill exists for a demo that
-- never went through billing, and the column carries no foreign key.
INSERT INTO dbo.telo_custom_test_order
    (bill_id, patient_id, custom_test_id, code, name, unit_amount, qty, mcc_code, created_by)
VALUES
    (0, @pid, 3, N'SMART-RPT', N'Smart Report', 99, 1, 1, N'inf:demo');

COMMIT;

SELECT demo_sid = @sid, demo_pid = @pid;
GO
