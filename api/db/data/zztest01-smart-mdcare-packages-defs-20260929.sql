SET QUOTED_IDENTIFIER ON;
GO
/*
 * zztest01-smart-mdcare-packages-defs-20260929.sql - the eight booklet
 * packages on MDCARE's rate list that have no fully released single-package
 * order to model on, built from their DEFINITIONS instead: every member test
 * and profile of the package (tbl_med_test_master_test_param and
 * _profile_param, IsActive ignored as the LIS's own expansion ignores it —
 * script 146), each cloned structure-only from a real released tube that
 * carries that member, one tube per member. Values are generated from each
 * row's own reference range as the other fixtures do. Nothing a real patient
 * measured is reproduced; the names are invented.
 *
 *   ZZMDP01A-K  Anil Kapoor      M 42  HPK003     HEALTH PACKAGE 3  (11 members)
 *   ZZMDP02A-K  Geeta Rani       F 47  HS2        HEALTH SCREEN 2  (11 members)
 *   ZZMDP03A-F  Sanjay Dhingra   M 39  HR0201EX   HR0201 EXTENDED  (6 members)
 *   ZZMDP04A-H  Anita Ahlawat    F 51  HR202A EX  HR202A EX  (8 members)
 *   ZZMDP05A-N  Vinod Hooda      M 57  HR204AEX   HR204A EXTENDED  (14 members)
 *   ZZMDP06A-Q  Nighat Jan       F 44  JKHS401    JK HS4 EXTENDED PROFILE  (17 members)
 *   ZZMDP07A-H  Rajendra Pal     M 36  UP0102     UP102 HR202 PROFLE  (8 members)
 *   ZZMDP08A-K  Sarita Verma     F 49  UP103      UP103 HR203 PROFLE  (11 members)
 *
 * The reference text on a cloned row is the template patient's (adults of
 * 25–60), not this patient's exact age band; the booklet reads the text as
 * printed, so this is a review of layout and copy, not of ranges. No bill
 * (bill_id 0), status 7, auth = 1, a Smart Report line at the Rs 49
 * package-tier offer. Re-runnable; remove with
 * zztest01-smart-mdcare-packages-defs-cleanup-20260929.sql.
 */
SET NOCOUNT ON;
SET XACT_ABORT ON;
BEGIN TRAN;
DECLARE @mcc INT = 6094;
DECLARE @by  NVARCHAR(50) = N'inf:jas';
DECLARE @drawn DATETIME = DATEADD(MINUTE, 55, DATEADD(HOUR, 7, CONVERT(DATETIME, CONVERT(DATE, DATEADD(DAY, -1, GETDATE())))));
DECLARE @regd  DATETIME = DATEADD(HOUR, 2, @drawn);
DECLARE @done  DATETIME = DATEADD(HOUR, 9, @drawn);

/* ---- clear the previous run ------------------------------------------- */
DECLARE @old TABLE (pid INT);
INSERT INTO @old (pid)
SELECT DISTINCT s.patient_id FROM dbo.tbl_med_mcc_patient_samples s JOIN dbo.tbl_med_mcc_patient_master p ON p.id = s.patient_id
WHERE p.mcc_code = @mcc AND s.vailid LIKE N'ZZMDP[0-9][0-9][A-Z]';
DELETE FROM dbo.tbl_med_mcc_patient_test_result WHERE vailid LIKE N'ZZMDP[0-9][0-9][A-Z]';
DELETE FROM dbo.tbl_med_mcc_patient_samples     WHERE vailid LIKE N'ZZMDP[0-9][0-9][A-Z]';
DELETE FROM dbo.telo_custom_test_order          WHERE patient_id IN (SELECT pid FROM @old);
DELETE FROM dbo.tbl_med_mcc_patient_tests       WHERE patient_id IN (SELECT pid FROM @old);
DELETE FROM dbo.tbl_med_mcc_patient_master      WHERE id IN (SELECT pid FROM @old);

