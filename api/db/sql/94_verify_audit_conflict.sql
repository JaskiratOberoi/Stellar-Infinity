/*
 * 94_verify_audit_conflict.sql
 *
 * READ-ONLY. Reports which audit-related objects actually exist in Noble and
 * what the live inf_result_audit column names are, so a schema collision
 * between two parallel implementations can be resolved against reality rather
 * than against what either script claims. Writes nothing.
 */
SET NOCOUNT ON;

PRINT 'Deployed objects:';
DECLARE @objects TABLE (name SYSNAME, kind CHAR(1));
INSERT INTO @objects VALUES
    ('dbo.inf_result_audit','U'), ('dbo.inf_auth_audit','U'),
    ('dbo.inf_auto_auth_config','U'), ('dbo.inf_auto_auth_audit','U'),
    ('dbo.usp_inf_worksheet_sample','P'), ('dbo.usp_inf_result_save','P'),
    ('dbo.usp_inf_result_reopen','P'), ('dbo.usp_inf_result_audit_read','P');

DECLARE @n SYSNAME, @k CHAR(1);
DECLARE c CURSOR LOCAL FAST_FORWARD FOR SELECT name, kind FROM @objects;
OPEN c; FETCH NEXT FROM c INTO @n, @k;
WHILE @@FETCH_STATUS = 0
BEGIN
    PRINT '  ' + LEFT(@n + REPLICATE(' ', 34), 34)
        + CASE WHEN OBJECT_ID(@n, @k) IS NULL THEN 'not deployed' ELSE 'DEPLOYED' END;
    FETCH NEXT FROM c INTO @n, @k;
END
CLOSE c; DEALLOCATE c;

PRINT '';
PRINT 'TYPE dbo.InfResultEdit: ' + CASE WHEN TYPE_ID('dbo.InfResultEdit') IS NULL THEN 'not deployed' ELSE 'DEPLOYED' END;

PRINT '';
PRINT 'Live dbo.inf_result_audit columns:';
DECLARE @cols NVARCHAR(MAX) = N'';
SELECT @cols = @cols + '  ' + c.COLUMN_NAME + ' ' + c.DATA_TYPE
              + CASE WHEN c.CHARACTER_MAXIMUM_LENGTH IS NOT NULL
                     THEN '(' + CASE WHEN c.CHARACTER_MAXIMUM_LENGTH = -1 THEN 'max'
                                     ELSE CAST(c.CHARACTER_MAXIMUM_LENGTH AS VARCHAR(10)) END + ')'
                     ELSE '' END
              + CASE WHEN c.IS_NULLABLE = 'NO' THEN ' NOT NULL' ELSE '' END + CHAR(10)
FROM INFORMATION_SCHEMA.COLUMNS c
WHERE c.TABLE_SCHEMA = 'dbo' AND c.TABLE_NAME = 'inf_result_audit'
ORDER BY c.ORDINAL_POSITION;
PRINT ISNULL(@cols, '  (table not present)');

DECLARE @rows INT = 0;
IF OBJECT_ID('dbo.inf_result_audit','U') IS NOT NULL
    SELECT @rows = COUNT(*) FROM dbo.inf_result_audit;
PRINT 'Rows currently in the trail: ' + CAST(@rows AS VARCHAR(20));
GO
