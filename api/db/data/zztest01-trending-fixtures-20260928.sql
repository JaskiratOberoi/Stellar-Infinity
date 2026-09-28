SET QUOTED_IDENTIFIER ON;
GO
/*
 * zztest01-trending-fixtures-20260928.sql - one person, three visits, on the
 * throwaway centre ZZTEST01 (mcc 6094), for reviewing the Trending report.
 *
 *   Sunita Rawat, F 44, mobile 9000000301 - the identity the history
 *   procedure matches on (name + mobile + sex, age within two years).
 *
 *   Visit 1 (180 days ago)  ZZTRN1A Lipid Profile  ZZTRN1B Vitamin D  ZZTRN1C TSH
 *   Visit 2 ( 90 days ago)  ZZTRN2A                ZZTRN2B            ZZTRN2C
 *   Visit 3 (yesterday)     ZZTRN3A                ZZTRN3B            ZZTRN3C
 *
 * Each tube is cloned, structure only, from one real released tube of that
 * profile or test (codes, names, units, reference text); the values are
 * set here so the picture improves visit by visit: Vitamin D climbs out of
 * deficiency, TSH settles from above range to within, cholesterol and
 * triglycerides come down. Nothing a real patient measured is reproduced;
 * the name is invented; the SIDs and the centre mark them as fixtures. The
 * latest visit carries a Smart Report line (no bill) so the booklet can be
 * reviewed too. Re-runnable; remove with the matching cleanup script.
 */
SET NOCOUNT ON;
SET XACT_ABORT ON;
BEGIN TRAN;
DECLARE @mcc INT = 6094;
DECLARE @by  NVARCHAR(50) = N'inf:jas';

/* ---- clear the previous run ------------------------------------------- */
DECLARE @old TABLE (pid INT);
INSERT INTO @old (pid)
SELECT DISTINCT s.patient_id FROM dbo.tbl_med_mcc_patient_samples s JOIN dbo.tbl_med_mcc_patient_master p ON p.id = s.patient_id
WHERE p.mcc_code = @mcc AND s.vailid LIKE N'ZZTRN[1-3][A-C]';
DELETE FROM dbo.tbl_med_mcc_patient_test_result WHERE vailid LIKE N'ZZTRN[1-3][A-C]';
DELETE FROM dbo.tbl_med_mcc_patient_samples     WHERE vailid LIKE N'ZZTRN[1-3][A-C]';
DELETE FROM dbo.telo_custom_test_order          WHERE patient_id IN (SELECT pid FROM @old);
DELETE FROM dbo.tbl_med_mcc_patient_tests       WHERE patient_id IN (SELECT pid FROM @old);
DELETE FROM dbo.tbl_med_mcc_patient_master      WHERE id IN (SELECT pid FROM @old);

/* ---- the three visits ---------------------------------------------------- */
DECLARE @visit TABLE (n TINYINT, drawn DATETIME, pid INT);
INSERT INTO @visit (n, drawn) VALUES
    (1, DATEADD(MINUTE, 20, DATEADD(HOUR, 8, CONVERT(DATETIME, CONVERT(DATE, DATEADD(DAY, -180, GETDATE())))))),
    (2, DATEADD(MINUTE, 35, DATEADD(HOUR, 9, CONVERT(DATETIME, CONVERT(DATE, DATEADD(DAY, -90, GETDATE())))))),
    (3, DATEADD(MINUTE, 10, DATEADD(HOUR, 8, CONVERT(DATETIME, CONVERT(DATE, DATEADD(DAY, -1, GETDATE()))))));

DECLARE @n TINYINT = 1, @pid INT, @drawn DATETIME;
WHILE @n <= 3
BEGIN
    SELECT @drawn = drawn FROM @visit WHERE n = @n;
    INSERT INTO dbo.tbl_med_mcc_patient_master
        (mcc_code, initial, name, age, age_type, gender, sample_date, sample_time, ref_doctor_other, mobile_number, addedby, addeddate)
    VALUES (@mcc, N'Mrs', N'Sunita Rawat', 44, 1, 2, @drawn, @drawn, 'Self', '9000000301', @by, DATEADD(HOUR, 2, @drawn));
    SET @pid = SCOPE_IDENTITY();
    UPDATE @visit SET pid = @pid WHERE n = @n;
    SET @n += 1;
END

