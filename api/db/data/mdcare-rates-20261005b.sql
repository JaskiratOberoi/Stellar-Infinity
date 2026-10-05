/*
 * mdcare-rates-20261005b.sql - MDCARE (unit 5797, private rate list 139),
 * second batch of Jas's price revision of 2026-10-05 (the first four items
 * are mdcare-rates-20261005.sql):
 *
 *   CEA - Carcino embryonic antigen (Serum)   BI068  test 99      770 -> 1100
 *   Thyroid Profile I ("TFT")                 CP114  profile 1    500 ->  550
 *   IRON PROFILE                              GP12   profile 25   500 ->  550
 *   Glucose Tolerance Test 3 samples (GTT)    GTT3N  profile 70   250 ->  275
 *   CREATININE - 24 HR URINE                  BI090  test 271     165 ->  330
 *   Bilirubin (Total Direct & Indirect)       BI046  test 87      220 ->  330
 *   TORCH IgM                                 GP10   profile 22  1000 -> 1100
 *
 * Each name on the sheet maps to the one catalogue item MDCARE has billed
 * at the sheet's "Telo rate" since 1 September; none has a special rate, so
 * the list rows move. Forward only; re-runnable; backups in
 * inf_mdcare_rate_backup_20261005b.
 */
SET NOCOUNT ON;
SET XACT_ABORT ON;

IF (SELECT COUNT(*) FROM dbo.tbl_med_mcc_unit_master WHERE RateType = 139 OR RateTypeBilling = 139) <> 1
    THROW 50000, 'List 139 is no longer MDCARE''s alone; stop.', 1;

IF EXISTS (SELECT 1 FROM dbo.tbl_med_mcc_test_special_rates WHERE mcccode = 5797
           AND LTRIM(RTRIM(testcode)) IN ('CP114','GP12','GTT3N','GP10','BI068','BI090','BI046'))
    THROW 50000, 'A special rate now exists for one of these; it would outrank the list. Stop.', 1;

IF OBJECT_ID('dbo.inf_mdcare_rate_backup_20261005b') IS NULL
BEGIN
    SELECT 'P' AS kind, CAST(id AS INT) AS id, profilecode AS item, RateTypeId, Price, IsActive, SYSUTCDATETIME() AS taken_at
    INTO dbo.inf_mdcare_rate_backup_20261005b
    FROM dbo.tbl_med_profile_rates_with_pcc_types WHERE RateTypeId = 139 AND profilecode IN (1, 22, 25, 70);
    INSERT INTO dbo.inf_mdcare_rate_backup_20261005b (kind, id, item, RateTypeId, Price, IsActive, taken_at)
    SELECT 'T', id, TestCode, RateTypeId, Price, IsActive, SYSUTCDATETIME()
    FROM dbo.tbl_med_test_rates_with_pcc_type WHERE RateTypeId = 139 AND TestCode IN (87, 99, 271);
END

BEGIN TRAN;
UPDATE dbo.tbl_med_profile_rates_with_pcc_types SET Price = 550  WHERE RateTypeId = 139 AND profilecode IN (1, 25) AND Price = 500;
UPDATE dbo.tbl_med_profile_rates_with_pcc_types SET Price = 275  WHERE RateTypeId = 139 AND profilecode = 70 AND Price = 250;
UPDATE dbo.tbl_med_profile_rates_with_pcc_types SET Price = 1100 WHERE RateTypeId = 139 AND profilecode = 22 AND Price = 1000;
UPDATE dbo.tbl_med_test_rates_with_pcc_type     SET Price = 1100 WHERE RateTypeId = 139 AND TestCode = 99  AND Price = 770;
UPDATE dbo.tbl_med_test_rates_with_pcc_type     SET Price = 330  WHERE RateTypeId = 139 AND TestCode = 271 AND Price = 165;
UPDATE dbo.tbl_med_test_rates_with_pcc_type     SET Price = 330  WHERE RateTypeId = 139 AND TestCode = 87  AND Price = 220;
COMMIT;

SELECT 'P' kind, p.Profile_Code code, p.Profile_Name name, r.Price
FROM dbo.tbl_med_profile_rates_with_pcc_types r JOIN dbo.tbl_med_test_profile_master p ON p.id = r.profilecode
WHERE r.RateTypeId = 139 AND r.profilecode IN (1, 22, 25, 70)
UNION ALL
SELECT 'T', t.TestCode, t.Testname, r.Price
FROM dbo.tbl_med_test_rates_with_pcc_type r JOIN dbo.tbl_med_test_master t ON t.id = r.TestCode
WHERE r.RateTypeId = 139 AND r.TestCode IN (87, 99, 271);
