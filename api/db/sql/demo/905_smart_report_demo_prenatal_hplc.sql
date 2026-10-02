SET QUOTED_IDENTIFIER ON;
GO
/*
 * 905_smart_report_demo_prenatal_hplc.sql — DEMO DATA. Not part of the schema.
 *
 * Five patients under ZZTEST01 (mcc 6094, the Smart Report test centre), one
 * each on the Double Marker Test, Triple Marker with Graph, Quadruple Markers
 * with Graph, Dual Marker Plus (pre-eclampsia) and Hb Electrophoresis by
 * HPLC, with authorised results and the booklet entitlement, so the two new
 * Smart Report chapters — Pregnancy Screening and Haemoglobin Type — can be
 * shown on real report shapes. Built the way 903 builds its three: result
 * rows cloned STRUCTURE ONLY from a real recent order of the same test (ids,
 * codes, names, units, ranges, coded options), every value authored below.
 * Nothing a real patient measured is copied.
 *
 * Three of the five are low-risk, as most screens are; the quadruple marker
 * is screen-positive for trisomy 21 and the dual-marker-plus carries a
 * raised early pre-eclampsia risk, so the booklet's flagged state and its
 * advice have something to show. The HPLC is a beta-thalassaemia trait.
 *
 * Re-runnable: it removes its own previous rows first (everything under
 * mcc 6094 added by inf:demo-pn). Remove it for good with 906.
 */
SET NOCOUNT ON;
SET XACT_ABORT ON;

BEGIN TRAN;

DECLARE @mcc INT = 6094;
DECLARE @by  NVARCHAR(50) = N'inf:demo-pn';
DECLARE @drawn DATETIME = DATEADD(MINUTE, 40, DATEADD(HOUR, 9, CONVERT(DATETIME, CONVERT(DATE, DATEADD(DAY, -3, GETDATE())))));
DECLARE @regd  DATETIME = DATEADD(HOUR, 3, @drawn);
DECLARE @done  DATETIME = DATEADD(HOUR, 30, @drawn);

/* ---- clear the previous run ------------------------------------------- */
DECLARE @old TABLE (pid INT);
INSERT INTO @old (pid) SELECT id FROM dbo.tbl_med_mcc_patient_master WHERE mcc_code = @mcc AND addedby = @by;
DELETE FROM dbo.tbl_med_mcc_patient_test_result WHERE vailid IN (SELECT vailid FROM dbo.tbl_med_mcc_patient_samples WHERE patient_id IN (SELECT pid FROM @old));
DELETE FROM dbo.tbl_med_mcc_patient_samples     WHERE patient_id IN (SELECT pid FROM @old);
DELETE FROM dbo.telo_custom_test_order          WHERE patient_id IN (SELECT pid FROM @old);
DELETE FROM dbo.tbl_med_mcc_patient_tests       WHERE patient_id IN (SELECT pid FROM @old);
DELETE FROM dbo.tbl_med_mcc_patient_master      WHERE id IN (SELECT pid FROM @old);

/* ---- the five patients ------------------------------------------------- */
DECLARE @p TABLE (demo TINYINT, pid INT, testid INT, code NVARCHAR(50), tname NVARCHAR(100), rate INT, sid NVARCHAR(50), tmpl NVARCHAR(50), sampleid INT);

INSERT INTO dbo.tbl_med_mcc_patient_master (mcc_code, initial, name, age, age_type, gender, sample_date, sample_time, ref_doctor_other, mobile_number, addedby, addeddate)
VALUES (@mcc, 'Mrs', N'Priya Sharma', 31, 1, 2, @drawn, @drawn, 'Dr. Meera Kulkarni MS (Obs & Gyn)', '9000000011', @by, @regd);
INSERT INTO @p SELECT 1, SCOPE_IDENTITY(), 1989, N'BI244A', N'Double Marker Test', 2200, N'DEMOPN1S', N'9884808', 20;

INSERT INTO dbo.tbl_med_mcc_patient_master (mcc_code, initial, name, age, age_type, gender, sample_date, sample_time, ref_doctor_other, mobile_number, addedby, addeddate)
VALUES (@mcc, 'Mrs', N'Neha Gupta', 27, 1, 2, @drawn, @drawn, 'Dr. Meera Kulkarni MS (Obs & Gyn)', '9000000012', @by, @regd);
INSERT INTO @p SELECT 2, SCOPE_IDENTITY(), 1809, N'cp113', N'Triple Marker with Graph', 2400, N'DEMOPN2S', N'9514603', 20;

INSERT INTO dbo.tbl_med_mcc_patient_master (mcc_code, initial, name, age, age_type, gender, sample_date, sample_time, ref_doctor_other, mobile_number, addedby, addeddate)
VALUES (@mcc, 'Mrs', N'Farzana Begum', 36, 1, 2, @drawn, @drawn, 'Dr. Sunil Rathi MD', '9000000013', @by, @regd);
INSERT INTO @p SELECT 3, SCOPE_IDENTITY(), 1810, N'BC0002', N'Quadruple Markers with Graph', 3200, N'DEMOPN3S', N'9695217', 20;