/* ---- the items and their template tubes ------------------------------ */
DECLARE @items TABLE (letter CHAR(1), code NVARCHAR(20), tmpl NVARCHAR(50));
INSERT INTO @items VALUES ('A', N'CP106', N'9585199'), ('B', N'BI005', N'9615216'), ('C', N'BI221', N'9756314');

INSERT INTO dbo.tbl_med_mcc_patient_tests (patient_id, test_id, test_code, test_name, test_rate, test_type, addedby, addeddate)
SELECT v.pid, x.test_id, x.test_code, x.test_name, x.test_rate, x.test_type, @by, DATEADD(HOUR, 2, v.drawn)
FROM @visit v CROSS JOIN @items i
CROSS APPLY (SELECT TOP 1 t.test_id, t.test_code, t.test_name, t.test_rate, t.test_type
             FROM dbo.tbl_med_mcc_patient_samples s JOIN dbo.tbl_med_mcc_patient_tests t ON t.patient_id = s.patient_id
             WHERE s.vailid = i.tmpl AND LTRIM(RTRIM(t.test_code)) = i.code ORDER BY t.id) x;

/* The booklet on the latest visit: a supported profile (Lipid) at the single-test tier. */
INSERT INTO dbo.telo_custom_test_order (bill_id, patient_id, custom_test_id, code, name, unit_amount, qty, mcc_code, created_by)
SELECT 0, v.pid, 3, N'SMART-MINI', N'Smart Report', 11, 1, @mcc, @by FROM @visit v WHERE v.n = 3;

/* ---- the tubes ---------------------------------------------------------- */
INSERT INTO dbo.tbl_med_mcc_patient_samples
    (patient_id, sampleid, testcodes, testnames, testtypes, vailid, sample_status, addedby, addeddate, modifiedby, modifieddate,
     lastmodified_date, report_type, department_id, business_unit_id, authorised_by, signature_id)
SELECT v.pid, s.sampleid, s.testcodes, s.testnames, s.testtypes, CONCAT(N'ZZTRN', v.n, i.letter), 7,
       @by, DATEADD(HOUR, 2, v.drawn), @by, DATEADD(HOUR, 2, v.drawn), DATEADD(HOUR, 9, v.drawn),
       s.report_type, s.department_id, s.business_unit_id, s.authorised_by, s.signature_id
FROM @visit v CROSS JOIN @items i JOIN dbo.tbl_med_mcc_patient_samples s ON s.vailid = i.tmpl;

/* ---- the rows: structure from the template, values by visit ------------- */
INSERT INTO dbo.tbl_med_mcc_patient_test_result
    (patientid, vailid, testid, value, testtype, auth, attachment, hasparameters, normal_range, testcode, testname,
     testnormal_range, testunit, comments, addedby, addeddate, updatedby, updateddate, paramid, profile_id, abnormal,
     mobile_number, master_profile_id, level_id)
