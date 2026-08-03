/*
 * 92_inspect_result_columns.sql
 *
 * READ-ONLY. Prints the columns of tbl_med_mcc_patient_test_result, the table
 * every write path touches. Writes nothing.
 */
SET NOCOUNT ON;

DECLARE @cols NVARCHAR(MAX) = N'';
SELECT @cols = @cols + '  ' + c.COLUMN_NAME + ' ' + c.DATA_TYPE
              + CASE WHEN c.CHARACTER_MAXIMUM_LENGTH IS NOT NULL
                     THEN '(' + CASE WHEN c.CHARACTER_MAXIMUM_LENGTH = -1 THEN 'max'
                                     ELSE CAST(c.CHARACTER_MAXIMUM_LENGTH AS VARCHAR(10)) END + ')'
                     ELSE '' END + CHAR(10)
FROM INFORMATION_SCHEMA.COLUMNS c
WHERE c.TABLE_SCHEMA = 'dbo' AND c.TABLE_NAME = 'tbl_med_mcc_patient_test_result'
ORDER BY c.ORDINAL_POSITION;

PRINT 'tbl_med_mcc_patient_test_result:';
PRINT ISNULL(@cols, '  (not found)');
GO
