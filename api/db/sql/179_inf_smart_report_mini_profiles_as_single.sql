/*
 * 179_inf_smart_report_mini_profiles_as_single.sql
 *
 * The five profiles that still earned the PACKAGE tier on their own move to
 * the single-test rate (asked 05/10/2026): CBC WITH ESR (CBES1, 82), IRON
 * PROFILE (GP12, 25), Kidney Function Test with Electrolytes (CP116, 16),
 * Liver Function Test (CP107, 8) and VITAMIN PROFILE (CP143, 50). From now
 * each counts as one single test for the tier — one of them is the mini
 * tier (₹21 / ₹11), two or more together the multi tier (₹49 / ₹25) — as
 * 163 did for Lipid and Thyroid Profile I. Anemia Profile was not named and
 * keeps the package tier.
 *
 * Idempotent: a row already at as_single = 1 is left alone.
 */
SET NOCOUNT ON;

UPDATE dbo.inf_smart_report_mini
SET as_single = 1
WHERE kind = N'profile' AND as_single = 0
  AND catalogue_id IN (82, 25, 16, 8, 50);
PRINT CONCAT('profiles moved to the single-test rate: ', @@ROWCOUNT);

SELECT m.catalogue_id, m.code, m.name, m.mrp, m.as_single
FROM dbo.inf_smart_report_mini m
WHERE m.kind = N'profile'
ORDER BY m.as_single, m.name;
GO
