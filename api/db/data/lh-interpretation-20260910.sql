/*
 * lh-interpretation-20260910.sql
 *
 * LH (test 138, BI145) carried its "This test is performed for" list as
 * "1>An adjunct…", "2>Evaluating…" — the digit followed by an angle bracket
 * and no space, on the legacy report and on Infinity's alike. The only
 * interpretation in the catalogue written that way. Rewritten as
 * "1. An adjunct…", the numbered-list form the rest of the catalogue uses.
 * The interpretation prints live from the catalogue, so every LH report is
 * corrected the next time it is drawn.
 *
 * Asked for on 2026-09-10. Idempotent: a row already without ">" is
 * untouched.
 */
SET NOCOUNT ON;

UPDATE dbo.tbl_med_test_master
   SET Interpretation = REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
                            CAST(Interpretation AS NVARCHAR(MAX)),
                            N'1>', N'1. '), N'2>', N'2. '), N'3>', N'3. '), N'4>', N'4. '), N'5>', N'5. '),
       ModifiedBy = N'inf:jas',
       ModifiedDate = GETDATE()
 WHERE id = 138
   AND CAST(Interpretation AS NVARCHAR(MAX)) LIKE N'%[0-9]>%';
PRINT CONCAT('Updated ', @@ROWCOUNT, ' row(s).');

SELECT id, TestCode, CAST(Interpretation AS NVARCHAR(MAX)) AS interpretation FROM dbo.tbl_med_test_master WHERE id = 138;