/* ---- the patients ------------------------------------------------------ */
DECLARE @spec TABLE (n TINYINT, initial NVARCHAR(10), name NVARCHAR(100), age INT, gender INT, pkg INT);
INSERT INTO @spec VALUES
    (1, N'Mr', N'Anil Kapoor', 42, 1, 197),
    (2, N'Mrs', N'Geeta Rani', 47, 2, 5),
    (3, N'Mr', N'Sanjay Dhingra', 39, 1, 2360),
    (4, N'Mrs', N'Anita Ahlawat', 51, 2, 2457),
    (5, N'Mr', N'Vinod Hooda', 57, 1, 2492),
    (6, N'Mrs', N'Nighat Jan', 44, 2, 226),
    (7, N'Mr', N'Rajendra Pal', 36, 1, 213),
    (8, N'Mrs', N'Sarita Verma', 49, 2, 214);

/* ---- the members of each package, and the real tube each is modelled on ---- */
DECLARE @items TABLE (n TINYINT, letter CHAR(1), kind NVARCHAR(10), item_id INT, code NVARCHAR(50), name NVARCHAR(200), tmpl NVARCHAR(50));
INSERT INTO @items VALUES
    (1, 'A', N'profile', 7, N'CP106', N'LIPID PROFILE', N'9696011'),
    (1, 'B', N'profile', 8, N'CP107', N'Liver Function Test', N'8434063'),
    (1, 'C', N'profile', 25, N'GP12', N'IRON PROFILE', N'9457775'),
    (1, 'D', N'profile', 82, N'CBES1', N'CBC WITH ESR', N'9721893'),
    (1, 'E', N'profile', 102, N'KFTMD', N'Kidney Functions Test MD', N'9334753'),
    (1, 'F', N'test', 34, N'CP004', N'Complete Urine Examination', N'9579910'),
    (1, 'G', N'test', 74, N'BI005', N'VITAMIN D', N'9884982'),
    (1, 'H', N'test', 158, N'BI209', N'Testosterone  - Total', N'9801658'),
    (1, 'I', N'test', 175, N'BI235', N'Vitamin B12  -Serum', N'09215825'),
    (1, 'J', N'test', 284, N'BI114', N'Glucose - Fasting', N'99023391'),
    (1, 'K', N'test', 291, N'BI127', N'Glycated  Hemoglobin (HBA1c)', N'99023416'),
    (2, 'A', N'profile', 1, N'CP114', N'Thyroid Profile I', N'09718601'),
    (2, 'B', N'profile', 7, N'CP106', N'LIPID PROFILE', N'9696011'),
    (2, 'C', N'profile', 8, N'CP107', N'Liver Function Test', N'8434063'),
    (2, 'D', N'profile', 16, N'CP116', N'Kidney Function Test with Electrolytes', N'99023473'),
    (2, 'E', N'profile', 25, N'GP12', N'IRON PROFILE', N'9457775'),
    (2, 'F', N'test', 80, N'B2043', N'Microalbumin -Spot Urine Test', N'9885024'),
    (2, 'G', N'test', 97, N'BI063', N'Calcium - ionized', N'9112205'),
    (2, 'H', N'test', 233, N'HE011', N'Complete Blood Count (CBC)', N'9615842'),
    (2, 'I', N'test', 268, N'HE017', N'Erythrocyte Sedimentation Rate (ESR)', N'9433283'),
    (2, 'J', N'test', 284, N'BI114', N'Glucose - Fasting', N'99023391'),
    (2, 'K', N'test', 291, N'BI127', N'Glycated  Hemoglobin (HBA1c)', N'99023416'),
    (3, 'A', N'profile', 1, N'CP114', N'Thyroid Profile I', N'09718601'),
    (3, 'B', N'profile', 7, N'CP106', N'LIPID PROFILE', N'9696011'),
    (3, 'C', N'profile', 8, N'CP107', N'Liver Function Test', N'8434063'),
    (3, 'D', N'profile', 121, N'KFTEG01', N'KFT WITH EGFR', N'9695056'),
    (3, 'E', N'profile', 82, N'CBES1', N'CBC WITH ESR', N'9721893'),
    (3, 'F', N'test', 284, N'BI114', N'Glucose - Fasting', N'99023391'),
    (4, 'A', N'profile', 121, N'KFTEG01', N'KFT WITH EGFR', N'9695056'),
    (4, 'B', N'profile', 8, N'CP107', N'Liver Function Test', N'8434063'),
    (4, 'C', N'profile', 7, N'CP106', N'LIPID PROFILE', N'9696011'),
    (4, 'D', N'profile', 1, N'CP114', N'Thyroid Profile I', N'09718601'),
    (4, 'E', N'profile', 82, N'CBES1', N'CBC WITH ESR', N'9721893'),
    (4, 'F', N'test', 284, N'BI114', N'Glucose - Fasting', N'99023391'),
    (4, 'G', N'test', 34, N'CP004', N'Complete Urine Examination', N'9579910'),
    (4, 'H', N'test', 291, N'BI127', N'Glycated  Hemoglobin (HBA1c)', N'99023416'),
    (5, 'A', N'profile', 1, N'CP114', N'Thyroid Profile I', N'09718601'),
    (5, 'B', N'profile', 7, N'CP106', N'LIPID PROFILE', N'9696011'),
    (5, 'C', N'profile', 8, N'CP107', N'Liver Function Test', N'8434063'),
    (5, 'D', N'profile', 25, N'GP12', N'IRON PROFILE', N'9457775'),
    (5, 'E', N'profile', 82, N'CBES1', N'CBC WITH ESR', N'9721893'),
    (5, 'F', N'profile', 128, N'KFTELEC01', N'KFT WITH ELECTROLYTES', N'9450164'),
    (5, 'G', N'test', 34, N'CP004', N'Complete Urine Examination', N'9579910'),
    (5, 'H', N'test', 74, N'BI005', N'VITAMIN D', N'9884982'),
    (5, 'I', N'test', 113, N'MS024', N'C-Reactive Protein (CRP)', N'9868017'),
    (5, 'J', N'test', 119, N'BI099', N'eGFR (estimated Glomerular Filtration Rate)', N'99015147'),
    (5, 'K', N'test', 175, N'BI235', N'Vitamin B12  -Serum', N'09215825'),
    (5, 'L', N'test', 284, N'BI114', N'Glucose - Fasting', N'99023391'),
    (5, 'M', N'test', 291, N'BI127', N'Glycated  Hemoglobin (HBA1c)', N'99023416'),
    (5, 'N', N'test', 1890, N'MS111', N'Rheumatoid Arthritis Factor (Nephelometry)', N'9179736'),
    (6, 'A', N'profile', 7, N'CP106', N'LIPID PROFILE', N'9696011'),
    (6, 'B', N'profile', 8, N'CP107', N'Liver Function Test', N'8434063'),
    (6, 'C', N'profile', 12, N'CP111', N'Thyroid Profile II', N'9216490'),
    (6, 'D', N'profile', 16, N'CP116', N'Kidney Function Test with Electrolytes', N'99023473'),
    (6, 'E', N'test', 34, N'CP004', N'Complete Urine Examination', N'9579910'),
    (6, 'F', N'test', 74, N'BI005', N'VITAMIN D', N'9884982'),
    (6, 'G', N'test', 135, N'BI137', N'Iron', N'9429832'),
    (6, 'H', N'test', 136, N'BI138', N'Iron Binding Capacity - Total (TIBC)', N'8541019'),
    (6, 'I', N'test', 164, N'BI214', N'T3 (Tri Iodothyronine )', N'99023390'),
    (6, 'J', N'test', 165, N'BI215', N'T4 (Thyroxine )', N'99023390'),
    (6, 'K', N'test', 175, N'BI235', N'Vitamin B12  -Serum', N'09215825'),
    (6, 'L', N'test', 233, N'HE011', N'Complete Blood Count (CBC)', N'9615842'),
    (6, 'M', N'test', 268, N'HE017', N'Erythrocyte Sedimentation Rate (ESR)', N'9433283'),
    (6, 'N', N'test', 284, N'BI114', N'Glucose - Fasting', N'99023391'),
    (6, 'O', N'test', 291, N'BI127', N'Glycated  Hemoglobin (HBA1c)', N'99023416'),
    (6, 'P', N'test', 1890, N'MS111', N'Rheumatoid Arthritis Factor (Nephelometry)', N'9179736'),
    (6, 'Q', N'test', 113, N'MS024', N'C-Reactive Protein (CRP)', N'9868017'),
    (7, 'A', N'profile', 1, N'CP114', N'Thyroid Profile I', N'09718601'),
    (7, 'B', N'profile', 7, N'CP106', N'LIPID PROFILE', N'9696011'),
    (7, 'C', N'profile', 8, N'CP107', N'Liver Function Test', N'8434063'),
    (7, 'D', N'profile', 16, N'CP116', N'Kidney Function Test with Electrolytes', N'99023473'),
    (7, 'E', N'test', 34, N'CP004', N'Complete Urine Examination', N'9579910'),
    (7, 'F', N'test', 233, N'HE011', N'Complete Blood Count (CBC)', N'9615842'),
    (7, 'G', N'test', 284, N'BI114', N'Glucose - Fasting', N'99023391'),
    (7, 'H', N'test', 291, N'BI127', N'Glycated  Hemoglobin (HBA1c)', N'99023416'),
    (8, 'A', N'profile', 1, N'CP114', N'Thyroid Profile I', N'09718601'),
    (8, 'B', N'profile', 7, N'CP106', N'LIPID PROFILE', N'9696011'),
    (8, 'C', N'profile', 8, N'CP107', N'Liver Function Test', N'8434063'),
    (8, 'D', N'profile', 16, N'CP116', N'Kidney Function Test with Electrolytes', N'99023473'),
    (8, 'E', N'profile', 25, N'GP12', N'IRON PROFILE', N'9457775'),
    (8, 'F', N'test', 34, N'CP004', N'Complete Urine Examination', N'9579910'),
    (8, 'G', N'test', 74, N'BI005', N'VITAMIN D', N'9884982'),
    (8, 'H', N'test', 175, N'BI235', N'Vitamin B12  -Serum', N'09215825'),
    (8, 'I', N'test', 233, N'HE011', N'Complete Blood Count (CBC)', N'9615842'),
    (8, 'J', N'test', 291, N'BI127', N'Glycated  Hemoglobin (HBA1c)', N'99023416'),
    (8, 'K', N'test', 284, N'BI114', N'Glucose - Fasting', N'99023391');

