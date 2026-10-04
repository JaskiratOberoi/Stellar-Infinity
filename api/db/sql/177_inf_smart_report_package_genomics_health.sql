/*
 * 177_inf_smart_report_package_genomics_health.sql
 *
 * The Genomics Health packages join the packages the Smart Report is offered
 * with (see 144 for the table and the rule it serves; 145 for Health Package
 * 1-3). Asked 04/10/2026: Genomics Health 40, Pro, VK, Male and Female - the
 * Female in both its forms, with and without CA125.
 *
 * Their analytes - blood count, sugar, lipids, liver, kidney, thyroid, iron,
 * vitamins, urine, and the tumour markers the Male/Female forms add - all
 * resolve to the booklet's chapters (checked against smart-meta.json on the
 * day).
 *
 * NOT included, deliberately, until asked: the regional and extended
 * variants - 40 Plus (126), Army (151) and Jhansi (198) Health 40, Male with
 * PSA (199) and with Testosterone (2364), Pro 1 (2429) and Pro 2 (2431).
 *
 * Idempotent: a package already listed is left alone.
 */
SET NOCOUNT ON;

INSERT INTO dbo.inf_smart_report_package (master_profile_id, code, created_by)
SELECT m.id, LTRIM(RTRIM(m.Master_Profile_Code)), N'inf:jas'
FROM dbo.tbl_med_test_master_profile_master m
WHERE m.id IN (
    121,   -- GH40    GENOMICS HEALTH 40
    119,   -- GHP001  GENOMICS HEALTH PRO
    120,   -- GHVK    GENOMICS HEALTH VK
    117,   -- GHM01   GENOMICS HEALTH MALE
    132,   -- GHF01U  GENOMICS HEALTH FEMALE
    118)   -- GHF01   GENOMICS HEALTH FEMALE WITH CA125
  AND NOT EXISTS (SELECT 1 FROM dbo.inf_smart_report_package p WHERE p.master_profile_id = m.id);
PRINT CONCAT('Added ', @@ROWCOUNT, ' package(s).');

SELECT p.master_profile_id, p.code, name = LTRIM(RTRIM(m.Master_Profile_Name))
FROM dbo.inf_smart_report_package p
JOIN dbo.tbl_med_test_master_profile_master m ON m.id = p.master_profile_id
WHERE p.master_profile_id IN (121, 119, 120, 117, 132, 118)
ORDER BY p.master_profile_id;
GO
