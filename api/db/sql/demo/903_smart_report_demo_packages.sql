SET QUOTED_IDENTIFIER ON;
GO
/*
 * 903_smart_report_demo_packages.sql — DEMO DATA. Not part of the schema.
 *
 * Three patients under ZZTEST01 (mcc 6094, the Smart Report test centre),
 * one each on Health Package 1, 2 and 3, with a full set of authorised
 * results and the SMART-RPT entitlement, so the booklet can be shown on the
 * packages a centre actually sells. Numbered 900+ and kept in this folder so
 * a "run every file" deploy of the real migrations never picks it up.
 *
 * ── HOW THE ROWS ARE BUILT ────────────────────────────────────────────────
 * The result rows are cloned, STRUCTURE ONLY, from real recent orders of the
 * same packages: test ids, parameter ids, codes, names, units, the frozen
 * reference ranges, profile links, the coded-option lists — everything that
 * makes a report print the way a real one does. The VALUES are authored
 * below, per patient, as a coherent clinical picture; nothing a real patient
 * measured is copied. Package 3 has had no complete order recently, so its
 * serum tube is assembled from the profiles and tests it is made of, each
 * from a real order that carried it.
 *
 * Written directly rather than through usp_telo_create_order, for the reason
 * 901 gives: the ordering procedure bills, and a demo must not pretend a bill
 * into existence. The order line and the entitlement row are written so the
 * lists name the package and the booklet opens; no bill is.
 *
 * Re-runnable: it removes its own previous rows first (everything under
 * mcc 6094 added by inf:demo-hp). Remove it for good with 904.
 */
SET NOCOUNT ON;
SET XACT_ABORT ON;

BEGIN TRAN;

DECLARE @mcc INT = 6094;
DECLARE @by  NVARCHAR(50) = N'inf:demo-hp';
DECLARE @drawn DATETIME = DATEADD(MINUTE, 15, DATEADD(HOUR, 8, CONVERT(DATETIME, CONVERT(DATE, DATEADD(DAY, -2, GETDATE())))));
DECLARE @regd  DATETIME = DATEADD(HOUR, 2, @drawn);
DECLARE @done  DATETIME = DATEADD(HOUR, 9, @drawn);

/* ---- clear the previous run ------------------------------------------- */
DECLARE @old TABLE (pid INT);
INSERT INTO @old (pid) SELECT id FROM dbo.tbl_med_mcc_patient_master WHERE mcc_code = @mcc AND addedby = @by;
DELETE FROM dbo.tbl_med_mcc_patient_test_result WHERE vailid IN (SELECT vailid FROM dbo.tbl_med_mcc_patient_samples WHERE patient_id IN (SELECT pid FROM @old));
DELETE FROM dbo.tbl_med_mcc_patient_samples     WHERE patient_id IN (SELECT pid FROM @old);
DELETE FROM dbo.telo_custom_test_order          WHERE patient_id IN (SELECT pid FROM @old);
DELETE FROM dbo.tbl_med_mcc_patient_tests       WHERE patient_id IN (SELECT pid FROM @old);
DELETE FROM dbo.tbl_med_mcc_patient_master      WHERE id IN (SELECT pid FROM @old);

/* ---- the three patients ------------------------------------------------ */
DECLARE @p TABLE (demo TINYINT, pid INT, pkg INT, code NVARCHAR(50), pkgname NVARCHAR(100), rate INT);

INSERT INTO dbo.tbl_med_mcc_patient_master
    (mcc_code, initial, name, age, age_type, gender, sample_date, sample_time, ref_doctor_other, mobile_number, addedby, addeddate)
VALUES (@mcc, 'Mr', N'Rajesh Kumar Verma', 46, 1, 1, @drawn, @drawn, 'Dr. Anil Khanna MD', '9000000001', @by, @regd);
INSERT INTO @p SELECT 1, SCOPE_IDENTITY(), 187, N'HPK01', N'Health Package 1', 1199;

INSERT INTO dbo.tbl_med_mcc_patient_master
    (mcc_code, initial, name, age, age_type, gender, sample_date, sample_time, ref_doctor_other, mobile_number, addedby, addeddate)
