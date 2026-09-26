SET QUOTED_IDENTIFIER ON;
GO
/*
 * zztest01-smart-kashmir-fixtures-20260926.sql - eighteen Smart Report review
 * orders on the throwaway centre ZZTEST01 (mcc 6094) for the single tests and
 * small profiles scripts 166/167 added: AMH, LH, FSH, Prolactin, Anti-CCP
 * (Kashmir CLIA and standard), ANA (CLIA and ELISA), Peripheral Blood Smear,
 * Platelet Count, KFT BASIC, LIPID SCREEN, TORCH IgM, TORCH IgG.
 *
 *   ZZKL01A-14A  one order per item, at the single-test tier (SMART-MINI, Rs 11)
 *   ZZKL15A-D    Sabreena Khan   F 33  AMH + LH + FSH + Prolactin   (SMART-MULT, Rs 25)
 *   ZZKL16A-C    Mohd Yousuf     M 58  KFT BASIC + LIPID SCREEN + Platelet Count
 *   ZZKL17A-B    Afreen Dar      F 30  TORCH IgM + TORCH IgG
 *   ZZKL18A-C    Naseema Bano    F 52  ANA CLIA + Anti-CCP + Peripheral Blood Smear
 *
 * Built the way zztest01-smart-hcp-fixtures-20260924.sql builds its packages:
 * each tube's result rows are cloned, STRUCTURE ONLY, from one real released
 * tube of that test or profile (ids, codes, names, units, frozen reference
 * ranges, profile links); the VALUES are generated from each row's own
 * reference range (inside it for most, a little above it for one in seven),
 * AMH is set by hand because its range is prose, and the blood smear's
 * descriptive lines are written here. Nothing a real patient measured is
 * reproduced; the names are invented; the SIDs (ZZKL...) and the centre mark
 * them as fixtures.
 *
 * Written directly, not through the order procedure (no bill pretended,
 * bill_id 0). Status 7 and auth = 1 so the lists and the booklet treat them
 * as released. Re-runnable: it clears its own previous rows first. Remove
 * with zztest01-smart-kashmir-fixtures-cleanup-20260926.sql.
 */
SET NOCOUNT ON;
SET XACT_ABORT ON;
BEGIN TRAN;
DECLARE @mcc INT = 6094;
DECLARE @by  NVARCHAR(50) = N'inf:jas';
DECLARE @drawn DATETIME = DATEADD(MINUTE, 40, DATEADD(HOUR, 7, CONVERT(DATETIME, CONVERT(DATE, DATEADD(DAY, -1, GETDATE())))));
DECLARE @regd  DATETIME = DATEADD(HOUR, 2, @drawn);
DECLARE @done  DATETIME = DATEADD(HOUR, 9, @drawn);

/* ---- clear the previous run ------------------------------------------- */
DECLARE @old TABLE (pid INT);
INSERT INTO @old (pid)
SELECT DISTINCT s.patient_id FROM dbo.tbl_med_mcc_patient_samples s JOIN dbo.tbl_med_mcc_patient_master p ON p.id = s.patient_id
WHERE p.mcc_code = @mcc AND s.vailid LIKE N'ZZKL[0-9][0-9][A-D]';
DELETE FROM dbo.tbl_med_mcc_patient_test_result WHERE vailid LIKE N'ZZKL[0-9][0-9][A-D]';
DELETE FROM dbo.tbl_med_mcc_patient_samples     WHERE vailid LIKE N'ZZKL[0-9][0-9][A-D]';
DELETE FROM dbo.telo_custom_test_order          WHERE patient_id IN (SELECT pid FROM @old);
DELETE FROM dbo.tbl_med_mcc_patient_tests       WHERE patient_id IN (SELECT pid FROM @old);
DELETE FROM dbo.tbl_med_mcc_patient_master      WHERE id IN (SELECT pid FROM @old);

