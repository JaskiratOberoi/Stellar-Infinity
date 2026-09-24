/*
 * 162_inf_smart_report_package_health_care_profiles.sql
 *
 * The four HEALTH CARE PROFILE packages join the packages the Smart Report is
 * sold with (inf_smart_report_package, 144): P035A 1.1 (209), P036A 1.2 (210),
 * P037A 1.3 (211), P038A 1.4 (216). Asked by Jas on 2026-09-24. Package tier:
 * ₹99 list, ₹49 on the introductory offer. Only these four; the catalogue is
 * untouched. Idempotent.
 */
SET NOCOUNT ON;
INSERT INTO dbo.inf_smart_report_package (master_profile_id, code, created_by)
SELECT m.id, LTRIM(RTRIM(m.Master_Profile_Code)), N'inf:jas'
FROM dbo.tbl_med_test_master_profile_master m
WHERE m.id IN (209, 210, 211, 216)
  AND NOT EXISTS (SELECT 1 FROM dbo.inf_smart_report_package p WHERE p.master_profile_id = m.id);
PRINT CONCAT('added: ', @@ROWCOUNT);
GO