VALUES (@mcc, 'Mrs', N'Sunita Agarwal', 52, 1, 2, @drawn, @drawn, 'Self', '9000000002', @by, @regd);
INSERT INTO @p SELECT 2, SCOPE_IDENTITY(), 190, N'HPK002', N'Health Package 2', 3000;

INSERT INTO dbo.tbl_med_mcc_patient_master
    (mcc_code, initial, name, age, age_type, gender, sample_date, sample_time, ref_doctor_other, mobile_number, addedby, addeddate)
VALUES (@mcc, 'Mr', N'Arjun Mehta', 34, 1, 1, @drawn, @drawn, 'Dr. Priya Nair MBBS', '9000000003', @by, @regd);
INSERT INTO @p SELECT 3, SCOPE_IDENTITY(), 197, N'HPK003', N'HEALTH PACKAGE 3', 2200;

/* The order line, so the lists name the package; and the paid extra — THIS
   row is what entitles the patient to the booklet (SmartReportAccessRepository). */
INSERT INTO dbo.tbl_med_mcc_patient_tests (patient_id, test_id, test_code, test_name, test_rate, test_type, addedby, addeddate)
SELECT pid, pkg, code, pkgname, rate, 'Master', @by, @regd FROM @p;

INSERT INTO dbo.telo_custom_test_order (bill_id, patient_id, custom_test_id, code, name, unit_amount, qty, mcc_code, created_by)
SELECT 0, pid, 3, N'SMART-RPT', N'Smart Report', 99, 1, @mcc, @by FROM @p;

/* ---- the tubes, and which real tube each is modelled on ---------------- */
-- P1: patient 3693738 (male, Health Package 1, 17/09/2026). P2: patient 3695107
-- (female, Health Package 2, 17/09/2026). P3 is composed: its serum takes the
-- lipid, liver and iron profiles from P1's serum, Kidney Functions Test MD
-- from SID 9334686, vitamin D and B12 from P2's serum, and testosterone from
-- SID 8340626; its other tubes are P1's.
DECLARE @tube TABLE (demo TINYINT, sid NVARCHAR(50), tmpl NVARCHAR(50), ord INT,
                     codes VARCHAR(1000) NULL, names VARCHAR(1000) NULL, types VARCHAR(500) NULL);
INSERT INTO @tube (demo, sid, tmpl, ord) VALUES
    (1, N'DEMOHP1S', N'9479777', 1), (1, N'DEMOHP1E', N'9479779', 2), (1, N'DEMOHP1U', N'9479778', 3), (1, N'DEMOHP1F', N'9479776', 4),
    (2, N'DEMOHP2S', N'8686516', 1), (2, N'DEMOHP2E', N'8686518', 2), (2, N'DEMOHP2U', N'8686517', 3), (2, N'DEMOHP2F', N'8686515', 4),
    (3, N'DEMOHP3E', N'9479779', 2), (3, N'DEMOHP3U', N'9479778', 3), (3, N'DEMOHP3F', N'9479776', 4);
INSERT INTO @tube (demo, sid, tmpl, ord, codes, names, types) VALUES
    (3, N'DEMOHP3S', N'9479777', 1,
     'CP106,CP107,GP12,KFTMD,BI005,BI235,BI209',
     'LIPID PROFILE,Liver Function Test,IRON PROFILE,Kidney Functions Test MD,VITAMIN D,Vitamin B12  -Serum,Testosterone  - Total',
     'mp,mp,mp,mp,mt,mt,mt');

INSERT INTO dbo.tbl_med_mcc_patient_samples
    (patient_id, sampleid, testcodes, testnames, testtypes, vailid, sample_status, addedby, addeddate, modifiedby, modifieddate,
     lastmodified_date, report_type, department_id, business_unit_id, authorised_by, signature_id)
SELECT p.pid, s.sampleid, ISNULL(t.codes, s.testcodes), ISNULL(t.names, s.testnames), ISNULL(t.types, s.testtypes),
       t.sid, 7, @by, @regd, @by, @regd, @done, s.report_type, s.department_id, s.business_unit_id, s.authorised_by, s.signature_id
FROM @tube t
JOIN @p p ON p.demo = t.demo
JOIN dbo.tbl_med_mcc_patient_samples s ON s.vailid = t.tmpl;

