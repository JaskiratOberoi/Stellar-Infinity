/*
 * 163_inf_smart_report_mini_as_single.sql
 *
 * Five more items the Smart Report is sold with, all at the SINGLE-TEST
 * tier (₹21 / ₹11 for one, ₹49 / ₹25 for two or more), as Jas asked on
 * 2026-09-25: LIPID PROFILE (CP106, 7) and Thyroid Profile I (CP114, 1) —
 * profiles in the catalogue, priced as single tests here — and the tests
 * C-Reactive Protein (MS024, 113), Rheumatoid Arthritis Factor by
 * nephelometry (MS111, 1890) and Testosterone - Total (BI209, 158). The
 * most-ordered active variant of each was taken (Thyroid Profile I over
 * Thyroid Profile Free; CRP over hs-CRP; nephelometry over latex).
 *
 * Until now a supported PROFILE always earned the package tier (160). A
 * new column says otherwise per item: as_single = 1 means "count this as a
 * single test whatever the catalogue calls it". The existing profile rows
 * (LFT, KFT, CBC with ESR, iron, vitamins, anemia) keep as_single = 0 and
 * their package-tier price. Idempotent.
 */
SET NOCOUNT ON;
IF COL_LENGTH('dbo.inf_smart_report_mini', 'as_single') IS NULL
BEGIN
    ALTER TABLE dbo.inf_smart_report_mini
        ADD as_single BIT NOT NULL CONSTRAINT DF_inf_smart_report_mini_as_single DEFAULT (0);
    PRINT 'Added inf_smart_report_mini.as_single.';
END
GO
INSERT INTO dbo.inf_smart_report_mini (kind, catalogue_id, code, name, mrp, created_by, as_single)
SELECT N'profile', p.id, LTRIM(RTRIM(p.Profile_Code)), LTRIM(RTRIM(p.Profile_Name)), 21, N'inf:jas', 1
FROM dbo.tbl_med_test_profile_master p
WHERE p.id IN (7, 1)
  AND NOT EXISTS (SELECT 1 FROM dbo.inf_smart_report_mini m WHERE m.kind = N'profile' AND m.catalogue_id = p.id);
PRINT CONCAT('profiles added as single: ', @@ROWCOUNT);
INSERT INTO dbo.inf_smart_report_mini (kind, catalogue_id, code, name, mrp, created_by, as_single)
SELECT N'test', t.id, LTRIM(RTRIM(t.TestCode)), LTRIM(RTRIM(t.Testname)), 21, N'inf:jas', 1
FROM dbo.tbl_med_test_master t
WHERE t.id IN (113, 1890, 158)
  AND NOT EXISTS (SELECT 1 FROM dbo.inf_smart_report_mini m WHERE m.kind = N'test' AND m.catalogue_id = t.id);
PRINT CONCAT('tests added: ', @@ROWCOUNT);
-- Every 'test' row counts as a single test by definition.
UPDATE dbo.inf_smart_report_mini SET as_single = 1 WHERE kind = N'test' AND as_single = 0;
GO
SELECT kind, catalogue_id, code, name, as_single FROM dbo.inf_smart_report_mini ORDER BY as_single DESC, kind, name;
GO