INSERT INTO dbo.tbl_med_mcc_patient_master (mcc_code, initial, name, age, age_type, gender, sample_date, sample_time, ref_doctor_other, mobile_number, addedby, addeddate)
VALUES (@mcc, 'Mrs', N'Anjali Verma', 29, 1, 2, @drawn, @drawn, 'Dr. Meera Kulkarni MS (Obs & Gyn)', '9000000014', @by, @regd);
INSERT INTO @p SELECT 4, SCOPE_IDENTITY(), 2216, N'BI314', N'Dual Marker Plus (Pre Eclampsia + Dual Marker)', 4500, N'DEMOPN4S', N'9606243', 20;

INSERT INTO dbo.tbl_med_mcc_patient_master (mcc_code, initial, name, age, age_type, gender, sample_date, sample_time, ref_doctor_other, mobile_number, addedby, addeddate)
VALUES (@mcc, 'Ms', N'Sana Khan', 24, 1, 2, @drawn, @drawn, 'Self', '9000000015', @by, @regd);
INSERT INTO @p SELECT 5, SCOPE_IDENTITY(), 679, N'HE022', N'Hb Electrophoresis', 1100, N'DEMOPN5E', N'9576657', 49;

/* The order line, and the paid extra that entitles the patient to the booklet. */
INSERT INTO dbo.tbl_med_mcc_patient_tests (patient_id, test_id, test_code, test_name, test_rate, test_type, addedby, addeddate)
SELECT pid, testid, code, tname, rate, 'Test', @by, @regd FROM @p;

INSERT INTO dbo.telo_custom_test_order (bill_id, patient_id, custom_test_id, code, name, unit_amount, qty, mcc_code, created_by)
SELECT 0, pid, 3, N'SMART-RPT', N'Smart Report', 99, 1, @mcc, @by FROM @p;

/* ---- one tube each, modelled on the template tube ---------------------- */
INSERT INTO dbo.tbl_med_mcc_patient_samples
    (patient_id, sampleid, testcodes, testnames, testtypes, vailid, sample_status, addedby, addeddate, modifiedby, modifieddate,
     lastmodified_date, report_type, department_id, business_unit_id, authorised_by, signature_id)
SELECT p.pid, p.sampleid, p.code, p.tname, 't', p.sid, 7, @by, @regd, @by, @regd, @done,
       s.report_type, s.department_id, s.business_unit_id, s.authorised_by, s.signature_id
FROM @p p JOIN dbo.tbl_med_mcc_patient_samples s ON s.vailid = p.tmpl;

/* ---- the values ---------------------------------------------------------
   Keyed on parameter id, which is exact where names carry stray characters.
   Head rows carry no value and are not listed. */
DECLARE @v TABLE (demo TINYINT, paramid INT, value NVARCHAR(400), ab BIT);

-- 1. Priya Sharma, 31, 12+2 weeks: a low-risk double marker.
INSERT INTO @v VALUES
(1,3128,'38.6',0),(1,3127,'2950.4',0),(1,3129,'1.12',0),(1,3126,'0.78',0),
(1,3395,'62.0',0),(1,3396,'NO',0),(1,3397,'SOUTH ASIAN',0),(1,3398,'31-2 YEARS',0),(1,3399,CONVERT(VARCHAR(10), DATEADD(DAY,-4,GETDATE()), 105),0),(1,3400,'12 WEEKS 02 DAYS',0),
(1,3402,'1:722',0),(1,3403,'1:4860',0),(1,3404,'<1:10000 FOR BOTH',0),(1,3405,'LOW RISK FOR TRISOMIES 13, 18 AND 21',0);

-- 2. Neha Gupta, 27, 17+2 weeks: a low-risk triple marker.
INSERT INTO @v VALUES
(2,2684,'SINGLE',0),(2,2686,'58.4',0),(2,2687,'NO',0),(2,2688,'NOT KNOWN',0),(2,2689,'NO',0),(2,2690,'SOUTH ASIAN',0),(2,2691,'27.4',0),
(2,2694,CONVERT(VARCHAR(10), DATEADD(DAY,-5,GETDATE()), 103),0),(2,2695,'17 WEEKS 2 DAYS',0),(2,2696,'-',0),
(2,2698,'42.30',0),(2,2699,'0.88',0),(2,2700,'31240.00',0),(2,2701,'1.21',0),(2,2702,'1.94',0),(2,2703,'0.97',0),
(2,2705,'1:1050',0),(2,2706,'1:3120',0),(2,3384,'< 1:10,000 FOR BOTH',0),(2,2708,'Low risk for trisomies 13,18 and 21',0);