/* ---- which template rows feed which demo tube -------------------------- */
-- A source row: every row of the template tube, or only the rows of the
-- listed profiles / tests. Applied in `seq` order so a composed tube prints
-- its sections in the order given.
DECLARE @src TABLE (demo TINYINT, sid NVARCHAR(50), tmpl NVARCHAR(50), seq INT, profiles VARCHAR(50) NULL, tests VARCHAR(50) NULL);
INSERT INTO @src (demo, sid, tmpl, seq) SELECT demo, sid, tmpl, 1 FROM @tube WHERE NOT (demo = 3 AND sid = N'DEMOHP3S');
INSERT INTO @src (demo, sid, tmpl, seq, profiles, tests) VALUES
    (3, N'DEMOHP3S', N'9479777', 1, '7,8,25', NULL),
    (3, N'DEMOHP3S', N'9334686', 2, '102',    NULL),
    (3, N'DEMOHP3S', N'8686516', 3, NULL,     '74,175'),
    (3, N'DEMOHP3S', N'8340626', 4, NULL,     '158');

/* ---- the values, per patient -------------------------------------------
   Keyed on test code and name (spacing collapsed). Head and Profile rows
   carry no value and are not listed. */
DECLARE @v TABLE (demo TINYINT, code VARCHAR(20), name NVARCHAR(200), value NVARCHAR(60), ab BIT);

-- 1. Mr Rajesh Kumar Verma, 46: mild dyslipidaemia, HbA1c in the pre-diabetic
--    band with a fasting glucose to match, a slightly raised ALT; the rest well.
INSERT INTO @v VALUES
(1,'BI114','Glucose - Fasting','112',1),
(1,'BI214','T3 (Tri Iodothyronine )','1.12',0),(1,'BI215','T4 (Thyroxine )','8.4',0),(1,'BI221','Thyroid Stimulating Hormone (TSH) , ULTRASENSITIVE','2.85',0),
(1,'BI079','Cholesterol - Total','226',1),(1,'BI218','Triglycerides','188',1),(1,'BI077','Cholesterol - HDL','41',0),(1,'BI078','Cholesterol - LDL DIRECT','148',1),
(1,'BI1291','VLDL Cholesterol','37.6',1),(1,'BINHC01','Non HDL Cholesterol','185',1),(1,'BI255','Total Cholesterol / HdL','5.5',1),
(1,'BIHDLDR01','HDL/LDL Cholesterol Ratio','0.28',0),(1,'BI1711','LDL/ HDL CHOLESTEROL RATIO','3.6',1),
(1,'BI046','Bilirubin Total','0.9',0),(1,'BI046','Bilirubin Conjugated','0.22',0),(1,'BI046','Bilirubin Unconjugated Indirect','0.68',0),
(1,'BI040','Aspartate Aminotransferase (AST/SGOT)','38',0),(1,'BI014','Alanine amino Transferase - (ALT / SGPT)','52',1),
(1,'BI023','Alkaline Phosphatase (ALP)','84',0),(1,'BI112','Gamma Glutamyl Transferase (GGT)','48',0),
(1,'BI213','Protein Total Serum','7.2',0),(1,'BI213','Albumin - Serum','4.3',0),(1,'BI213','Globulin','2.9',0),(1,'BI213','A/G (Albumin/Globulin) Ratio','1.48',0),
(1,'BI00012','SGOT/SGPT Ratio','0.73',0),
(1,'BI137','Iron','92',0),(1,'BI222','Unsaturated Iron Binding Capacity (UIBC)','210',0),(1,'BI138','Iron Binding Capacity - Total (TIBC)','302',0),(1,'BI217','Transferrin Saturation','30.5',0),
(1,'BI056','Blood Urea Nitrogen (BUN)','14',0),(1,'BI057','BUN/Creatinine Ratio','15.6',0),(1,'BI064','Calcium','9.4',0),(1,'BI089','Creatinine','0.9',0),
(1,'BI099','Creatinine','0.9',0),(1,'BI099','GFR-e ( Glomerular Filtration Rate - Estimated)','98',0),
(1,'BI205','Sodium','140',0),(1,'BI224','Urea','30',0),(1,'BI227','Uric acid','6.8',0),(1,'BI174','Potassium','4.4',0),
(1,'CP004','Volume','30 ML',0),(1,'CP004','Colour','PALE YELLOW',0),(1,'CP004','Appearance','CLEAR',0),(1,'CP004','pH','6.0',0),(1,'CP004','Specific Gravity','1.015',0),
(1,'CP004','Protein','NEGATIVE',0),(1,'CP004','Glucose','NEGATIVE',0),(1,'CP004','Ketones','NEGATIVE',0),(1,'CP004','Blood','NEGATIVE',0),
(1,'CP004','Urobilinogen','NORMAL',0),(1,'CP004','Nitrite','NEGATIVE',0),(1,'CP004','Bilirubin','NEGATIVE',0),
(1,'CP004','Pus Cells','1-2',0),(1,'CP004','Epithelial Cells','1-2',0),(1,'CP004','RBCs','NIL',0),(1,'CP004','Casts','NIL',0),(1,'CP004','Crystals','NIL',0),(1,'CP004','Others','NIL',0),
(1,'HE011','Hemoglobin','14.8',0),(1,'HE011','RBC Count','5.1',0),(1,'HE011','Total Leukocyte Count','7.2',0),(1,'HE011','Hematocrit','44.6',0),
(1,'HE011','MCV','87.5',0),(1,'HE011','MCH','29.0',0),(1,'HE011','MCHC','33.2',0),(1,'HE011','RDW-CV','13.1',0),(1,'HE011','Platelet Count','242',0),
(1,'HE011','Neutrophils %','58',0),(1,'HE011','Lymphocytes %','32',0),(1,'HE011','Monocytes %','6',0),(1,'HE011','Eosinophils %','3',0),(1,'HE011','Basophils %','1',0),
(1,'HE011','Absolute Neutrophil Count','4.18',0),(1,'HE011','Absolute Lymphocyte Count','2.30',0),(1,'HE011','Absolute Monocyte Count','0.43',0),
(1,'HE011','Absolute Eosinophil Count','0.22',0),(1,'HE011','Absolute Basophil Count','0.07',0),
(1,'HE017','Erythrocyte Sedimentation Rate (Westergren''s Method/Automated)','8',0),
(1,'BI127','Glycated Hemoglobin HbA1c','6.1',1),(1,'BI127','Estimated Average Glucose (eAG)','128.4',0);

