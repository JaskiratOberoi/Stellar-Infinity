/*
 * catalogue_consistency.sql — read-only scan of the test catalogue for the
 * family of defects behind the HS3 / Thyroid Profile II incident (2026-09-19):
 * a package or profile whose DEFINITION does not match what gets booked.
 *
 * Run:  powershell -File api/db/query.ps1 is one statement at a time; for the
 *       whole file use the scratchpad noble-q helper or SSMS. Every result set
 *       is labelled by its first column. An empty set is a pass.
 *
 * What each check means and what to do about a hit:
 *   1  active package -> inactive member profile   Booked as defined since
 *      script 146; the lab should either reactivate the profile or take it
 *      out of the package. (Was the HS3 cause: Thyroid Profile II.)
 *   2  active package -> inactive member test      Same. Watch for members
 *      literally named "DELETED".
 *   3  package member pointing at a profile/test id that no longer exists.
 *   4  active package with no members at all.
 *   5  active profile (or one used by an active package) -> inactive test.
 *      Booked as defined once 147 is applied; same lab decision as 1.
 *   6  profile with zero tests (the LIS skips it silently) / orphan rows.
 *   7  duplicate member rows.
 *   7c test listed BOTH directly and inside a member profile of the same
 *      package: the report carries the test twice (confirmed on printed
 *      BG003 / BXP003 reports: two creatinine rows). Remove one.
 *   8  member test whose sample type does not exist: lands on an
 *      "Unspecified" tube.
 *   9  package member row's stored name differs from the catalogue name:
 *      the tube string (worksheet) shows the member-row name, the report
 *      shows the catalogue name. Cosmetic unless misleading.
 *  10  active profile whose tests span several sample types: Telo/Infinity
 *      split it into loose test codes (no profile header on the report);
 *      the LIS puts the whole profile on one tube. Design decision pending.
 *  11  totals, for scale.
 *   A  Telo/Infinity package orders whose package holds an inactive member
 *      and whether the member's code reached the patient's tubes
 *      (on_tube = 0 is a booking that lost tests; status >= 9 is printed).
 */
SET NOCOUNT ON;
-- 1. active packages whose member PROFILE is inactive
SELECT '1 pkg->inactive profile' AS chk, m.id AS pkg_id, m.Master_Profile_Code AS pkg, m.Master_Profile_Name AS pkg_name, p.id AS member_id, p.Profile_Code AS member_code, p.Profile_Name AS member_name,
       (SELECT COUNT(*) FROM dbo.tbl_med_test_profile_param pp WHERE pp.profileid = p.id) AS member_tests
FROM dbo.tbl_med_test_master_profile_master m JOIN dbo.tbl_med_test_master_profile_param mpp ON mpp.master_profileid = m.id JOIN dbo.tbl_med_test_profile_master p ON p.id = mpp.profileid
WHERE m.IsActive = 1 AND ISNULL(p.IsActive, 0) = 0 ORDER BY p.id, m.id;
-- 2. active packages whose member TEST is inactive
SELECT '2 pkg->inactive test' AS chk, m.id AS pkg_id, m.Master_Profile_Code AS pkg, m.Master_Profile_Name AS pkg_name, t.id AS member_id, t.TestCode AS member_code, t.Testname AS member_name
FROM dbo.tbl_med_test_master_profile_master m JOIN dbo.tbl_med_test_master_test_param mtp ON mtp.master_profileid = m.id JOIN dbo.tbl_med_test_master t ON t.id = mtp.testid
WHERE m.IsActive = 1 AND ISNULL(t.IsActive, 0) = 0 ORDER BY t.id, m.id;
-- 3. active packages with orphan member rows (profile/test id does not exist)
SELECT '3 pkg orphan profile' AS chk, m.id AS pkg_id, m.Master_Profile_Code AS pkg, mpp.profileid AS missing_id, mpp.profile_name AS member_name FROM dbo.tbl_med_test_master_profile_master m JOIN dbo.tbl_med_test_master_profile_param mpp ON mpp.master_profileid = m.id WHERE m.IsActive = 1 AND NOT EXISTS (SELECT 1 FROM dbo.tbl_med_test_profile_master p WHERE p.id = mpp.profileid)
UNION ALL
SELECT '3 pkg orphan test', m.id, m.Master_Profile_Code, mtp.testid, mtp.test_name FROM dbo.tbl_med_test_master_profile_master m JOIN dbo.tbl_med_test_master_test_param mtp ON mtp.master_profileid = m.id WHERE m.IsActive = 1 AND NOT EXISTS (SELECT 1 FROM dbo.tbl_med_test_master t WHERE t.id = mtp.testid);
-- 4. active packages with no members at all
SELECT '4 pkg empty' AS chk, m.id AS pkg_id, m.Master_Profile_Code AS pkg, m.Master_Profile_Name AS pkg_name FROM dbo.tbl_med_test_master_profile_master m WHERE m.IsActive = 1 AND NOT EXISTS (SELECT 1 FROM dbo.tbl_med_test_master_profile_param x WHERE x.master_profileid = m.id) AND NOT EXISTS (SELECT 1 FROM dbo.tbl_med_test_master_test_param x WHERE x.master_profileid = m.id) ORDER BY m.id;
-- 5. profiles (active, or used by an active package) whose member test is inactive
SELECT '5 profile->inactive test' AS chk, p.id AS profile_id, p.Profile_Code, p.Profile_Name, p.IsActive AS profile_active, t.id AS test_id, t.TestCode, t.Testname,
       (SELECT COUNT(*) FROM dbo.tbl_med_test_master_profile_param mpp JOIN dbo.tbl_med_test_master_profile_master m ON m.id = mpp.master_profileid AND m.IsActive = 1 WHERE mpp.profileid = p.id) AS used_by_active_pkgs
