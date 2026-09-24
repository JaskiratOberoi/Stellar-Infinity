SET QUOTED_IDENTIFIER ON;
GO
/*
 * zztest01-smart-hcp-fixtures-20260924.sql — four Smart Report review orders
 * on the throwaway centre ZZTEST01 (mcc 6094), one per HEALTH CARE PROFILE
 * package the booklet is now sold with (script 162): P035A 1.1, P036A 1.2,
 * P037A 1.3, P038A 1.4. For Jas to review the booklet these packages produce.
 *
 *   ZZHCP1A–D  Meera Iyer         F 45  P035A HEALTH CARE PROFILE 1.1
 *   ZZHCP2A–D  Vikram Sethi       M 52  P036A HEALTH CARE PROFILE 1.2
 *   ZZHCP3A–D  Kavita Rao         F 58  P037A HEALTH CARE PROFILE 1.3
 *   ZZHCP4A–D  Arvind Malhotra    M 61  P038A HEALTH CARE PROFILE 1.4
 *
 * Built the way 903 builds its demo packages: the result rows are cloned,
 * STRUCTURE ONLY, from one real fully-reported order of each package —
 * test ids, parameter ids, codes, names, units, frozen reference ranges,
 * profile links — so every tube prints exactly as a real one does. The
 * VALUES are not copied: each is generated from the row's own reference
 * range (inside it for most analytes, a little above it for one in seven,
 * so the gauges, the body map and the advice all have something to show),
 * and a qualitative row gets its range's own normal word. Nothing a real
 * patient measured is reproduced; the names are invented; the SIDs
 * (ZZHCP…) and the centre mark them as fixtures.
 *
 * Written directly, not through the order procedure, which would bill: no
 * bill is pretended (bill_id 0). Status 7 and auth = 1 so the reporting list
 * and the booklet treat them as released. Re-runnable: it clears its own
 * previous rows first. Remove with zztest01-smart-hcp-fixtures-cleanup-20260924.sql.
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
WHERE p.mcc_code = @mcc AND s.vailid LIKE N'ZZHCP[1-4][A-D]';
DELETE FROM dbo.tbl_med_mcc_patient_test_result WHERE vailid LIKE N'ZZHCP[1-4][A-D]';
DELETE FROM dbo.tbl_med_mcc_patient_samples     WHERE vailid LIKE N'ZZHCP[1-4][A-D]';
DELETE FROM dbo.telo_custom_test_order          WHERE patient_id IN (SELECT pid FROM @old);
DELETE FROM dbo.tbl_med_mcc_patient_tests       WHERE patient_id IN (SELECT pid FROM @old);
DELETE FROM dbo.tbl_med_mcc_patient_master      WHERE id IN (SELECT pid FROM @old);

/* ---- the four patients, and the real order each is modelled on ---------- */
DECLARE @p TABLE (n TINYINT, pid INT, pkg INT, code NVARCHAR(50), pkgname NVARCHAR(100), rate INT, tmplPid INT);
DECLARE @spec TABLE (n TINYINT, initial NVARCHAR(10), name NVARCHAR(100), age INT, gender INT, pkg INT, tmplPid INT);
INSERT INTO @spec VALUES
    (1, N'Mrs', N'Meera Iyer',       45, 2, 209, 3720718),
    (2, N'Mr',  N'Vikram Sethi',     52, 1, 210, 3719357),
    (3, N'Mrs', N'Kavita Rao',       58, 2, 211, 3720722),
    (4, N'Mr',  N'Arvind Malhotra',  61, 1, 216, 3719876);

DECLARE @n TINYINT = 1, @pid INT;
WHILE @n <= 4
BEGIN
    INSERT INTO dbo.tbl_med_mcc_patient_master
        (mcc_code, initial, name, age, age_type, gender, sample_date, sample_time, ref_doctor_other, mobile_number, addedby, addeddate)
    SELECT @mcc, initial, name, age, 1, gender, @drawn, @drawn, 'Self', CONCAT('90000000', 10 + n), @by, @regd
    FROM @spec WHERE n = @n;
    SET @pid = SCOPE_IDENTITY();
    INSERT INTO @p SELECT s.n, @pid, s.pkg, LTRIM(RTRIM(m.Master_Profile_Code)), LTRIM(RTRIM(m.Master_Profile_Name)), m.MRP, s.tmplPid
    FROM @spec s JOIN dbo.tbl_med_test_master_profile_master m ON m.id = s.pkg WHERE s.n = @n;
    SET @n += 1;
END

/* The order line, so the lists name the package; and the paid extra — THIS
   row is what entitles the patient to the booklet. ₹49: the package tier's
   introductory price. */
