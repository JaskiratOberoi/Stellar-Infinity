/*
 * hbsag-method-20260909.sql
 *
 * Hepatitis B Surface Antigen (test 777, MS055) carried the same misspelt
 * method as Typhidot IgG did — "IMMUNOCHROMATOGRPHY". Corrected to
 * "Immunochromatography", the spelling and casing the rest of the catalogue
 * uses. The method prints live from the catalogue, so every report of the
 * test is corrected the next time it is drawn.
 *
 * Asked for on 2026-09-09, following typhidot-igg-method-20260909.sql.
 * Idempotent.
 */
SET NOCOUNT ON;

UPDATE dbo.tbl_med_test_master
   SET Method = N'Immunochromatography',
       ModifiedBy = N'inf:jas',
       ModifiedDate = GETDATE()
 WHERE id = 777
   AND Method <> N'Immunochromatography';
PRINT CONCAT('Updated ', @@ROWCOUNT, ' row(s).');

SELECT id, TestCode, TestName, Method FROM dbo.tbl_med_test_master WHERE id = 777;
SELECT COUNT(*) AS misspelt_left FROM dbo.tbl_med_test_master WHERE Method LIKE N'%GRPHY%';
