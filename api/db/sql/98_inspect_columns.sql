/*
 * 98_inspect_columns.sql
 *
 * READ-ONLY schema probe. Writes nothing. Prints the columns of the LIS tables
 * Infinity's reads depend on, so query authors can check names against reality
 * instead of guessing — the legacy schema is inconsistent enough that guessing
 * reliably produces "Invalid column name" at runtime.
 */
SET NOCOUNT ON;

DECLARE @t SYSNAME, @cols NVARCHAR(MAX);

DECLARE tables CURSOR LOCAL FAST_FORWARD FOR
    SELECT v.name FROM (VALUES
        ('tbl_billing_patient_amount_receipt'),
        ('tbl_billing_patient_detail'),
        ('tbl_med_user_sales_mcc_mapping')
    ) AS v(name);

OPEN tables;
FETCH NEXT FROM tables INTO @t;
WHILE @@FETCH_STATUS = 0
BEGIN
    SET @cols = NULL;
    SELECT @cols = COALESCE(@cols + N', ', N'') + c.COLUMN_NAME + N':' + c.DATA_TYPE
    FROM INFORMATION_SCHEMA.COLUMNS c
    WHERE c.TABLE_SCHEMA = 'dbo' AND c.TABLE_NAME = @t
    ORDER BY c.ORDINAL_POSITION;

    PRINT '=== ' + @t + ' ===';
    PRINT ISNULL(@cols, '  (table not found)');
    PRINT '';

    FETCH NEXT FROM tables INTO @t;
END
CLOSE tables;
DEALLOCATE tables;
GO