/* ---- the patients ------------------------------------------------------ */
DECLARE @spec TABLE (n TINYINT, initial NVARCHAR(10), name NVARCHAR(100), age INT, gender INT);
INSERT INTO @spec VALUES
    ( 1, N'Mrs', N'Ritu Bhat',        32, 2),
    ( 2, N'Mrs', N'Shazia Mir',       29, 2),
    ( 3, N'Mrs', N'Nusrat Wani',      35, 2),
    ( 4, N'Mrs', N'Farah Lone',       27, 2),
    ( 5, N'Mrs', N'Mehak Dar',        41, 2),
    ( 6, N'Mr',  N'Tariq Bhat',       48, 1),
    ( 7, N'Mrs', N'Rukhsana Ganie',   39, 2),
    ( 8, N'Mrs', N'Shabnam Khan',     44, 2),
    ( 9, N'Mr',  N'Imran Khan',       36, 1),
    (10, N'Mrs', N'Sana Rather',      31, 2),
    (11, N'Mr',  N'Gulzar Malik',     55, 1),
    (12, N'Mr',  N'Bashir Ahmad',     50, 1),
    (13, N'Mrs', N'Iqra Naik',        26, 2),
    (14, N'Mrs', N'Saima Wani',       28, 2),
    (15, N'Mrs', N'Sabreena Khan',    33, 2),
    (16, N'Mr',  N'Mohd Yousuf',      58, 1),
    (17, N'Mrs', N'Afreen Dar',       30, 2),
    (18, N'Mrs', N'Naseema Bano',     52, 2);

/* ---- each order's items: the catalogue code and the real tube it is modelled on ---- */
DECLARE @items TABLE (n TINYINT, letter CHAR(1), code NVARCHAR(20), tmpl NVARCHAR(50));
INSERT INTO @items VALUES
    ( 1, 'A', N'BI034',   N'9176662'),   -- AMH
    ( 2, 'A', N'BI145',   N'40004106'),  -- LH
    ( 3, 'A', N'BI106',   N'9625884'),   -- FSH
    ( 4, 'A', N'BI180',   N'9619092'),   -- Prolactin
    ( 5, 'A', N'ACPCL1',  N'9187136'),   -- Anti CCP, CLIA for Kashmir
    ( 6, 'A', N'BI036',   N'99017310'),  -- Anti-CCP standard
    ( 7, 'A', N'ANACL01', N'8982999'),   -- ANA CLIA
    ( 8, 'A', N'MS006',   N'9577924'),   -- ANA ELISA
    ( 9, 'A', N'HE055',   N'8688776'),   -- Peripheral Blood Smear
    (10, 'A', N'HE029',   N'9672016'),   -- Platelet Count
    (11, 'A', N'KFTJK',   N'8987137'),   -- KFT BASIC
    (12, 'A', N'LPSC',    N'9429311'),   -- LIPID SCREEN
    (13, 'A', N'GP10',    N'09016982'),  -- TORCH IgM
    (14, 'A', N'GP11',    N'9412188'),   -- TORCH IgG
    (15, 'A', N'BI034',   N'9176662'), (15, 'B', N'BI145', N'40004106'), (15, 'C', N'BI106', N'9625884'), (15, 'D', N'BI180', N'9619092'),
    (16, 'A', N'KFTJK',   N'8987137'), (16, 'B', N'LPSC',  N'9429311'),  (16, 'C', N'HE029', N'9672016'),
    (17, 'A', N'GP10',    N'09016982'), (17, 'B', N'GP11', N'9412188'),
    (18, 'A', N'ANACL01', N'8982999'), (18, 'B', N'BI036', N'99017310'), (18, 'C', N'HE055', N'8688776');

DECLARE @p TABLE (n TINYINT, pid INT);
DECLARE @n TINYINT = 1, @pid INT;
WHILE @n <= 18
BEGIN
    INSERT INTO dbo.tbl_med_mcc_patient_master
        (mcc_code, initial, name, age, age_type, gender, sample_date, sample_time, ref_doctor_other, mobile_number, addedby, addeddate)
    SELECT @mcc, initial, name, age, 1, gender, @drawn, @drawn, 'Self', CONCAT('90000001', RIGHT(CONCAT('0', n), 2)), @by, @regd
    FROM @spec WHERE n = @n;
    SET @pid = SCOPE_IDENTITY();
    INSERT INTO @p VALUES (@n, @pid);
    SET @n += 1;
END

/* The order lines, copied from the template order's own line for that code
   (id, code, name, rate, Test/Profile). */