-- 2. Mrs Sunita Agarwal, 52: an under-active thyroid, iron-deficiency
--    anaemia with the smear indices to match, low vitamin D and B12, a raised
--    ESR; lipids and kidneys fine, no microalbumin, RA factor negative.
INSERT INTO @v VALUES
(2,'BI114','Glucose - Fasting','96',0),
(2,'BI214','T3 (Tri Iodothyronine )','0.82',0),(2,'BI215','T4 (Thyroxine )','5.1',0),(2,'BI221','Thyroid Stimulating Hormone (TSH) , ULTRASENSITIVE','9.40',1),
(2,'BI079','Cholesterol - Total','198',0),(2,'BI218','Triglycerides','142',0),(2,'BI077','Cholesterol - HDL','52',0),(2,'BI078','Cholesterol - LDL DIRECT','118',1),
(2,'BI1291','VLDL Cholesterol','28.4',0),(2,'BINHC01','Non HDL Cholesterol','146',1),(2,'BI255','Total Cholesterol / HdL','3.8',0),
(2,'BIHDLDR01','HDL/LDL Cholesterol Ratio','0.44',0),(2,'BI1711','LDL/ HDL CHOLESTEROL RATIO','2.3',0),
(2,'BI046','Bilirubin Total','0.6',0),(2,'BI046','Bilirubin Conjugated','0.15',0),(2,'BI046','Bilirubin Unconjugated Indirect','0.45',0),
(2,'BI040','Aspartate Aminotransferase (AST/SGOT)','24',0),(2,'BI014','Alanine amino Transferase - (ALT / SGPT)','21',0),
(2,'BI023','Alkaline Phosphatase (ALP)','92',0),(2,'BI112','Gamma Glutamyl Transferase (GGT)','22',0),
(2,'BI213','Protein Total Serum','7.0',0),(2,'BI213','Albumin - Serum','4.1',0),(2,'BI213','Globulin','2.9',0),(2,'BI213','A/G (Albumin/Globulin) Ratio','1.41',0),
(2,'BI00012','SGOT/SGPT Ratio','1.14',0),
(2,'BI137','Iron','38',1),(2,'BI222','Unsaturated Iron Binding Capacity (UIBC)','342',0),(2,'BI138','Iron Binding Capacity - Total (TIBC)','380',0),(2,'BI217','Transferrin Saturation','10.0',1),
(2,'BI056','Blood Urea Nitrogen (BUN)','11',0),(2,'BI057','BUN/Creatinine Ratio','15.7',0),(2,'BI064','Calcium','9.1',0),(2,'BI089','Creatinine','0.7',0),
(2,'BI099','Creatinine','0.7',0),(2,'BI099','GFR-e ( Glomerular Filtration Rate - Estimated)','102',0),
(2,'BI205','Sodium','138',0),(2,'BI224','Urea','24',0),(2,'BI227','Uric acid','4.6',0),(2,'BI174','Potassium','4.1',0),
(2,'CP004','Volume','40 ML',0),(2,'CP004','Colour','PALE YELLOW',0),(2,'CP004','Appearance','CLEAR',0),(2,'CP004','pH','6.5',0),(2,'CP004','Specific Gravity','1.010',0),
(2,'CP004','Protein','NEGATIVE',0),(2,'CP004','Glucose','NEGATIVE',0),(2,'CP004','Ketones','NEGATIVE',0),(2,'CP004','Blood','NEGATIVE',0),
(2,'CP004','Urobilinogen','NORMAL',0),(2,'CP004','Nitrite','NEGATIVE',0),(2,'CP004','Bilirubin','NEGATIVE',0),
(2,'CP004','Pus Cells','2-3',0),(2,'CP004','Epithelial Cells','2-3',0),(2,'CP004','RBCs','NIL',0),(2,'CP004','Casts','NIL',0),(2,'CP004','Crystals','NIL',0),(2,'CP004','Others','NIL',0),
(2,'B2043','Albumin/Microalbumin in Urine','12',0),(2,'B2043','Creatinine Urine by Jaffe Method','95',0),(2,'B2043','Albumin-Microalb/Creatine Ratio','12.6',0),
(2,'HE011','Hemoglobin','10.8',1),(2,'HE011','RBC Count','4.2',0),(2,'HE011','Total Leukocyte Count','6.4',0),(2,'HE011','Hematocrit','34.2',1),
(2,'HE011','MCV','76.4',1),(2,'HE011','MCH','25.7',1),(2,'HE011','MCHC','31.6',0),(2,'HE011','RDW-CV','16.2',1),(2,'HE011','Platelet Count','318',0),
(2,'HE011','Neutrophils %','55',0),(2,'HE011','Lymphocytes %','36',0),(2,'HE011','Monocytes %','5',0),(2,'HE011','Eosinophils %','3',0),(2,'HE011','Basophils %','1',0),
(2,'HE011','Absolute Neutrophil Count','3.52',0),(2,'HE011','Absolute Lymphocyte Count','2.30',0),(2,'HE011','Absolute Monocyte Count','0.32',0),
(2,'HE011','Absolute Eosinophil Count','0.19',0),(2,'HE011','Absolute Basophil Count','0.06',0),
(2,'HE017','Erythrocyte Sedimentation Rate (Westergren''s Method/Automated)','22',1),
(2,'BI127','Glycated Hemoglobin HbA1c','5.5',0),(2,'BI127','Estimated Average Glucose (eAG)','111.2',0),
(2,'BI005','VITAMIN D','14.2',1),(2,'MS024','C-Reactive Protein (CRP)','3.1',0),(2,'BI235','Vitamin B12','162',1),(2,'MS111','Rheumatoid Arthritis Factor (Nephelometry)','9.8',0);

