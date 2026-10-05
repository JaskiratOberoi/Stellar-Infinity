/*
 * mdcare-rates-20261005.sql - MDCARE (unit 5797, private rate list 139) price
 * revision, on Jas's instruction of 2026-10-05:
 *
 *   Liver Function Test (CP107, profile 8)                 500 -> 550
 *   KFT WITH ELECTROLYTES (KFTELEC01, profile 128)         500 -> 550
 *   Kidney Function Test with Electrolytes (CP116, 16)     500 -> 550
 *   LIPID PROFILE (CP106, profile 7)                       450 -> 495
 *   PSA (Prostate Specific Antigen) Total (BI181, test 151) 650 -> 715
 *
 * Both KFT-with-electrolytes profiles are on the list at 500 and MDCARE
 * bills both, so both move. PSA's list row already says 715; the 650 came
 * from a per-centre special rate (17 Jul 2026), which outranks the list, so
 * that row is revised rather than the list.
 *
 * List 139 is MDCARE's alone (no other centre points at it), so nothing
 * else changes. Live the moment it runs - Telo, Infinity and the LIS all
 * resolve from these rows. Forward only: bills already raised are handled
 * separately. Re-runnable. Backups: inf_mdcare_rate_backup_20261005.
 */
SET NOCOUNT ON;
SET XACT_ABORT ON;

/* A partial backup from a failed run (identity copied by SELECT INTO) is
   dropped and retaken; the table is this script's own. */
IF OBJECT_ID('dbo.inf_mdcare_rate_backup_20261005') IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM dbo.inf_mdcare_rate_backup_20261005 WHERE kind = 'S')
    DROP TABLE dbo.inf_mdcare_rate_backup_20261005;

IF (SELECT COUNT(*) FROM dbo.tbl_med_mcc_unit_master WHERE RateType = 139 OR RateTypeBilling = 139) <> 1
    THROW 50000, 'List 139 is no longer MDCARE''s alone; stop.', 1;

IF OBJECT_ID('dbo.inf_mdcare_rate_backup_20261005') IS NULL
BEGIN
    SELECT 'P' AS kind, CAST(id AS INT) AS id, profilecode AS item, RateTypeId, Price, IsActive, SYSUTCDATETIME() AS taken_at
    INTO dbo.inf_mdcare_rate_backup_20261005
    FROM dbo.tbl_med_profile_rates_with_pcc_types WHERE RateTypeId = 139 AND profilecode IN (7, 8, 16, 128);
    INSERT INTO dbo.inf_mdcare_rate_backup_20261005 (kind, id, item, RateTypeId, Price, IsActive, taken_at)
    SELECT 'S', id, testid, 5797, rate, 1, SYSUTCDATETIME()
    FROM dbo.tbl_med_mcc_test_special_rates WHERE mcccode = 5797 AND testtype = 'T' AND testid = 151;
END

BEGIN TRAN;

UPDATE dbo.tbl_med_profile_rates_with_pcc_types SET Price = 550
WHERE RateTypeId = 139 AND profilecode IN (8, 16, 128) AND Price = 500;

UPDATE dbo.tbl_med_profile_rates_with_pcc_types SET Price = 495
WHERE RateTypeId = 139 AND profilecode = 7 AND Price = 450;

UPDATE dbo.tbl_med_mcc_test_special_rates SET rate = 715
WHERE mcccode = 5797 AND testtype = 'T' AND testid = 151 AND rate = 650;

COMMIT;

SELECT 'P' kind, p.Profile_Code code, p.Profile_Name name, r.Price
FROM dbo.tbl_med_profile_rates_with_pcc_types r JOIN dbo.tbl_med_test_profile_master p ON p.id = r.profilecode
WHERE r.RateTypeId = 139 AND r.profilecode IN (7, 8, 16, 128)
UNION ALL
SELECT 'S', s.testcode, s.testname, s.rate
FROM dbo.tbl_med_mcc_test_special_rates s WHERE s.mcccode = 5797 AND s.testtype = 'T' AND s.testid = 151;