DECLARE @p TABLE (n TINYINT, pid INT, pkg INT);
DECLARE @n TINYINT = 1, @pid INT;
WHILE @n <= 8
BEGIN
    INSERT INTO dbo.tbl_med_mcc_patient_master
        (mcc_code, initial, name, age, age_type, gender, sample_date, sample_time, ref_doctor_other, mobile_number, addedby, addeddate)
    SELECT @mcc, initial, name, age, 1, gender, @drawn, @drawn, 'Self', CONCAT('90000005', RIGHT(CONCAT('0', n), 2)), @by, @regd
    FROM @spec WHERE n = @n;
    SET @pid = SCOPE_IDENTITY();
    INSERT INTO @p SELECT n, @pid, pkg FROM @spec WHERE n = @n;
    SET @n += 1;
END

/* The package line, and the paid extra that entitles the patient to the booklet. */
INSERT INTO dbo.tbl_med_mcc_patient_tests (patient_id, test_id, test_code, test_name, test_rate, test_type, addedby, addeddate)
SELECT p.pid, m.id, LTRIM(RTRIM(m.Master_Profile_Code)), LTRIM(RTRIM(m.Master_Profile_Name)), m.MRP, 'Master', @by, @regd
FROM @p p JOIN dbo.tbl_med_test_master_profile_master m ON m.id = p.pkg;
INSERT INTO dbo.telo_custom_test_order (bill_id, patient_id, custom_test_id, code, name, unit_amount, qty, mcc_code, created_by)
SELECT 0, pid, 3, N'SMART-RPT', N'Smart Report', 49, 1, @mcc, @by FROM @p;

