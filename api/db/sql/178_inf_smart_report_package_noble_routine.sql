/*
 * 178_inf_smart_report_package_noble_routine.sql
 *
 * The Noble Routine Packages join the packages the Smart Report is offered
 * with (see 144 for the table and the rule it serves; 145 and 177 for the
 * earlier additions). Asked 04/10/2026, after eight SAMARPAN WALKIN orders
 * on these packages had the booklet added and charged by hand
 * (api/db/data/smart-report-charge-samarpan-20261004.sql): listed here, the
 * order form offers and bills it at booking instead.
 *
 * All five editions, 1.0 to 5.0 - 3.0 included though nobody has ordered it
 * in 90 days, so the set does not have a hole in it.
 *
 * Idempotent: a package already listed is left alone.
 */
SET NOCOUNT ON;

INSERT INTO dbo.inf_smart_report_package (master_profile_id, code, created_by)
SELECT m.id, LTRIM(RTRIM(m.Master_Profile_Code)), N'inf:jas'
FROM dbo.tbl_med_test_master_profile_master m
WHERE m.id IN (
    2394,  -- NOBLE1.0  NOBLE ROUTINE PACKAGE 1.0
    2410,  -- NOBLE2.0  NOBLE ROUTINE PACKAGE 2.0
    2389,  -- NOBLE3.0  NOBLE ROUTINE PACKAGE 3.0
    2408,  -- NOBLE4.0  NOBLE ROUTINE PACKAGE 4.0
    2372)  -- NOBLE5.0  NOBLE ROUTINE PACKAGE 5.0
  AND NOT EXISTS (SELECT 1 FROM dbo.inf_smart_report_package p WHERE p.master_profile_id = m.id);
PRINT CONCAT('Added ', @@ROWCOUNT, ' package(s).');
GO