FROM dbo.tbl_med_test_profile_master p JOIN dbo.tbl_med_test_profile_param pp ON pp.profileid = p.id JOIN dbo.tbl_med_test_master t ON t.id = pp.testid
WHERE ISNULL(t.IsActive, 0) = 0 AND (p.IsActive = 1 OR EXISTS (SELECT 1 FROM dbo.tbl_med_test_master_profile_param mpp JOIN dbo.tbl_med_test_master_profile_master m ON m.id = mpp.master_profileid AND m.IsActive = 1 WHERE mpp.profileid = p.id))
ORDER BY p.id, t.id;
-- 6. profiles used by an active package (or active themselves) with zero tests, or orphan test rows
SELECT '6 profile empty' AS chk, p.id AS profile_id, p.Profile_Code, p.Profile_Name, p.IsActive AS profile_active,
       (SELECT COUNT(*) FROM dbo.tbl_med_test_master_profile_param mpp JOIN dbo.tbl_med_test_master_profile_master m ON m.id = mpp.master_profileid AND m.IsActive = 1 WHERE mpp.profileid = p.id) AS used_by_active_pkgs
FROM dbo.tbl_med_test_profile_master p WHERE NOT EXISTS (SELECT 1 FROM dbo.tbl_med_test_profile_param pp JOIN dbo.tbl_med_test_master t ON t.id = pp.testid WHERE pp.profileid = p.id)
  AND (p.IsActive = 1 OR EXISTS (SELECT 1 FROM dbo.tbl_med_test_master_profile_param mpp JOIN dbo.tbl_med_test_master_profile_master m ON m.id = mpp.master_profileid AND m.IsActive = 1 WHERE mpp.profileid = p.id))