INSERT INTO dbo.tbl_med_mcc_patient_tests (patient_id, test_id, test_code, test_name, test_rate, test_type, addedby, addeddate)
SELECT p.pid, x.test_id, x.test_code, x.test_name, x.test_rate, x.test_type, @by, @regd
FROM @items i JOIN @p p ON p.n = i.n
CROSS APPLY (SELECT TOP 1 t.test_id, t.test_code, t.test_name, t.test_rate, t.test_type
             FROM dbo.tbl_med_mcc_patient_samples s JOIN dbo.tbl_med_mcc_patient_tests t ON t.patient_id = s.patient_id
             WHERE s.vailid = i.tmpl AND LTRIM(RTRIM(t.test_code)) = i.code ORDER BY t.id) x;

/* The paid extra - THIS row entitles the patient to the booklet: one
   supported item books the single-test tier (SMART-MINI, Rs 11 offer),
   two or more the multi tier (SMART-MULT, Rs 25 offer). */
INSERT INTO dbo.telo_custom_test_order (bill_id, patient_id, custom_test_id, code, name, unit_amount, qty, mcc_code, created_by)
SELECT 0, p.pid, 3, CASE WHEN c.k = 1 THEN N'SMART-MINI' ELSE N'SMART-MULT' END, N'Smart Report',
       CASE WHEN c.k = 1 THEN 11 ELSE 25 END, 1, @mcc, @by
FROM @p p JOIN (SELECT n, COUNT(*) AS k FROM @items GROUP BY n) c ON c.n = p.n;

/* ---- the tubes: one per item, lettered --------------------------------- */
DECLARE @tube TABLE (n TINYINT, sid NVARCHAR(50), tmpl NVARCHAR(50), code NVARCHAR(20));
INSERT INTO @tube (n, sid, tmpl, code)
SELECT n, CONCAT(N'ZZKL', RIGHT(CONCAT('0', n), 2), letter), tmpl, code FROM @items;

INSERT INTO dbo.tbl_med_mcc_patient_samples
    (patient_id, sampleid, testcodes, testnames, testtypes, vailid, sample_status, addedby, addeddate, modifiedby, modifieddate,
     lastmodified_date, report_type, department_id, business_unit_id, authorised_by, signature_id)
SELECT p.pid, s.sampleid, s.testcodes, s.testnames, s.testtypes, t.sid, 7, @by, @regd, @by, @regd, @done,
       s.report_type, s.department_id, s.business_unit_id, s.authorised_by, s.signature_id
FROM @tube t JOIN @p p ON p.n = t.n JOIN dbo.tbl_med_mcc_patient_samples s ON s.vailid = t.tmpl;

/* ---- the result rows: structure from the template, values from the range ---- */
IF OBJECT_ID('tempdb..#w') IS NOT NULL DROP TABLE #w;
SELECT ROW_NUMBER() OVER (ORDER BY t.n, t.sid, r.id) AS seq,
       p.pid, t.sid, t.code AS tubecode, r.id AS src_id, r.testid, r.testtype, r.value AS tmpl_value, r.hasparameters, r.normal_range,
       r.testcode, r.testname, r.testnormal_range, r.testunit, r.paramid, r.profile_id, r.master_profile_id, r.level_id,
       rng = LTRIM(RTRIM(REPLACE(REPLACE(REPLACE(ISNULL(r.testnormal_range, ''), CHAR(13), ' '), CHAR(10), ' '), CHAR(9), ' '))),
       p1 = 0, n1 = CAST(NULL AS VARCHAR(20)), rest = CAST(NULL AS NVARCHAR(400)), prefix = CAST(NULL AS NVARCHAR(400)),
       p2 = 0, n2 = CAST(NULL AS VARCHAR(20)), betw = CAST(NULL AS NVARCHAR(400)),
       lo = CAST(NULL AS DECIMAL(18,4)), hi = CAST(NULL AS DECIMAL(18,4)),
       isRange = 0, upperOnly = 0, lowerOnly = 0, dec = 0, flag = CASE WHEN ((r.id + t.n) % 7) = 3 THEN 1 ELSE 0 END,
       v = CAST(NULL AS DECIMAL(18,4)), value = CAST(NULL AS NVARCHAR(400)), ab = 0
INTO #w
FROM @tube t
JOIN @p p ON p.n = t.n
JOIN dbo.tbl_med_mcc_patient_test_result r ON r.vailid = t.tmpl;

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
    ELSE N'Normal' END,
    ab = CASE WHEN testtype NOT IN ('Head', 'Profile') AND v IS NOT NULL AND flag = 1 THEN 1 ELSE 0 END;