-- 3. Mr Arjun Mehta, 34: well, with an LDL just over optimal, vitamin D in the
--    insufficient band and a low-normal testosterone.
INSERT INTO @v VALUES
(3,'BI114','Glucose - Fasting','88',0),
(3,'BI079','Cholesterol - Total','172',0),(3,'BI218','Triglycerides','96',0),(3,'BI077','Cholesterol - HDL','48',0),(3,'BI078','Cholesterol - LDL DIRECT','104',1),
(3,'BI1291','VLDL Cholesterol','19.2',0),(3,'BINHC01','Non HDL Cholesterol','124',0),(3,'BI255','Total Cholesterol / HdL','3.6',0),
(3,'BIHDLDR01','HDL/LDL Cholesterol Ratio','0.46',0),(3,'BI1711','LDL/ HDL CHOLESTEROL RATIO','2.2',0),
(3,'BI046','Bilirubin Total','0.7',0),(3,'BI046','Bilirubin Conjugated','0.18',0),(3,'BI046','Bilirubin Unconjugated Indirect','0.52',0),
(3,'BI040','Aspartate Aminotransferase (AST/SGOT)','26',0),(3,'BI014','Alanine amino Transferase - (ALT / SGPT)','31',0),
(3,'BI023','Alkaline Phosphatase (ALP)','71',0),(3,'BI112','Gamma Glutamyl Transferase (GGT)','27',0),
(3,'BI213','Protein Total Serum','7.4',0),(3,'BI213','Albumin - Serum','4.6',0),(3,'BI213','Globulin','2.8',0),(3,'BI213','A/G (Albumin/Globulin) Ratio','1.64',0),
(3,'BI00012','SGOT/SGPT Ratio','0.84',0),
(3,'BI137','Iron','104',0),(3,'BI222','Unsaturated Iron Binding Capacity (UIBC)','198',0),(3,'BI138','Iron Binding Capacity - Total (TIBC)','302',0),(3,'BI217','Transferrin Saturation','34.4',0),
(3,'BI224','Urea','26',0),(3,'BI089','Creatinine','1.0',0),(3,'BI186','Total Protein','7.4',0),(3,'BI019','Albumin','4.6',0),(3,'BI253','Globulin','2.8',0),
(3,'BI020','Albumin/Globulin Ratio','1.64',0),(3,'BI205','Sodium','141',0),(3,'BI174','Potassium','4.3',0),(3,'BI074','Chloride - Serum','102',0),
(3,'BI227','Uric acid','6.2',0),(3,'BI064','Calcium','9.6',0),
(3,'BI005','VITAMIN D','18.6',1),(3,'BI235','Vitamin B12','412',0),(3,'BI209','Testosterone Total','286',0),
(3,'CP004','Volume','35 ML',0),(3,'CP004','Colour','PALE YELLOW',0),(3,'CP004','Appearance','CLEAR',0),(3,'CP004','pH','6.0',0),(3,'CP004','Specific Gravity','1.020',0),
(3,'CP004','Protein','NEGATIVE',0),(3,'CP004','Glucose','NEGATIVE',0),(3,'CP004','Ketones','NEGATIVE',0),(3,'CP004','Blood','NEGATIVE',0),
(3,'CP004','Urobilinogen','NORMAL',0),(3,'CP004','Nitrite','NEGATIVE',0),(3,'CP004','Bilirubin','NEGATIVE',0),
(3,'CP004','Pus Cells','0-1',0),(3,'CP004','Epithelial Cells','0-1',0),(3,'CP004','RBCs','NIL',0),(3,'CP004','Casts','NIL',0),(3,'CP004','Crystals','NIL',0),(3,'CP004','Others','NIL',0),
(3,'HE011','Hemoglobin','15.4',0),(3,'HE011','RBC Count','5.3',0),(3,'HE011','Total Leukocyte Count','6.8',0),(3,'HE011','Hematocrit','46.1',0),
(3,'HE011','MCV','87.0',0),(3,'HE011','MCH','29.1',0),(3,'HE011','MCHC','33.4',0),(3,'HE011','RDW-CV','12.8',0),(3,'HE011','Platelet Count','265',0),
(3,'HE011','Neutrophils %','60',0),(3,'HE011','Lymphocytes %','30',0),(3,'HE011','Monocytes %','6',0),(3,'HE011','Eosinophils %','3',0),(3,'HE011','Basophils %','1',0),
(3,'HE011','Absolute Neutrophil Count','4.08',0),(3,'HE011','Absolute Lymphocyte Count','2.04',0),(3,'HE011','Absolute Monocyte Count','0.41',0),
(3,'HE011','Absolute Eosinophil Count','0.20',0),(3,'HE011','Absolute Basophil Count','0.07',0),
(3,'HE017','Erythrocyte Sedimentation Rate (Westergren''s Method/Automated)','4',0),
(3,'BI127','Glycated Hemoglobin HbA1c','5.2',0),(3,'BI127','Estimated Average Glucose (eAG)','102.5',0);

