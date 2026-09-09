/*
 * typhidot-igg-method-20260909.sql
 *
 * Typhidot IgG (test 2206, CP3121) carried the method "IMMUNOCHROMATOGRPHY"
 * in the test master — misspelt and shouting — beside IgM's
 * "Immunochromatography". The method prints live from the catalogue (not
 * snapshotted onto the result row), so this corrects every report of the
 * test, past and future, the next time it is drawn.
 *
 * Asked for on 2026-09-09. Idempotent.
 */
SET NOCOUNT ON;

UPDATE dbo.tbl_med_test_master
   SET Method = N'Immunochromatography',
       ModifiedBy = N'inf:jas',
       ModifiedDate = GETDATE()
 WHERE id = 2206
   AND Method <> N'Immunochromatography';
PRINT CONCAT('Updated ', @@ROWCOUNT, ' row(s).');

SELECT id, TestCode, TestName, Method FROM dbo.tbl_med_test_master WHERE id IN (213, 2206);
