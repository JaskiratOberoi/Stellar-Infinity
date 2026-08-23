/*
 * 89_diagnose_user_scope.sql
 *
 * READ-ONLY. For each Infinity-relevant user, shows what the OPERATIONAL scope
 * and the REPORT scope actually resolve to, so an empty worklist can be traced
 * to its cause rather than guessed at. Writes nothing.
 *
 * The two resolutions are deliberately different (see ScopeRepository), and the
 * difference is exactly where an admin can end up seeing orders but no
 * worksheet: the operational branch grants Super Admin / Admin every centre,
 * while the report branch is mappings ∪ own centre for EVERY usertype.
 *
 * SUPERSEDED for parity questions by 127_verify_lis_scope_parity.sql. This
 * script predates the LIS-parity rule (a non-client account with no mappings
 * and no own centre now resolves to EVERY centre, both scopes), so its counts
 * show 0 where the live resolution is "all" for such users. 127 computes the
 * current rules for every account and diffs them against the LIS's.
 */
SET NOCOUNT ON;

DECLARE @totalMcc INT = (SELECT COUNT(*) FROM dbo.tbl_med_mcc_unit_master);
PRINT 'Total MCC units: ' + CAST(@totalMcc AS VARCHAR(20));
PRINT '';
PRINT 'username             utype  operational  report  mappings  own_centre';
PRINT '--------------------------------------------------------------------';

DECLARE @line NVARCHAR(MAX) = N'';

SELECT @line = @line
    + LEFT(u.Username + REPLICATE(' ', 21), 21)
    + LEFT(CAST(ISNULL(u.usertypeid, 0) AS VARCHAR(6)) + REPLICATE(' ', 7), 7)
    + LEFT(CASE WHEN u.usertypeid IN (1, 5) THEN CAST(@totalMcc AS VARCHAR(10)) + ' (all)'
                ELSE CAST((
                    SELECT COUNT(DISTINCT x.mcc_code) FROM (
                        SELECT m.mcc_code FROM dbo.tbl_med_user_sales_mcc_mapping m
                        WHERE m.user_id = u.id AND m.mcc_code IS NOT NULL
                        UNION SELECT u.PCC_Id WHERE u.PCC_Id > 0
                        UNION SELECT u.sub_pcc_id WHERE u.sub_pcc_id > 0
                    ) x) AS VARCHAR(10))
           END + REPLICATE(' ', 13), 13)
    -- The report branch has NO unrestricted case: it is mappings + own centre
    -- for everyone, Super Admin included.
    + LEFT(CAST((
        SELECT COUNT(DISTINCT x.mcc_code) FROM (
            SELECT m.mcc_code FROM dbo.tbl_med_user_sales_mcc_mapping m
            WHERE m.user_id = u.id AND m.mcc_code IS NOT NULL
            UNION SELECT u.PCC_Id WHERE u.PCC_Id > 0
            UNION SELECT u.sub_pcc_id WHERE u.sub_pcc_id > 0
        ) x) AS VARCHAR(10)) + REPLICATE(' ', 8), 8)
    + LEFT(CAST((SELECT COUNT(*) FROM dbo.tbl_med_user_sales_mcc_mapping m
                 WHERE m.user_id = u.id) AS VARCHAR(10)) + REPLICATE(' ', 10), 10)
    + ISNULL(CAST(NULLIF(u.PCC_Id, 0) AS VARCHAR(10)), 'none')
    + CHAR(10)
FROM dbo.tbl_med_user_master u
WHERE u.usertypeid IN (1, 5)
   OR EXISTS (SELECT 1 FROM dbo.inf_user_role r WHERE r.user_id = u.id)
   OR EXISTS (SELECT 1 FROM dbo.inf_account a WHERE a.user_id = u.id);

PRINT ISNULL(@line, '  (no users matched)');
GO