SELECT v.pid, CONCAT(N'ZZTRN', v.n, i.letter), r.testid,
       CASE WHEN r.testtype NOT IN ('Test', 'Param') THEN r.value
            WHEN r.testname LIKE N'%Cholesterol%Total%' OR r.testname LIKE N'%Total%Cholesterol%' AND r.testname NOT LIKE N'%HDL%' AND r.testname NOT LIKE N'%ratio%'
                 THEN CASE v.n WHEN 1 THEN N'246' WHEN 2 THEN N'221' ELSE N'198' END
            WHEN r.testname LIKE N'%Triglycer%'                        THEN CASE v.n WHEN 1 THEN N'190' WHEN 2 THEN N'165' ELSE N'140' END
            WHEN r.testname LIKE N'%HDL%' AND r.testname NOT LIKE N'%LDL%' AND r.testname NOT LIKE N'%ratio%' AND r.testname NOT LIKE N'%/%' AND r.testname NOT LIKE N'%Non%'
                 THEN CASE v.n WHEN 1 THEN N'38' WHEN 2 THEN N'42' ELSE N'46' END
            WHEN r.testname LIKE N'%LDL%' AND r.testname NOT LIKE N'%HDL%' AND r.testname NOT LIKE N'%ratio%' AND r.testname NOT LIKE N'%/%'
                 THEN CASE v.n WHEN 1 THEN N'160' WHEN 2 THEN N'140' ELSE N'118' END
            WHEN r.testname LIKE N'%VLDL%'                             THEN CASE v.n WHEN 1 THEN N'38' WHEN 2 THEN N'33' ELSE N'28' END
            WHEN r.testname LIKE N'%Non%HDL%'                          THEN CASE v.n WHEN 1 THEN N'208' WHEN 2 THEN N'179' ELSE N'152' END
            WHEN r.testname LIKE N'%HDL%LDL%' OR r.testname LIKE N'%HDL/LDL%' THEN CASE v.n WHEN 1 THEN N'0.24' WHEN 2 THEN N'0.30' ELSE N'0.39' END
            WHEN r.testname LIKE N'%LDL%HDL%' OR r.testname LIKE N'%LDL/%'    THEN CASE v.n WHEN 1 THEN N'4.2' WHEN 2 THEN N'3.3' ELSE N'2.6' END
            WHEN r.testname LIKE N'%CHOLESTEROL/HDL%' OR r.testname LIKE N'%Cholesterol%/%HDL%' THEN CASE v.n WHEN 1 THEN N'6.5' WHEN 2 THEN N'5.3' ELSE N'4.3' END
            WHEN r.testname LIKE N'%VITAMIN D%' OR r.testname LIKE N'%25%OH%'   THEN CASE v.n WHEN 1 THEN N'12.4' WHEN 2 THEN N'19.6' ELSE N'31.8' END
            WHEN r.testname LIKE N'%TSH%' OR r.testname LIKE N'%Thyroid Stimulating%' THEN CASE v.n WHEN 1 THEN N'6.80' WHEN 2 THEN N'4.90' ELSE N'2.90' END
            ELSE r.value END,
       r.testtype, 1, 0, r.hasparameters, r.normal_range, r.testcode, r.testname,
       r.testnormal_range, r.testunit, NULL, @by, DATEADD(HOUR, 2, v.drawn), @by, DATEADD(HOUR, 9, v.drawn), r.paramid, r.profile_id,
       CASE WHEN r.testtype NOT IN ('Test', 'Param') THEN 0
            WHEN (r.testname LIKE N'%Cholesterol%Total%' OR r.testname LIKE N'%Total%Cholesterol%') AND r.testname NOT LIKE N'%HDL%' AND v.n <= 2 THEN 1
            WHEN r.testname LIKE N'%Triglycer%' AND v.n <= 2 THEN 1
            WHEN r.testname LIKE N'%HDL%' AND r.testname NOT LIKE N'%LDL%' AND r.testname NOT LIKE N'%ratio%' AND r.testname NOT LIKE N'%/%' AND r.testname NOT LIKE N'%Non%' AND v.n = 1 THEN 1
            WHEN r.testname LIKE N'%LDL%' AND r.testname NOT LIKE N'%HDL%' AND r.testname NOT LIKE N'%ratio%' AND r.testname NOT LIKE N'%/%' AND v.n <= 2 THEN 1
            WHEN (r.testname LIKE N'%VITAMIN D%' OR r.testname LIKE N'%25%OH%') AND v.n <= 2 THEN 1
            WHEN (r.testname LIKE N'%TSH%' OR r.testname LIKE N'%Thyroid Stimulating%') AND v.n = 1 THEN 1
            ELSE 0 END,
       NULL, r.master_profile_id, r.level_id
FROM @visit v CROSS JOIN @items i
JOIN dbo.tbl_med_mcc_patient_test_result r ON r.vailid = i.tmpl
ORDER BY v.n, i.letter, r.id;

COMMIT;

SELECT v.n, v.pid, CONVERT(VARCHAR(10), v.drawn, 120) AS drawn,
       rows_ = (SELECT COUNT(*) FROM dbo.tbl_med_mcc_patient_test_result r WHERE r.patientid = v.pid AND r.testtype IN ('Test','Param')),
       vitd = (SELECT TOP 1 r.value FROM dbo.tbl_med_mcc_patient_test_result r WHERE r.patientid = v.pid AND r.testname LIKE N'%VITAMIN D%'),
       tsh  = (SELECT TOP 1 r.value FROM dbo.tbl_med_mcc_patient_test_result r WHERE r.patientid = v.pid AND (r.testname LIKE N'%TSH%' OR r.testname LIKE N'%Thyroid Stimulating%') AND r.testtype = 'Test')
FROM @visit v ORDER BY v.n;
GO
