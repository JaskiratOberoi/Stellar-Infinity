/*
 * 166_smart_report_kashmir_list.sql
 *
 * The 2026-09-26 list (seventeen items; three already supported: Kidney
 * Function Test with Electrolytes, Liver Function Test, Iron Profile).
 *
 * Packages, package tier: JK HS4 NEW (JKHS04, 1332), JK HS4 EXTENDED
 * PROFILE (JKHS401, 226), JK HEALTH SCREEN 2 (JKHS2, 66).
 *
 * Single tests, single-test tier — the most-ordered active variant of each:
 * Anti-Mullerian Hormone (BI034, 626), LH (BI145, 138), FSH (BI106, 125),
 * Prolactin (BI180, 150), Anti CCP CLIA for Kashmir (ACPCL1, 2419 — the one
 * named; the general Anti-CCP BI036 is not added), ANA CLIA (ANACL01,
 * 2708), ANA ELISA (MS006, 182), Peripheral Blood Smear (HE055, 2131),
 * Platelet Count (HE029, 617).
 *
 * Profiles priced as single tests (as_single, 163): KFT BASIC (KFTJK, 81),
 * LIPID SCREEN (LPSC, 62), TORCH IgM (GP10, 22), TORCH IgG (GP11, 23) —
 * small profiles like Lipid Profile and Thyroid Profile I before them.
 * Idempotent.
 */
SET NOCOUNT ON;
INSERT INTO dbo.inf_smart_report_package (master_profile_id, code, created_by)
SELECT m.id, LTRIM(RTRIM(m.Master_Profile_Code)), N'inf:jas'
FROM dbo.tbl_med_test_master_profile_master m
WHERE m.id IN (1332, 226, 66)
  AND NOT EXISTS (SELECT 1 FROM dbo.inf_smart_report_package p WHERE p.master_profile_id = m.id);
PRINT CONCAT('packages added: ', @@ROWCOUNT);
INSERT INTO dbo.inf_smart_report_mini (kind, catalogue_id, code, name, mrp, created_by, as_single)
SELECT N'test', t.id, LTRIM(RTRIM(t.TestCode)), LTRIM(RTRIM(t.Testname)), 21, N'inf:jas', 1
FROM dbo.tbl_med_test_master t
WHERE t.id IN (626, 138, 125, 150, 2419, 2708, 182, 2131, 617)
  AND NOT EXISTS (SELECT 1 FROM dbo.inf_smart_report_mini m WHERE m.kind = N'test' AND m.catalogue_id = t.id);
PRINT CONCAT('single tests added: ', @@ROWCOUNT);
INSERT INTO dbo.inf_smart_report_mini (kind, catalogue_id, code, name, mrp, created_by, as_single)
SELECT N'profile', p.id, LTRIM(RTRIM(p.Profile_Code)), LTRIM(RTRIM(p.Profile_Name)), 21, N'inf:jas', 1
FROM dbo.tbl_med_test_profile_master p
WHERE p.id IN (81, 62, 22, 23)
  AND NOT EXISTS (SELECT 1 FROM dbo.inf_smart_report_mini m WHERE m.kind = N'profile' AND m.catalogue_id = p.id);
PRINT CONCAT('profiles added as single: ', @@ROWCOUNT);
GO
