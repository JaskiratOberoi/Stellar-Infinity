/*
 * 167_smart_report_anti_ccp_standard.sql
 * The general Anti-CCP (BI036, 629) joins the single-test tier beside the
 * Kashmir CLIA variant added by 166. Idempotent.
 */
SET NOCOUNT ON;
INSERT INTO dbo.inf_smart_report_mini (kind, catalogue_id, code, name, mrp, created_by, as_single)
SELECT N'test', t.id, LTRIM(RTRIM(t.TestCode)), LTRIM(RTRIM(t.Testname)), 21, N'inf:jas', 1
FROM dbo.tbl_med_test_master t
WHERE t.id = 629
  AND NOT EXISTS (SELECT 1 FROM dbo.inf_smart_report_mini m WHERE m.kind = N'test' AND m.catalogue_id = t.id);
PRINT CONCAT('added: ', @@ROWCOUNT);
GO