INSERT INTO dbo.tbl_med_mcc_patient_tests (patient_id, test_id, test_code, test_name, test_rate, test_type, addedby, addeddate)
SELECT pid, pkg, code, pkgname, rate, 'Master', @by, @regd FROM @p;
INSERT INTO dbo.telo_custom_test_order (bill_id, patient_id, custom_test_id, code, name, unit_amount, qty, mcc_code, created_by)
SELECT 0, pid, 3, N'SMART-RPT', N'Smart Report', 49, 1, @mcc, @by FROM @p;

/* ---- the tubes: one per template tube, lettered A–D ---------------------- */
DECLARE @tube TABLE (n TINYINT, sid NVARCHAR(50), tmpl NVARCHAR(50));
INSERT INTO @tube (n, sid, tmpl)
SELECT p.n, CONCAT(N'ZZHCP', p.n, CHAR(64 + ROW_NUMBER() OVER (PARTITION BY p.n ORDER BY s.id))), s.vailid
FROM @p p JOIN dbo.tbl_med_mcc_patient_samples s ON s.patient_id = p.tmplPid;

INSERT INTO dbo.tbl_med_mcc_patient_samples
    (patient_id, sampleid, testcodes, testnames, testtypes, vailid, sample_status, addedby, addeddate, modifiedby, modifieddate,
     lastmodified_date, report_type, department_id, business_unit_id, authorised_by, signature_id)
SELECT p.pid, s.sampleid, s.testcodes, s.testnames, s.testtypes, t.sid, 7, @by, @regd, @by, @regd, @done,
       s.report_type, s.department_id, s.business_unit_id, s.authorised_by, s.signature_id
FROM @tube t JOIN @p p ON p.n = t.n JOIN dbo.tbl_med_mcc_patient_samples s ON s.vailid = t.tmpl;

/* ---- the result rows: structure from the template, values from the range ----
   Staged through a temp table in several small UPDATEs: one statement with
   the whole derivation nested in CROSS APPLYs hit SQL Server's expression
   services limit. */
IF OBJECT_ID('tempdb..#w') IS NOT NULL DROP TABLE #w;
SELECT ROW_NUMBER() OVER (ORDER BY t.n, t.sid, r.id) AS seq,
       p.pid, t.sid, r.id AS src_id, r.testid, r.testtype, r.value AS tmpl_value, r.hasparameters, r.normal_range,
       r.testcode, r.testname, r.testnormal_range, r.testunit, r.paramid, r.profile_id, r.master_profile_id, r.level_id,
       rng = LTRIM(RTRIM(REPLACE(REPLACE(REPLACE(ISNULL(r.testnormal_range, ''), CHAR(13), ' '), CHAR(10), ' '), CHAR(9), ' '))),
       p1 = 0, n1 = CAST(NULL AS VARCHAR(20)), rest = CAST(NULL AS NVARCHAR(400)), prefix = CAST(NULL AS NVARCHAR(400)),
       p2 = 0, n2 = CAST(NULL AS VARCHAR(20)), betw = CAST(NULL AS NVARCHAR(400)),
       lo = CAST(NULL AS DECIMAL(18,4)), hi = CAST(NULL AS DECIMAL(18,4)),
       isRange = 0, upperOnly = 0, lowerOnly = 0, dec = 0, flag = CASE WHEN (r.id % 7) = 3 THEN 1 ELSE 0 END,
       v = CAST(NULL AS DECIMAL(18,4)), value = CAST(NULL AS NVARCHAR(60)), ab = 0
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
       NULL, master_profile_id, level_id
FROM #w ORDER BY seq;
DROP TABLE #w;

COMMIT;

SELECT p.n, p.pid, p.pkgname, pt.name,
       tubes   = (SELECT COUNT(*) FROM dbo.tbl_med_mcc_patient_samples s WHERE s.patient_id = p.pid),
       results = (SELECT COUNT(*) FROM dbo.tbl_med_mcc_patient_test_result r WHERE r.patientid = p.pid AND r.testtype IN ('Test','Param')),
       flagged = (SELECT COUNT(*) FROM dbo.tbl_med_mcc_patient_test_result r WHERE r.patientid = p.pid AND r.abnormal = 1),
       blank   = (SELECT COUNT(*) FROM dbo.tbl_med_mcc_patient_test_result r WHERE r.patientid = p.pid AND r.testtype IN ('Test','Param') AND ISNULL(r.value, '') = '')
FROM @p p JOIN dbo.tbl_med_mcc_patient_master pt ON pt.id = p.pid ORDER BY p.n;
GO