/* ---- the result rows: structure from the template, values from above ---- */
DECLARE @i INT = 1, @n INT = (SELECT COUNT(*) FROM @src);
DECLARE @s TABLE (rn INT, demo TINYINT, sid NVARCHAR(50), tmpl NVARCHAR(50), profiles VARCHAR(50), tests VARCHAR(50));
INSERT INTO @s SELECT ROW_NUMBER() OVER (ORDER BY demo, sid, seq), demo, sid, tmpl, profiles, tests FROM @src;

WHILE @i <= @n
BEGIN
    DECLARE @demo TINYINT, @sid NVARCHAR(50), @tmpl NVARCHAR(50), @profiles VARCHAR(50), @tests VARCHAR(50), @pid INT;
    SELECT @demo = demo, @sid = sid, @tmpl = tmpl, @profiles = profiles, @tests = tests FROM @s WHERE rn = @i;
    SELECT @pid = pid FROM @p WHERE demo = @demo;

    INSERT INTO dbo.tbl_med_mcc_patient_test_result
        (patientid, vailid, testid, value, testtype, auth, attachment, hasparameters, normal_range, testcode, testname,
         testnormal_range, testunit, comments, addedby, addeddate, updatedby, updateddate, paramid, profile_id, abnormal,
         mobile_number, master_profile_id, level_id)
    SELECT @pid, @sid, r.testid,
           CASE WHEN r.testtype IN ('Head', 'Profile') THEN r.value ELSE v.value END,
           r.testtype, 1, 0, r.hasparameters, r.normal_range, r.testcode, r.testname,
           r.testnormal_range, r.testunit, NULL, @by, @regd, @by, @done, r.paramid, r.profile_id,
           ISNULL(v.ab, 0), r.mobile_number, r.master_profile_id, r.level_id
    FROM dbo.tbl_med_mcc_patient_test_result r
    OUTER APPLY (
        SELECT TOP 1 value, ab FROM @v
        WHERE demo = @demo AND code = r.testcode
          AND REPLACE(REPLACE(REPLACE(name, '  ', ' '), '  ', ' '), '  ', ' ')
            = REPLACE(REPLACE(REPLACE(LTRIM(RTRIM(r.testname)), '  ', ' '), '  ', ' '), '  ', ' ')
    ) v
    WHERE r.vailid = @tmpl
      AND (
            (@profiles IS NULL AND @tests IS NULL)
            OR (@profiles IS NOT NULL AND r.profile_id IN (SELECT TRY_CONVERT(INT, value) FROM STRING_SPLIT(@profiles, ',')))
            OR (@tests IS NOT NULL AND r.profile_id IS NULL AND r.testid IN (SELECT TRY_CONVERT(INT, value) FROM STRING_SPLIT(@tests, ',')))
          )
    ORDER BY r.id;

    SET @i += 1;
END

COMMIT;

/* ---- what was written, and any analyte the value list missed ---------- */
SELECT p.demo, p.pid, p.pkgname, pt.name, tubes = (SELECT COUNT(*) FROM dbo.tbl_med_mcc_patient_samples s WHERE s.patient_id = p.pid),
       results = (SELECT COUNT(*) FROM dbo.tbl_med_mcc_patient_test_result r WHERE r.patientid = p.pid),
       flagged = (SELECT COUNT(*) FROM dbo.tbl_med_mcc_patient_test_result r WHERE r.patientid = p.pid AND r.abnormal = 1)
FROM @p p JOIN dbo.tbl_med_mcc_patient_master pt ON pt.id = p.pid ORDER BY p.demo;

SELECT missing_demo = p.demo, r.vailid, r.testcode, r.testname
FROM dbo.tbl_med_mcc_patient_test_result r JOIN @p p ON p.pid = r.patientid
WHERE r.testtype IN ('Test', 'Param') AND r.value IS NULL
ORDER BY p.demo, r.id;
GO