ORDER BY p.id;
SELECT '6b profile orphan test' AS chk, p.id AS profile_id, p.Profile_Code, pp.testid AS missing_test_id FROM dbo.tbl_med_test_profile_master p JOIN dbo.tbl_med_test_profile_param pp ON pp.profileid = p.id WHERE p.IsActive = 1 AND NOT EXISTS (SELECT 1 FROM dbo.tbl_med_test_master t WHERE t.id = pp.testid);
-- 7. duplicate members
SELECT '7 dup pkg profile' AS chk, m.id AS pkg_id, m.Master_Profile_Code AS pkg, mpp.profileid AS member_id, COUNT(*) AS n FROM dbo.tbl_med_test_master_profile_master m JOIN dbo.tbl_med_test_master_profile_param mpp ON mpp.master_profileid = m.id WHERE m.IsActive = 1 GROUP BY m.id, m.Master_Profile_Code, mpp.profileid HAVING COUNT(*) > 1
UNION ALL
SELECT '7 dup pkg test', m.id, m.Master_Profile_Code, mtp.testid, COUNT(*) FROM dbo.tbl_med_test_master_profile_master m JOIN dbo.tbl_med_test_master_test_param mtp ON mtp.master_profileid = m.id WHERE m.IsActive = 1 GROUP BY m.id, m.Master_Profile_Code, mtp.testid HAVING COUNT(*) > 1
UNION ALL
SELECT '7 dup profile test', p.id, p.Profile_Code, pp.testid, COUNT(*) FROM dbo.tbl_med_test_profile_master p JOIN dbo.tbl_med_test_profile_param pp ON pp.profileid = p.id WHERE p.IsActive = 1 GROUP BY p.id, p.Profile_Code, pp.testid HAVING COUNT(*) > 1;
-- 7c. a test present both directly and via a member profile of the same package (double result rows on the report)
SELECT '7c pkg test also in member profile' AS chk, m.id AS pkg_id, m.Master_Profile_Code AS pkg, m.Master_Profile_Name AS pkg_name, t.id AS test_id, t.TestCode, t.Testname, p.Profile_Code AS via_profile
FROM dbo.tbl_med_test_master_profile_master m JOIN dbo.tbl_med_test_master_test_param mtp ON mtp.master_profileid = m.id JOIN dbo.tbl_med_test_master t ON t.id = mtp.testid
JOIN dbo.tbl_med_test_master_profile_param mpp ON mpp.master_profileid = m.id JOIN dbo.tbl_med_test_profile_param pp ON pp.profileid = mpp.profileid AND pp.testid = t.id JOIN dbo.tbl_med_test_profile_master p ON p.id = mpp.profileid
WHERE m.IsActive = 1 ORDER BY m.id;
-- 8. members whose test has no usable sample type
SELECT '8 no sample type' AS chk, t.id AS test_id, t.TestCode, t.Testname, t.SampleId, t.IsActive,
       (SELECT COUNT(*) FROM dbo.tbl_med_test_master_test_param mtp JOIN dbo.tbl_med_test_master_profile_master m ON m.id = mtp.master_profileid AND m.IsActive = 1 WHERE mtp.testid = t.id) AS in_active_pkgs,
       (SELECT COUNT(*) FROM dbo.tbl_med_test_profile_param pp JOIN dbo.tbl_med_test_profile_master p ON p.id = pp.profileid AND p.IsActive = 1 WHERE pp.testid = t.id) AS in_active_profiles
FROM dbo.tbl_med_test_master t WHERE NOT EXISTS (SELECT 1 FROM dbo.tbl_med_sample_master sm WHERE sm.id = t.SampleId)
  AND (EXISTS (SELECT 1 FROM dbo.tbl_med_test_master_test_param mtp JOIN dbo.tbl_med_test_master_profile_master m ON m.id = mtp.master_profileid AND m.IsActive = 1 WHERE mtp.testid = t.id)
    OR EXISTS (SELECT 1 FROM dbo.tbl_med_test_profile_param pp JOIN dbo.tbl_med_test_profile_master p ON p.id = pp.profileid AND p.IsActive = 1 WHERE pp.testid = t.id)
    OR t.IsActive = 1)
ORDER BY t.id;
-- 9. member-row names that drift from the catalogue (the tube string follows the member row, the result rows follow the catalogue)
SELECT '9 name drift profile' AS chk, m.Master_Profile_Code AS pkg, mpp.profileid AS member_id, mpp.profile_name AS member_row_name, p.Profile_Name AS catalogue_name FROM dbo.tbl_med_test_master_profile_master m JOIN dbo.tbl_med_test_master_profile_param mpp ON mpp.master_profileid = m.id JOIN dbo.tbl_med_test_profile_master p ON p.id = mpp.profileid WHERE m.IsActive = 1 AND ISNULL(mpp.profile_name, '') <> ISNULL(p.Profile_Name, '');
SELECT '9 name drift test' AS chk, m.Master_Profile_Code AS pkg, mtp.testid AS member_id, mtp.test_name AS member_row_name, t.Testname AS catalogue_name FROM dbo.tbl_med_test_master_profile_master m JOIN dbo.tbl_med_test_master_test_param mtp ON mtp.master_profileid = m.id JOIN dbo.tbl_med_test_master t ON t.id = mtp.testid WHERE m.IsActive = 1 AND ISNULL(mtp.test_name, '') <> ISNULL(t.Testname, '') ORDER BY m.id, mtp.id;
-- 10. profiles whose tests span more than one sample type (Telo/Infinity split them into test codes; the LIS puts the whole profile on one tube)
SELECT '10 profile spans tubes' AS chk, p.id AS profile_id, p.Profile_Code, p.Profile_Name, COUNT(DISTINCT t.SampleId) AS sample_types, STRING_AGG(CONVERT(NVARCHAR(MAX), CONCAT(t.TestCode, '@', t.SampleId)), ', ') AS members,
       (SELECT COUNT(*) FROM dbo.tbl_med_test_master_profile_param mpp JOIN dbo.tbl_med_test_master_profile_master m ON m.id = mpp.master_profileid AND m.IsActive = 1 WHERE mpp.profileid = p.id) AS used_by_active_pkgs
