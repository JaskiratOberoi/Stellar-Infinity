SET QUOTED_IDENTIFIER ON;
GO
/*
 * zztest01-smart-mini-fixtures-20260920.sql — eight Smart Report test orders
 * on the lab's throwaway centre ZZTEST01 (mcc 6094), one per "mini profile"
 * the booklet is now sold with at the introductory ₹21 (script 148), so the
 * lab can review what a booklet built for a full health package looks like
 * when the visit was one small profile.
 *
 * Same shape as zztest01-smart-fixture-20260918.sql and for the same
 * reasons: written directly (ZZTEST01 has no rate list so the order
 * procedure will not bill it), no bill pretended (bill_id 0), auth = 1 and
 * patientid set on every result so the booklet has a signatory, and the
 * SMART-RPT line at ₹21 — the price the mini tier books at.
 *
 *   ZZMINI01  ZZ TEST MINI KFT        F 38  Kidney Function Test with Electrolytes
 *   ZZMINI02  ZZ TEST MINI LFT        M 51  Liver Function Test
 *   ZZMINI03  ZZ TEST MINI CBC        F 29  Complete Blood Count
 *   ZZMINI04  ZZ TEST MINI CBC ESR    M 44  CBC with ESR
 *   ZZMINI05  ZZ TEST MINI HBA1C      M 56  Glycated Hemoglobin
 *   ZZMINI06  ZZ TEST MINI IRON       F 33  Iron Profile
 *   ZZMINI07  ZZ TEST MINI VITAMINS   M 40  Vitamin Profile (B12, D)
 *   ZZMINI08  ZZ TEST MINI ANEMIA     F 47  Anemia Profile
 *
 * Each carries a plausible mix of healthy and flagged readings so the
 * chapter, the gauges and the body map all have something to show. The
 * test ids, codes and reference ranges are the catalogue's own for that age
 * and sex. Test orders go on ZZTEST only, never on a live client code.
 *
 * Re-runnable: it clears its own previous rows first. Remove it with
 * zztest01-smart-mini-fixtures-cleanup-20260920.sql.
 */
SET NOCOUNT ON;
SET XACT_ABORT ON;

BEGIN TRAN;

DECLARE @mcc INT = 6094;
DECLARE @who NVARCHAR(50) = N'inf:jas';

/* ── clear our previous rows ─────────────────────────────────────────── */
DECLARE @old TABLE (pid INT);
INSERT INTO @old (pid)
SELECT id FROM dbo.tbl_med_mcc_patient_master WHERE mcc_code = @mcc AND name LIKE N'ZZ TEST MINI %';

DELETE FROM dbo.tbl_med_mcc_patient_test_result WHERE vailid LIKE N'ZZMINI0_';
DELETE FROM dbo.tbl_med_mcc_patient_samples     WHERE vailid LIKE N'ZZMINI0_';
DELETE FROM dbo.telo_custom_test_order          WHERE patient_id IN (SELECT pid FROM @old);
DELETE FROM dbo.tbl_med_mcc_patient_master      WHERE id IN (SELECT pid FROM @old);

/* ── the eight visits ────────────────────────────────────────────────── */
DECLARE @visits TABLE (n INT, sid NVARCHAR(50), name NVARCHAR(100), gender INT, age INT, profile NVARCHAR(200), pid INT NULL);
INSERT INTO @visits (n, sid, name, gender, age, profile) VALUES
    (1, N'ZZMINI01', N'ZZ TEST MINI KFT',      2, 38, N'Kidney Function Test with Electrolytes'),
    (2, N'ZZMINI02', N'ZZ TEST MINI LFT',      1, 51, N'Liver Function Test'),
    (3, N'ZZMINI03', N'ZZ TEST MINI CBC',      2, 29, N'Complete Blood Count (CBC)'),
    (4, N'ZZMINI04', N'ZZ TEST MINI CBC ESR',  1, 44, N'CBC WITH ESR'),
    (5, N'ZZMINI05', N'ZZ TEST MINI HBA1C',    1, 56, N'Glycated Hemoglobin (HBA1c)'),
    (6, N'ZZMINI06', N'ZZ TEST MINI IRON',     2, 33, N'IRON PROFILE'),
    (7, N'ZZMINI07', N'ZZ TEST MINI VITAMINS', 1, 40, N'VITAMIN PROFILE'),
    (8, N'ZZMINI08', N'ZZ TEST MINI ANEMIA',   2, 47, N'Anemia Profile');