/* ---- the tubes: one per member ------------------------------------------- */
DECLARE @tube TABLE (n TINYINT, sid NVARCHAR(50), kind NVARCHAR(10), item_id INT, code NVARCHAR(50), name NVARCHAR(200), tmpl NVARCHAR(50));
INSERT INTO @tube SELECT n, CONCAT(N'ZZMDP', RIGHT(CONCAT('0', n), 2), letter), kind, item_id, code, name, tmpl FROM @items;

INSERT INTO dbo.tbl_med_mcc_patient_samples
    (patient_id, sampleid, testcodes, testnames, testtypes, vailid, sample_status, addedby, addeddate, modifiedby, modifieddate,
     lastmodified_date, report_type, department_id, business_unit_id, authorised_by, signature_id)
SELECT p.pid, s.sampleid, t.code, t.name, CASE t.kind WHEN N'profile' THEN N'mp' ELSE N'mt' END, t.sid, 7, @by, @regd, @by, @regd, @done,
       s.report_type, s.department_id, s.business_unit_id, s.authorised_by, s.signature_id
FROM @tube t JOIN @p p ON p.n = t.n JOIN dbo.tbl_med_mcc_patient_samples s ON s.vailid = t.tmpl;

/* ---- the result rows: the member's rows from the template, values from the range ---- */
IF OBJECT_ID('tempdb..#w') IS NOT NULL DROP TABLE #w;
SELECT ROW_NUMBER() OVER (ORDER BY t.n, t.sid, r.id) AS seq,
       p.pid, p.pkg, t.sid, t.kind, r.id AS src_id, r.testid, r.testtype, r.value AS tmpl_value, r.hasparameters, r.normal_range,
       r.testcode, r.testname, r.testnormal_range, r.testunit, r.paramid,
       profile_id = CASE WHEN t.kind = N'profile' THEN r.profile_id ELSE NULL END,
       r.level_id,
       rng = LTRIM(RTRIM(REPLACE(REPLACE(REPLACE(ISNULL(r.testnormal_range, ''), CHAR(13), ' '), CHAR(10), ' '), CHAR(9), ' '))),
       p1 = 0, n1 = CAST(NULL AS VARCHAR(20)), rest = CAST(NULL AS NVARCHAR(400)), prefix = CAST(NULL AS NVARCHAR(400)),
       p2 = 0, n2 = CAST(NULL AS VARCHAR(20)), betw = CAST(NULL AS NVARCHAR(400)),
       lo = CAST(NULL AS DECIMAL(18,4)), hi = CAST(NULL AS DECIMAL(18,4)),
       isRange = 0, upperOnly = 0, lowerOnly = 0, dec = 0, flag = CASE WHEN ((r.id + t.n) % 7) = 3 THEN 1 ELSE 0 END,
       v = CAST(NULL AS DECIMAL(18,4)), value = CAST(NULL AS NVARCHAR(60)), ab = 0