-- 3. Farzana Begum, 36, 19+1 weeks: a quadruple marker SCREEN-POSITIVE for
--    trisomy 21 - high hCG and inhibin A, low uE3 - so the booklet's flag
--    and its advice are seen.
INSERT INTO @v VALUES
(3,2709,'SINGLE',0),(3,2731,'71.5',0),(3,2711,'NO',0),(3,2712,'SOUTH ASIAN',0),
(3,2715,CONVERT(VARCHAR(10), DATEADD(DAY,-5,GETDATE()), 103),0),(3,2716,'19 WEEKS 1 DAY',0),
(3,2718,'48.10',0),(3,2719,'0.91',0),(3,5297,'22.40',1),(3,5298,'2.31',1),(3,2722,'1.42',1),(3,2723,'0.62',1),(3,2724,'412.50',1),(3,2725,'2.08',1),
(3,2727,'1:280',0),(3,2728,'1:95',1),(3,2729,'< 1:10,000 FOR BOTH',0),(3,2730,'HIGH RISK FOR TRISOMY 21 (SCREEN POSITIVE). NIPT OR DIAGNOSTIC TESTING IS ADVISED. LOW RISK FOR TRISOMIES 13 AND 18.',1);

-- 4. Anjali Verma, 29, 12+5 weeks: trisomy risks low, early pre-eclampsia
--    risk raised (low PlGF).
INSERT INTO @v VALUES
(4,3413,'2.410',0),(4,3414,'51.2',0),(4,3415,'18.90',1),
(4,3417,'64.0',0),(4,3418,'NOT DOCUMENTED',0),(4,3419,'NOT DOCUMENTED',0),(4,3420,'NOT DOCUMENTED',0),(4,3421,'SOUTH ASIAN',0),(4,3422,'29.6 YEARS',0),
(4,3424,CONVERT(VARCHAR(10), DATEADD(DAY,-4,GETDATE()), 103),0),(4,3425,'12 WEEKS 5 DAYS',0),
(4,3427,'1 : 850',0),(4,3428,'1 : 9800',0),(4,3429,'< 1 : 20 000 FOR BOTH',0),(4,3430,'1 : 140',1),(4,3431,'1 : 62',0),
(4,3432,'- Low risk for trisomies 13, 18 and 21.' + CHAR(13) + CHAR(10) + '- Increased risk for early-onset Preeclampsia. Low-dose aspirin from before 16 weeks may be considered as per the treating clinician.',1);

-- 5. Sana Khan, 24, a premarital screen: beta-thalassaemia trait - raised
--    HbA2 on microcytic, hypochromic indices.
INSERT INTO @v VALUES
(5,151,'DEMOPN5E',0),(5,137,'10.9',1),(5,136,'35.1',1),(5,142,'5.32',1),(5,141,'66.0',1),(5,139,'20.5',1),(5,140,'31.0',1),(5,144,'15.9',1),
(5,138,'1.2',0),(5,148,'90.1',0),(5,149,'5.4',1),(5,154,'0.0',0),(5,2881,'0.0',0),
(5,152,'- HbA2 raised (5.4%) with microcytic hypochromic red cell indices: findings are suggestive of BETA THALASSAEMIA TRAIT.' + CHAR(13) + CHAR(10) + '- No HbS, HbD or HbE variant detected.',1),
(5,147,'- Partner screening is advised before planning a pregnancy.' + CHAR(13) + CHAR(10) + '- Iron studies to exclude coexisting iron deficiency. Correlate clinically.',0);

/* ---- the result rows: structure from the template, values from above ---- */
INSERT INTO dbo.tbl_med_mcc_patient_test_result
    (patientid, vailid, testid, value, testtype, auth, attachment, hasparameters, normal_range, testcode, testname,
     testnormal_range, testunit, comments, addedby, addeddate, updatedby, updateddate, paramid, profile_id, abnormal,
     mobile_number, master_profile_id, level_id)
SELECT p.pid, p.sid, r.testid,
       CASE WHEN r.testtype IN ('Head', 'Profile') THEN r.value ELSE v.value END,
       r.testtype, 1, 0, r.hasparameters, r.normal_range, r.testcode, r.testname,
       r.testnormal_range, r.testunit, NULL, @by, @regd, @by, @done, r.paramid, r.profile_id,
       ISNULL(v.ab, 0), r.mobile_number, r.master_profile_id, r.level_id
FROM @p p
JOIN dbo.tbl_med_mcc_patient_test_result r ON r.vailid = p.tmpl AND r.testid = p.testid
LEFT JOIN @v v ON v.demo = p.demo AND v.paramid = r.paramid AND r.testtype = 'Param'
ORDER BY p.demo, r.id;

COMMIT;

/* ---- what was written, and any analyte the value list missed ---------- */
SELECT p.demo, p.pid, pt.name, p.tname, p.sid,
       results = (SELECT COUNT(*) FROM dbo.tbl_med_mcc_patient_test_result r WHERE r.patientid = p.pid AND r.testtype = 'Param'),
       unvalued = (SELECT COUNT(*) FROM dbo.tbl_med_mcc_patient_test_result r WHERE r.patientid = p.pid AND r.testtype = 'Param' AND r.value IS NULL),
       flagged = (SELECT COUNT(*) FROM dbo.tbl_med_mcc_patient_test_result r WHERE r.patientid = p.pid AND r.abnormal = 1)
FROM @p p JOIN dbo.tbl_med_mcc_patient_master pt ON pt.id = p.pid ORDER BY p.demo;
GO
