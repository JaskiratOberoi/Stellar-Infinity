/*
 * 158_inf_smart_report_mini_uric_vitd_fbs.sql
 *
 * Three single tests join the mini tier the Smart Report is sold with on a
 * B2B order (inf_smart_report_mini, 148): Uric acid (BI227, 173), VITAMIN D
 * (BI005, 74) and Glucose - Fasting (BI114, 284). Asked by Jas on
 * 2026-09-24 at the same terms as the rest of the tier — ₹21 list, ₹11
 * while the introductory offer runs (inf_smart_report_offer, till Diwali
 * 2026), and from that day the list price with nobody switching anything.
 *
 * The booklet has copy for all three (its knowledge base matches "URIC
 * ACID", "VITAMIN D" / "25-OH", and "FASTING ... GLUCOSE"), so a patient who
 * came for one of them gets a coherent single-chapter booklet. Each is a
 * plain single-value test in the catalogue, which is untouched. Idempotent.
 */
SET NOCOUNT ON;
INSERT INTO dbo.inf_smart_report_mini (kind, catalogue_id, code, name, mrp, created_by)
SELECT N'test', t.id, LTRIM(RTRIM(t.TestCode)), LTRIM(RTRIM(t.Testname)), 21, N'inf:jas'
FROM dbo.tbl_med_test_master t
WHERE t.id IN (173, 74, 284)
  AND NOT EXISTS (SELECT 1 FROM dbo.inf_smart_report_mini m WHERE m.kind = N'test' AND m.catalogue_id = t.id);
PRINT CONCAT('added: ', @@ROWCOUNT);
GO