INTO #w
FROM @tube t
JOIN @p p ON p.n = t.n
JOIN dbo.tbl_med_mcc_patient_test_result r ON r.vailid = t.tmpl
WHERE (t.kind = N'profile' AND r.profile_id = t.item_id)
   OR (t.kind = N'test' AND r.testid = t.item_id AND r.testtype <> 'Profile');

UPDATE #w SET p1 = PATINDEX('%[0-9]%', rng);
UPDATE #w SET n1 = LEFT(SUBSTRING(rng, p1, 20), PATINDEX('%[^0-9.]%', SUBSTRING(rng, p1, 20) + ' ') - 1) WHERE p1 > 0;
UPDATE #w SET rest = CASE WHEN n1 IS NULL THEN '' ELSE SUBSTRING(rng, p1 + LEN(n1), 400) END,
              prefix = CASE WHEN p1 = 0 THEN rng ELSE LEFT(rng, p1 - 1) END;
UPDATE #w SET p2 = PATINDEX('%[0-9]%', rest);
UPDATE #w SET n2 = LEFT(SUBSTRING(rest, p2, 20), PATINDEX('%[^0-9.]%', SUBSTRING(rest, p2, 20) + ' ') - 1),
              betw = LEFT(rest, p2 - 1)
WHERE p2 > 0;
UPDATE #w SET lo = TRY_CONVERT(DECIMAL(18,4), NULLIF(n1, '.')), hi = TRY_CONVERT(DECIMAL(18,4), NULLIF(n2, '.'));
UPDATE #w SET isRange = CASE WHEN n2 IS NOT NULL AND ISNULL(betw,'') NOT LIKE '%|%' AND ISNULL(betw,'') NOT LIKE '%:%'
                              AND (betw LIKE '%-%' OR betw LIKE '%–%' OR betw LIKE '% to %') THEN 1 ELSE 0 END,
              upperOnly = CASE WHEN prefix LIKE '%<%' OR prefix LIKE '%≤%' OR prefix LIKE '%up to%' OR prefix LIKE '%less than%' THEN 1 ELSE 0 END,
              lowerOnly = CASE WHEN prefix LIKE '%>%' OR prefix LIKE '%≥%' OR prefix LIKE '%more than%' THEN 1 ELSE 0 END,
              dec = CASE WHEN CHARINDEX('.', ISNULL(n1, '')) > 0 THEN LEN(n1) - CHARINDEX('.', n1)
                         WHEN CHARINDEX('.', ISNULL(n2, '')) > 0 THEN LEN(n2) - CHARINDEX('.', n2) ELSE 0 END;