FROM dbo.tbl_med_test_profile_master p JOIN dbo.tbl_med_test_profile_param pp ON pp.profileid = p.id JOIN dbo.tbl_med_test_master t ON t.id = pp.testid
WHERE p.IsActive = 1 OR EXISTS (SELECT 1 FROM dbo.tbl_med_test_master_profile_param mpp JOIN dbo.tbl_med_test_master_profile_master m ON m.id = mpp.master_profileid AND m.IsActive = 1 WHERE mpp.profileid = p.id)
GROUP BY p.id, p.Profile_Code, p.Profile_Name HAVING COUNT(DISTINCT t.SampleId) > 1 ORDER BY p.id;
-- 11. totals
SELECT '11 totals' AS chk, (SELECT COUNT(*) FROM dbo.tbl_med_test_master_profile_master WHERE IsActive = 1) AS active_pkgs, (SELECT COUNT(*) FROM dbo.tbl_med_test_master_profile_master) AS all_pkgs, (SELECT COUNT(*) FROM dbo.tbl_med_test_profile_master WHERE IsActive = 1) AS active_profiles, (SELECT COUNT(*) FROM dbo.tbl_med_test_profile_master) AS all_profiles, (SELECT COUNT(*) FROM dbo.tbl_med_test_master WHERE IsActive = 1) AS active_tests, (SELECT COUNT(*) FROM dbo.tbl_med_test_master) AS all_tests;
-- A. Telo/Infinity package orders whose package holds an inactive member, and whether the member's code reached the tubes
WITH pkg_orders AS (
    SELECT pt.id AS line_id, pt.patient_id, pt.test_id AS pkg_id, pt.test_code AS pkg, pt.addedby, pt.addeddate
    FROM dbo.tbl_med_mcc_patient_tests pt
    WHERE pt.test_type = 'Master' AND (pt.addedby LIKE 'telo:%' OR pt.addedby LIKE 'inf:%')
),
inactive_members AS (
    SELECT mpp.master_profileid AS pkg_id, p.Profile_Code AS member_code, p.Profile_Name AS member_name, 'profile' AS kind
    FROM dbo.tbl_med_test_master_profile_param mpp JOIN dbo.tbl_med_test_profile_master p ON p.id = mpp.profileid WHERE ISNULL(p.IsActive, 0) = 0
    UNION ALL
    SELECT mtp.master_profileid, CONVERT(NVARCHAR(50), t.TestCode), t.Testname, 'test'
    FROM dbo.tbl_med_test_master_test_param mtp JOIN dbo.tbl_med_test_master t ON t.id = mtp.testid WHERE ISNULL(t.IsActive, 0) = 0
)
SELECT 'A impacted orders' AS chk, o.patient_id, pm.name AS patient, o.pkg, im.member_code, im.member_name, im.kind, o.addedby, CONVERT(VARCHAR(16), o.addeddate, 120) AS booked,
       mcc.MCCUnitCode AS client,
       CASE WHEN EXISTS (SELECT 1 FROM dbo.tbl_med_mcc_patient_samples s WHERE s.patient_id = o.patient_id AND ',' + s.testcodes + ',' LIKE '%,' + im.member_code + ',%') THEN 1 ELSE 0 END AS on_tube,
       (SELECT MAX(s.sample_status) FROM dbo.tbl_med_mcc_patient_samples s WHERE s.patient_id = o.patient_id) AS max_status,
       (SELECT STRING_AGG(CONVERT(NVARCHAR(MAX), s.vailid), ',') FROM dbo.tbl_med_mcc_patient_samples s WHERE s.patient_id = o.patient_id) AS sids
FROM pkg_orders o
JOIN inactive_members im ON im.pkg_id = o.pkg_id
JOIN dbo.tbl_med_mcc_patient_master pm ON pm.id = o.patient_id
LEFT JOIN dbo.tbl_med_mcc_unit_master mcc ON mcc.id = pm.mcc_code
ORDER BY o.addeddate;
