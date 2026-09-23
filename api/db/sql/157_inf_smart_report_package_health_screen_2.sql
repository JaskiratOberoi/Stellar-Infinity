/*
 * 157_inf_smart_report_package_health_screen_2.sql
 *
 * Health Screen 2 (HS2, master profile 5) joins the packages the Smart
 * Report is sold with (inf_smart_report_package, 144). Jas asked for it on
 * 2026-09-23 after adding the booklet by hand to a Health Screen 2 patient
 * on JK0213: from now the order form offers the Smart Report on an order
 * that carries HS2, placement accepts it at the package tier (₹99 list,
 * ₹49 on the introductory offer), and the dashboard attributes such sales
 * to HS2 instead of "no qualifying profile" — including that first one,
 * which is attributed by the package on the patient's order.
 *
 * Only HS2 itself. Its siblings — HEALTH SCREEN 2 MD (280), HEALTH SCREEN
 * 2.1 (2398), the JK/SKH/Medigene screens — are separate profiles and are
 * not added here; each is a decision of its own. Idempotent.
 */
SET NOCOUNT ON;
INSERT INTO dbo.inf_smart_report_package (master_profile_id, code, created_by)
SELECT m.id, LTRIM(RTRIM(m.Master_Profile_Code)), N'inf:jas'
FROM dbo.tbl_med_test_master_profile_master m
WHERE m.id = 5
  AND NOT EXISTS (SELECT 1 FROM dbo.inf_smart_report_package p WHERE p.master_profile_id = m.id);
PRINT CONCAT('added: ', @@ROWCOUNT);
SELECT p.master_profile_id, p.code, m.Master_Profile_Name
FROM dbo.inf_smart_report_package p
JOIN dbo.tbl_med_test_master_profile_master m ON m.id = p.master_profile_id
WHERE p.master_profile_id = 5;
GO