UPDATE #w SET v = CASE
    WHEN isRange = 1 AND lo IS NOT NULL AND hi IS NOT NULL AND hi > lo
         THEN CASE WHEN flag = 1 THEN hi + (hi - lo) * 0.25 ELSE lo + (hi - lo) * 0.55 END
    WHEN upperOnly = 1 AND lo IS NOT NULL THEN CASE WHEN flag = 1 THEN lo * 1.2 ELSE lo * 0.85 END
    WHEN lowerOnly = 1 AND lo IS NOT NULL THEN CASE WHEN flag = 1 THEN lo * 0.8 ELSE lo * 1.2 END
    ELSE NULL END;
UPDATE #w SET value = CASE
    WHEN testtype IN ('Head', 'Profile') THEN tmpl_value
    WHEN v IS NOT NULL THEN CASE dec WHEN 0 THEN FORMAT(v, 'F0') WHEN 1 THEN FORMAT(v, 'F1') WHEN 2 THEN FORMAT(v, 'F2') ELSE FORMAT(v, 'F3') END
    WHEN rng LIKE '%Negative%' THEN N'Negative'
    WHEN rng LIKE '%NIL%' OR rng LIKE '%Nil%' THEN N'Nil'
    WHEN rng LIKE '%Absent%' THEN N'Absent'
    WHEN rng LIKE '%Pale%' THEN N'Pale Yellow'
    WHEN rng LIKE '%Clear%' THEN N'Clear'
    WHEN rng LIKE '%Normal%' THEN N'Normal'
    WHEN testname LIKE '%colour%' OR testname LIKE '%color%' THEN N'Pale Yellow'
    WHEN testname LIKE '%appearance%' OR testname LIKE '%transparency%' THEN N'Clear'
    WHEN testname LIKE '%reaction%' OR testname LIKE '%pH%' THEN N'6.0'
    WHEN testname LIKE '%specific gravity%' THEN N'1.015'
    ELSE N'Normal' END,
    ab = CASE WHEN testtype NOT IN ('Head', 'Profile') AND v IS NOT NULL AND flag = 1 THEN 1 ELSE 0 END;

INSERT INTO dbo.tbl_med_mcc_patient_test_result
    (patientid, vailid, testid, value, testtype, auth, attachment, hasparameters, normal_range, testcode, testname,
     testnormal_range, testunit, comments, addedby, addeddate, updatedby, updateddate, paramid, profile_id, abnormal,
     mobile_number, master_profile_id, level_id)
SELECT pid, sid, testid, value, testtype, 1, 0, hasparameters, normal_range, testcode, testname,
       testnormal_range, testunit, NULL, @by, @regd, @by, @done, paramid, profile_id, ab,
       NULL, pkg, level_id
FROM #w ORDER BY seq;
DROP TABLE #w;

COMMIT;

SELECT p.n, p.pid, LTRIM(RTRIM(m.Master_Profile_Code)) AS code, pt.name,
       tubes   = (SELECT COUNT(*) FROM dbo.tbl_med_mcc_patient_samples s WHERE s.patient_id = p.pid),
       results = (SELECT COUNT(*) FROM dbo.tbl_med_mcc_patient_test_result r WHERE r.patientid = p.pid AND r.testtype IN ('Test','Param')),
       flagged = (SELECT COUNT(*) FROM dbo.tbl_med_mcc_patient_test_result r WHERE r.patientid = p.pid AND r.abnormal = 1),
       blank   = (SELECT COUNT(*) FROM dbo.tbl_med_mcc_patient_test_result r WHERE r.patientid = p.pid AND r.testtype IN ('Test','Param') AND ISNULL(r.value, '') = '')
FROM @p p JOIN dbo.tbl_med_mcc_patient_master pt ON pt.id = p.pid JOIN dbo.tbl_med_test_master_profile_master m ON m.id = p.pkg ORDER BY p.n;
GO
