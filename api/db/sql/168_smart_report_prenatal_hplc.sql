/*
 * 168_smart_report_prenatal_hplc.sql
 *
 * The Smart Report is offered with the prenatal screening reports and the
 * HPLC haemoglobin study, as Jas asked on 2026-10-02: Double Marker Test
 * (BI244A, 1989), Triple Marker with Graph (cp113, 1809), Quadruple Markers
 * with Graph (BC0002, 1810), Dual Marker Plus with pre-eclampsia (BI314,
 * 2216) and Hb Electrophoresis / HPLC (HE022, 679). The booklet gained two
 * chapters for them in the same change - Pregnancy Screening and Haemoglobin
 * Type - so the risk ratios and the haemoglobin fractions are explained
 * rather than listed under "Other".
 *
 * Single-test tier, like every 'test' row (163). The Kryptor and penta
 * variants are not listed: a handful of orders a year, and their rows are
 * shaped the same, so they can join when they are sold. Idempotent.
 */
SET NOCOUNT ON;

INSERT INTO dbo.inf_smart_report_mini (kind, catalogue_id, code, name, mrp, created_by, as_single)
SELECT N'test', t.id, LTRIM(RTRIM(t.TestCode)), LTRIM(RTRIM(t.Testname)), 21, N'inf:jas', 1
FROM dbo.tbl_med_test_master t
WHERE t.id IN (1989, 1809, 1810, 2216, 679)
  AND NOT EXISTS (SELECT 1 FROM dbo.inf_smart_report_mini m WHERE m.kind = N'test' AND m.catalogue_id = t.id);
PRINT CONCAT('tests added: ', @@ROWCOUNT);

SELECT kind, catalogue_id, code, name FROM dbo.inf_smart_report_mini
WHERE kind = N'test' AND catalogue_id IN (1989, 1809, 1810, 2216, 679) ORDER BY catalogue_id;
GO