DECLARE @n INT = 1, @sid NVARCHAR(50), @name NVARCHAR(100), @gender INT, @age INT, @profile NVARCHAR(200), @pid INT;
WHILE @n <= 8
BEGIN
    SELECT @sid = sid, @name = name, @gender = gender, @age = age, @profile = profile FROM @visits WHERE n = @n;

    INSERT INTO dbo.tbl_med_mcc_patient_master (name, mcc_code, gender, age, age_type, sample_time, addedby)
    VALUES (@name, @mcc, @gender, @age, 1, GETDATE(), @who);
    SET @pid = SCOPE_IDENTITY();
    UPDATE @visits SET pid = @pid WHERE n = @n;

    -- status 7 = Authorized, which is what the reporting list treats as releasable.
    INSERT INTO dbo.tbl_med_mcc_patient_samples
        (vailid, patient_id, sample_status, modifieddate, lastmodified_date, business_unit_id, testnames, testcodes, testtypes, Sample_ClinicalHistory)
    SELECT @sid, @pid, 7, DATEADD(HOUR, -6, GETDATE()), DATEADD(HOUR, -1, GETDATE()), 1, @profile,
           CASE @n WHEN 1 THEN N'CP116' WHEN 2 THEN N'CP107' WHEN 3 THEN N'HE011' WHEN 4 THEN N'CBES1' WHEN 5 THEN N'BI127' WHEN 6 THEN N'GP12' WHEN 7 THEN N'CP143' ELSE N'CP102' END,
           CASE @n WHEN 3 THEN N't' WHEN 5 THEN N't' ELSE N'p' END,
           N'Test sample for the Smart Report mini-profile review.';

    -- The paid extra, at the introductory price. THIS row is what entitles the
    -- patient to the booklet (SmartReportAccessRepository).
    INSERT INTO dbo.telo_custom_test_order
        (bill_id, patient_id, custom_test_id, code, name, unit_amount, qty, mcc_code, created_by)
    VALUES (0, @pid, 3, N'SMART-RPT', N'Smart Report', 21, 1, @mcc, @who);

    SET @n += 1;
END

/* ── results: one row per analyte, auth = 1, patientid set ───────────── */
INSERT INTO dbo.tbl_med_mcc_patient_test_result
    (vailid, patientid, testid, testcode, testname, testtype, value, testunit, testnormal_range, abnormal, auth, updateddate, addedby)
