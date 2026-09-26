/*
 * 165_smart_report_jk_packages_tsh_b12.sql
 *
 * From the JK centres' lists of 2026-09-26 (each a package plus the single
 * tests they add to it):
 *   JK012   JK HEALTH SCREEN 1  + Vitamin D3, HbA1c, TSH
 *   JK0094  JK HS4              + Vitamin, HbA1c, LFT, Lipid profile, TSH, B12
 *   JK0027  JK HEALTH SCREEN 1  + HbA1c, Lipid profile, KFT, CRP, RF
 *
 * Packages: JK HEALTH SCREEN 1 (JKHS1, 67) and JK HS4 (JKHS4, 125 — the one
 * JK0094 orders, not JK HS4 NEW or EXTENDED) join inf_smart_report_package
 * at the package tier. Singles: TSH (BI221, 170) and Vitamin B12 - Serum
 * (BI235, 175) join inf_smart_report_mini at the single-test tier. The rest
 * were already supported: Vitamin D, HbA1c, Lipid profile, CRP and RA
 * factor as single tests; LFT, KFT and the Vitamin profile at the package
 * tier. Idempotent.
 */
SET NOCOUNT ON;
INSERT INTO dbo.inf_smart_report_package (master_profile_id, code, created_by)
SELECT m.id, LTRIM(RTRIM(m.Master_Profile_Code)), N'inf:jas'
FROM dbo.tbl_med_test_master_profile_master m
WHERE m.id IN (67, 125)
  AND NOT EXISTS (SELECT 1 FROM dbo.inf_smart_report_package p WHERE p.master_profile_id = m.id);
PRINT CONCAT('packages added: ', @@ROWCOUNT);
INSERT INTO dbo.inf_smart_report_mini (kind, catalogue_id, code, name, mrp, created_by, as_single)
SELECT N'test', t.id, LTRIM(RTRIM(t.TestCode)), LTRIM(RTRIM(t.Testname)), 21, N'inf:jas', 1
FROM dbo.tbl_med_test_master t
WHERE t.id IN (170, 175)
  AND NOT EXISTS (SELECT 1 FROM dbo.inf_smart_report_mini m WHERE m.kind = N'test' AND m.catalogue_id = t.id);
PRINT CONCAT('single tests added: ', @@ROWCOUNT);
GO