/* AMH's reference range is prose (fertility bands), so the value is set by
   hand: a healthy reserve for a woman in her early thirties. */
UPDATE #w SET value = N'2.40', ab = 0 WHERE testtype = 'Test' AND LTRIM(RTRIM(testcode)) = N'BI034';

/* The blood smear is a description, not a number: generic, invented lines. */
UPDATE #w SET ab = 0, value = CASE
    WHEN testname LIKE N'%WBC%'        THEN N'Total leucocyte count within normal limits. Normal differential, no immature cells seen.'
    WHEN testname LIKE N'%RBC%'        THEN N'Predominantly normocytic normochromic red cells. No anisocytosis or poikilocytosis.'
    WHEN testname LIKE N'%parasite%'   THEN N'No haemoparasites seen.'
    WHEN testname LIKE N'%Platelet%'   THEN N'Adequate on smear. No platelet clumps.'
    WHEN testname LIKE N'%Impression%' THEN N'Normocytic normochromic blood picture.'
    ELSE value END
WHERE tubecode = N'HE055' AND testtype = 'Param';

/* Single-value tubes rarely draw the one-in-seven flag, so a few readings are
   pushed out of range by hand: the booklet's high/low copy needs showing. */
UPDATE #w SET value = N'38.6', ab = 1 WHERE sid = N'ZZKL04A' AND testtype = 'Test';                                    -- prolactin high
UPDATE #w SET value = N'46.8', ab = 1 WHERE sid = N'ZZKL06A' AND testtype = 'Test';                                    -- anti-CCP positive
UPDATE #w SET value = N'62.5', ab = 1 WHERE sid = N'ZZKL08A' AND testtype = 'Param';                                   -- ANA positive
UPDATE #w SET value = N'118',  ab = 1 WHERE sid = N'ZZKL10A' AND testtype = 'Param';                                   -- platelets low
UPDATE #w SET value = N'1.52', ab = 1 WHERE sid = N'ZZKL11A' AND testname LIKE N'Creatinine%';                         -- creatinine high
UPDATE #w SET value = N'186',  ab = 1 WHERE sid = N'ZZKL12A' AND testname LIKE N'Triglycerides%';                      -- triglycerides borderline
UPDATE #w SET value = N'0.65', ab = 1 WHERE sid = N'ZZKL15A' AND testtype = 'Test';                                    -- AMH low
UPDATE #w SET value = N'13.4', ab = 1 WHERE sid = N'ZZKL15B' AND testtype = 'Test';                                    -- LH high

INSERT INTO dbo.tbl_med_mcc_patient_test_result
    (patientid, vailid, testid, value, testtype, auth, attachment, hasparameters, normal_range, testcode, testname,
     testnormal_range, testunit, comments, addedby, addeddate, updatedby, updateddate, paramid, profile_id, abnormal,
     mobile_number, master_profile_id, level_id)
SELECT pid, sid, testid, value, testtype, 1, 0, hasparameters, normal_range, testcode, testname,
       testnormal_range, testunit, NULL, @by, @regd, @by, @done, paramid, profile_id, ab,
       NULL, master_profile_id, level_id
FROM #w ORDER BY seq;
DROP TABLE #w;

COMMIT;

SELECT p.n, p.pid, pt.name, tier = c.code,
       items   = (SELECT STRING_AGG(code, '+') FROM @items i WHERE i.n = p.n),
       tubes   = (SELECT COUNT(*) FROM dbo.tbl_med_mcc_patient_samples s WHERE s.patient_id = p.pid),
       results = (SELECT COUNT(*) FROM dbo.tbl_med_mcc_patient_test_result r WHERE r.patientid = p.pid AND r.testtype IN ('Test','Param')),
       flagged = (SELECT COUNT(*) FROM dbo.tbl_med_mcc_patient_test_result r WHERE r.patientid = p.pid AND r.abnormal = 1),
       blank   = (SELECT COUNT(*) FROM dbo.tbl_med_mcc_patient_test_result r WHERE r.patientid = p.pid AND r.testtype IN ('Test','Param') AND ISNULL(r.value, '') = '')
FROM @p p JOIN dbo.tbl_med_mcc_patient_master pt ON pt.id = p.pid
JOIN dbo.telo_custom_test_order c ON c.patient_id = p.pid
ORDER BY p.n;
GO
