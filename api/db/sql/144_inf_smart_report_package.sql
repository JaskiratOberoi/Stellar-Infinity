/*
 * 144_inf_smart_report_package.sql
 *
 * The packages the Smart Report is sold with. The booklet (SMART-RPT, ₹99,
 * a custom line on the order) is built around the HR health packages —
 * their analytes are what its sections, scores and advice are written for —
 * and was being offered on every order regardless. Now it is offered, and
 * accepted at placement, only on an order that carries one of the master
 * profiles listed here.
 *
 * Seeded with the eleven HR packages the booklet was verified against on the
 * ZZTEST01 centre (2026-09-06): the ROHTAK HR201A/HR203A pair, the HR202A and
 * HR204A packages with their extended variants, HR0201 and HR0203 extended,
 * and the UP101/UP0102/UP103 HR profiles. Other "HR"-coded masters (a repeat
 * sugar package, a hormone profile, two cancer profiles) are not health
 * packages and are deliberately absent.
 *
 * To offer the booklet with another package: INSERT its
 * tbl_med_test_master_profile_master.id here. Nothing else changes.
 *
 * Read by CustomTestRepository (the order form's extras) and checked again at
 * placement. Idempotent.
 */
SET NOCOUNT ON;

IF OBJECT_ID('dbo.inf_smart_report_package') IS NULL
BEGIN
    CREATE TABLE dbo.inf_smart_report_package (
        master_profile_id INT           NOT NULL PRIMARY KEY,
        code              NVARCHAR(50)  NULL,
        created_by        NVARCHAR(100) NULL,
        created_at        DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME()
    );
    PRINT 'Created dbo.inf_smart_report_package.';
END
GO

INSERT INTO dbo.inf_smart_report_package (master_profile_id, code, created_by)
SELECT m.id, LTRIM(RTRIM(m.Master_Profile_Code)), N'inf:jas'
FROM dbo.tbl_med_test_master_profile_master m
WHERE m.id IN (200, 201, 202, 203, 212, 213, 214, 2360, 2361, 2457, 2492)
  AND NOT EXISTS (SELECT 1 FROM dbo.inf_smart_report_package p WHERE p.master_profile_id = m.id);
PRINT CONCAT('Seeded ', @@ROWCOUNT, ' package(s).');

SELECT p.master_profile_id, p.code, m.Master_Profile_Name
FROM dbo.inf_smart_report_package p
JOIN dbo.tbl_med_test_master_profile_master m ON m.id = p.master_profile_id
ORDER BY p.master_profile_id;
GO
