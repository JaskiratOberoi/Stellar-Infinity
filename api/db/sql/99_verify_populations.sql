/*
 * 99_verify_populations.sql
 *
 * READ-ONLY diagnostic. Writes nothing; safe to run any time.
 *
 * Reports how many accounts fall into each of the three login populations that
 * usp_inf_authenticate distinguishes, and how many of each would actually be
 * admitted. Run it after deploying, and any time the login rules are changed,
 * to confirm nobody has been accidentally locked out.
 *
 * Output goes through PRINT so the deploy tool surfaces it.
 */
SET NOCOUNT ON;

DECLARE
    @inf_total INT, @inf_ok INT,
    @telo_total INT, @telo_ok INT,
    @lis_total INT, @lis_ok INT,
    @inf_lis_granted INT;

SELECT
    @inf_total = COUNT(*),
    @inf_ok    = SUM(CASE WHEN ia.inf_active = 1 THEN 1 ELSE 0 END),
    @inf_lis_granted = SUM(CASE WHEN ia.lis_access = 1 THEN 1 ELSE 0 END)
FROM dbo.tbl_med_user_master u
JOIN dbo.inf_account ia ON ia.user_id = u.id;

SELECT
    @telo_total = COUNT(*),
    @telo_ok    = SUM(CASE WHEN ta.telo_active = 1 THEN 1 ELSE 0 END)
FROM dbo.tbl_med_user_master u
JOIN dbo.telo_account ta ON ta.user_id = u.id
LEFT JOIN dbo.inf_account ia ON ia.user_id = u.id
WHERE ia.user_id IS NULL;

SELECT
    @lis_total = COUNT(*),
    @lis_ok    = SUM(CASE WHEN ISNULL(u.IsActive, 0) = 1 THEN 1 ELSE 0 END)
FROM dbo.tbl_med_user_master u
LEFT JOIN dbo.inf_account ia  ON ia.user_id = u.id
LEFT JOIN dbo.telo_account ta ON ta.user_id = u.id
WHERE ia.user_id IS NULL AND ta.user_id IS NULL;

PRINT 'Population              Total   May sign in to Infinity';
PRINT '----------------------------------------------------------';
PRINT 'Infinity-managed        ' + RIGHT('     ' + CAST(ISNULL(@inf_total,0)  AS VARCHAR(10)), 5)
                            + '   ' + CAST(ISNULL(@inf_ok,0)   AS VARCHAR(10));
PRINT 'Telo-managed            ' + RIGHT('     ' + CAST(ISNULL(@telo_total,0) AS VARCHAR(10)), 5)
                            + '   ' + CAST(ISNULL(@telo_ok,0)  AS VARCHAR(10));
PRINT 'Native LIS              ' + RIGHT('     ' + CAST(ISNULL(@lis_total,0)  AS VARCHAR(10)), 5)
                            + '   ' + CAST(ISNULL(@lis_ok,0)   AS VARCHAR(10));
PRINT '----------------------------------------------------------';
PRINT 'Infinity accounts granted legacy-LIS login: '
      + CAST(ISNULL(@inf_lis_granted,0) AS VARCHAR(10));
GO
