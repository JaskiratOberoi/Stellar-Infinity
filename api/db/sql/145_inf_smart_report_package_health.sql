/*
 * 145_inf_smart_report_package_health.sql
 *
 * Health Package 1, 2 and 3 join the packages the Smart Report is offered
 * with (see 144 for the table and the rule it serves). Their analytes -
 * blood count, lipids, liver, kidney, thyroid, iron, sugar, urine, vitamins
 * - are the ones the booklet's sections are written for, and the demo
 * patients of 903 show it on all three.
 *
 * Idempotent: a package already listed is left alone.
 */
SET NOCOUNT ON;

INSERT INTO dbo.inf_smart_report_package (master_profile_id, code, created_by)
SELECT m.id, LTRIM(RTRIM(m.Master_Profile_Code)), N'inf:jas'
FROM dbo.tbl_med_test_master_profile_master m
WHERE m.id IN (187, 190, 197)   -- HPK01 Health Package 1, HPK002 Health Package 2, HPK003 Health Package 3
  AND NOT EXISTS (SELECT 1 FROM dbo.inf_smart_report_package p WHERE p.master_profile_id = m.id);
PRINT CONCAT('Added ', @@ROWCOUNT, ' package(s).');
GO