SELECT v.sid, v.pid, r.testid, r.testcode, r.testname, N'Test', r.value, r.testunit, r.testnormal_range, r.abnormal, 1, GETDATE(), @who
FROM (VALUES
    -- 1 ── KFT with electrolytes (F 38): urea and the BUN ratio a little high
    (1, 114, N'BI089', N'Creatinine',                  N'0.9',  N'mg/dL',   N'0.40 - 1.04', 0),
    (1, 172, N'BI224', N'Urea',                        N'48',   N'mg/dL',   N'15 - 45',     1),
    (1, 173, N'BI227', N'Uric acid',                   N'4.8',  N'mg/dL',   N'2.6 - 6.0',   0),
    (1, 157, N'BI205', N'Sodium',                      N'139',  N'mmol/L',  N'135 - 155',   0),
    (1, 297, N'BI174', N'Potassium',                   N'4.2',  N'mmol/L',  N'3.5 - 5.5',   0),
    (1, 101, N'BI074', N'Chloride',                    N'102',  N'mmol/L',  N'97 - 107',    0),
    (1,  96, N'BI064', N'Calcium',                     N'9.1',  N'mg/dL',   N'8.10 - 10.4', 0),
    (1,  90, N'BI056', N'Blood Urea Nitrogen (BUN)',   N'22',   N'mg/dL',   N'8 - 23',      0),
    (1,  91, N'BI057', N'BUN/Creatinine Ratio',        N'24',   N'Ratio',   N'10 - 20',     1),
    -- 2 ── LFT (M 51): a fatty-liver pattern — enzymes and GGT up, bilirubin at the edge
    (2,  87, N'BI046', N'Bilirubin Total',                        N'1.4',  N'mg/dL', N'0.2 - 1.2', 1),
    (2,  87, N'BI046', N'Bilirubin Direct',                       N'0.3',  N'mg/dL', N'0.0 - 0.3', 0),
    (2,  87, N'BI046', N'Bilirubin Indirect',                     N'1.1',  N'mg/dL', N'0.2 - 0.9', 1),
    (2,  81, N'BI040', N'Aspartate Aminotransferase (AST/SGOT)',  N'52',   N'U/L',   N'< 45',      1),
    (2,  79, N'BI014', N'Alanine amino Transferase - (ALT / SGPT)', N'68', N'U/L',   N'< 45',      1),
    (2, 279, N'BI023', N'Alkaline Phosphatase (ALP)',             N'88',   N'U/L',   N'46 - 116',  0),
    (2, 130, N'BI112', N'Gamma Glutamyl Transferase (GGT)',       N'41',   N'U/L',   N'< 38',      1),
    (2, 163, N'BI213', N'Protein Total',                          N'7.1',  N'g/dL',  N'6.4 - 8.3', 0),
    (2, 163, N'BI213', N'Albumin',                                N'4.3',  N'g/dL',  N'3.5 - 5.2', 0),
    (2, 163, N'BI213', N'Globulin',                               N'2.8',  N'g/dL',  N'2.0 - 3.5', 0),
    (2, 163, N'BI213', N'Albumin/Globulin Ratio',                 N'1.5',  N'Ratio', N'1.0 - 2.0', 0),
    -- 3 ── CBC (F 29): microcytic picture — low haemoglobin, small pale cells
    (3, 233, N'HE011', N'Hemoglobin',              N'10.8', N'g/dL',      N'12.0 - 15.0', 1),
    (3, 233, N'HE011', N'RBC Count',               N'4.1',  N'10^6/µL',   N'3.8 - 4.8',   0),
    (3, 233, N'HE011', N'Hematocrit',              N'33',   N'%',         N'36 - 46',     1),
    (3, 233, N'HE011', N'MCV',                     N'78',   N'fL',        N'80 - 100',    1),
    (3, 233, N'HE011', N'MCH',                     N'26',   N'pg',        N'27 - 32',     1),
    (3, 233, N'HE011', N'MCHC',                    N'32.5', N'g/dL',      N'31.5 - 34.5', 0),
    (3, 233, N'HE011', N'RDW-CV',                  N'15.8', N'%',         N'11.5 - 14.5', 1),
    (3, 233, N'HE011', N'Total Leukocyte Count',   N'7.2',  N'x1000/µL',  N'4.0 - 11.0',  0),
    (3, 233, N'HE011', N'Neutrophils',             N'58',   N'%',         N'40 - 75',     0),
    (3, 233, N'HE011', N'Lymphocytes',             N'33',   N'%',         N'20 - 45',     0),
    (3, 233, N'HE011', N'Monocytes',               N'6',    N'%',         N'2 - 10',      0),
    (3, 233, N'HE011', N'Eosinophils',             N'2.5',  N'%',         N'1 - 6',       0),
    (3, 233, N'HE011', N'Basophils',               N'0.5',  N'%',         N'0 - 1',       0),
    (3, 233, N'HE011', N'Platelet Count',          N'262',  N'10^3/µL',   N'150 - 450',   0),
    -- 4 ── CBC with ESR (M 44): a healthy count, ESR raised
    (4, 233, N'HE011', N'Hemoglobin',              N'14.6', N'g/dL',      N'13.0 - 17.0', 0),
    (4, 233, N'HE011', N'RBC Count',               N'4.9',  N'10^6/µL',   N'4.5 - 5.5',   0),
    (4, 233, N'HE011', N'Hematocrit',              N'43',   N'%',         N'40 - 50',     0),
    (4, 233, N'HE011', N'MCV',                     N'88',   N'fL',        N'80 - 100',    0),
    (4, 233, N'HE011', N'MCH',                     N'29.8', N'pg',        N'27 - 32',     0),
    (4, 233, N'HE011', N'MCHC',                    N'33.9', N'g/dL',      N'31.5 - 34.5', 0),
    (4, 233, N'HE011', N'RDW-CV',                  N'13.1', N'%',         N'11.5 - 14.5', 0),
    (4, 233, N'HE011', N'Total Leukocyte Count',   N'9.4',  N'x1000/µL',  N'4.0 - 11.0',  0),
    (4, 233, N'HE011', N'Neutrophils',             N'66',   N'%',         N'40 - 75',     0),
    (4, 233, N'HE011', N'Lymphocytes',             N'25',   N'%',         N'20 - 45',     0),
    (4, 233, N'HE011', N'Monocytes',               N'6',    N'%',         N'2 - 10',      0),
    (4, 233, N'HE011', N'Eosinophils',             N'2.5',  N'%',         N'1 - 6',       0),
    (4, 233, N'HE011', N'Basophils',               N'0.5',  N'%',         N'0 - 1',       0),
    (4, 233, N'HE011', N'Platelet Count',          N'318',  N'10^3/µL',   N'150 - 450',   0),
    (4, 268, N'HE017', N'Erythrocyte Sedimentation Rate (ESR)', N'28', N'mm/1st hr', N'0 - 15', 1),
    -- 5 ── HbA1c (M 56): in the diabetic range
    (5, 291, N'BI127', N'Glycated Hemoglobin (HBA1c)', N'7.2', N'%',     N'4.0 - 5.6', 1),
    (5, 291, N'BI127', N'Estimated Average Glucose',  N'160', N'mg/dL', N'68 - 114',  1),
    -- 6 ── Iron profile (F 33): iron deficiency
    (6, 135, N'BI137', N'Iron',                                    N'38',  N'ug/dL', N'50 - 170',  1),
    (6, 252, N'BI222', N'Unsaturated Iron Binding Capacity (UIBC)', N'380', N'ug/dL', N'110 - 370', 1),
    (6, 136, N'BI138', N'Iron Binding Capacity - Total (TIBC)',    N'418', N'ug/dL', N'250 - 450', 0),
    (6, 167, N'BI217', N'Transferrin Saturation',                  N'9',   N'%',     N'20 - 50',   1),
    -- 7 ── Vitamin profile (M 40): both low
    (7, 175, N'BI235', N'Vitamin B12',  N'165', N'pg/mL', N'180 - 914', 1),
    (7,  74, N'BI005', N'VITAMIN D',    N'18',  N'ng/mL', N'30 - 100',  1),
    -- 8 ── Anemia profile (F 47): iron-deficiency anaemia across both tubes
    (8, 123, N'BI104', N'Ferritin',                             N'8',    N'ng/mL',    N'10 - 291',    1),
    (8, 135, N'BI137', N'Iron',                                 N'41',   N'ug/dL',    N'50 - 170',    1),
    (8, 136, N'BI138', N'Iron Binding Capacity - Total (TIBC)', N'445',  N'ug/dL',    N'250 - 450',   0),
    (8, 175, N'BI235', N'Vitamin B12',                          N'320',  N'pg/mL',    N'180 - 914',   0),
    (8, 124, N'BI105', N'Folate',                               N'6.2',  N'ng/mL',    N'1.5 - 19.5',  0),
    (8, 167, N'BI217', N'Transferrin Saturation',               N'9',    N'%',        N'20 - 50',     1),
    (8, 233, N'HE011', N'Hemoglobin',                           N'10.2', N'g/dL',     N'12.0 - 15.0', 1),
    (8, 233, N'HE011', N'MCV',                                  N'76',   N'fL',       N'80 - 100',    1),
    (8, 233, N'HE011', N'RDW-CV',                               N'16.0', N'%',        N'11.5 - 14.5', 1),
    (8, 233, N'HE011', N'Total Leukocyte Count',                N'6.8',  N'x1000/µL', N'4.0 - 11.0',  0),
    (8, 233, N'HE011', N'Platelet Count',                       N'310',  N'10^3/µL',  N'150 - 450',   0)
) r (n, testid, testcode, testname, value, testunit, testnormal_range, abnormal)
JOIN @visits v ON v.n = r.n;

COMMIT;

SELECT v.sid, v.pid, v.name, v.profile,
       results = (SELECT COUNT(*) FROM dbo.tbl_med_mcc_patient_test_result r WHERE r.vailid = v.sid),
       flagged = (SELECT COUNT(*) FROM dbo.tbl_med_mcc_patient_test_result r WHERE r.vailid = v.sid AND r.abnormal = 1)
FROM @visits v ORDER BY v.n;
GO
