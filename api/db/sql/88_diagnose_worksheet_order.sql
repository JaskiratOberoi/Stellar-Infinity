/*
 * 88_diagnose_worksheet_order.sql
 *
 * READ-ONLY. Prints a multi-section sample's result rows in RAW INSERTION
 * ORDER (by id) and in the order usp_inf_worksheet_sample currently returns
 * them, side by side.
 *
 * The question it answers: does the LIS already store Head rows interleaved
 * with the analytes they introduce, or do they need sorting into place? If the
 * raw order is already correct, any ORDER BY that touches testtype destroys it.
 */
SET NOCOUNT ON;

-- A urine examination: several Head sections under one Profile, which is where
-- the bunching shows up.
DECLARE @sid NVARCHAR(50) =
    (SELECT TOP 1 r.vailid
     FROM dbo.tbl_med_mcc_patient_test_result r
     WHERE r.testtype = 'Head'
     GROUP BY r.vailid
     HAVING COUNT(*) >= 3
     ORDER BY MAX(r.id) DESC);

IF @sid IS NULL
BEGIN
    PRINT 'No sample with 3+ Head rows found.';
    RETURN;
END

PRINT 'Sample: ' + @sid;
PRINT '';
PRINT 'RAW INSERTION ORDER (ORDER BY r.id) — what the LIS itself prints:';

DECLARE @raw NVARCHAR(MAX) = N'';
SELECT TOP 22 @raw = @raw + '  ' + RIGHT('      ' + CAST(r.id AS VARCHAR(10)), 8)
                    + '  ' + LEFT(r.testtype + '        ', 8)
                    + '  ' + LEFT(ISNULL(r.testname, '(none)'), 44) + CHAR(10)
FROM dbo.tbl_med_mcc_patient_test_result r
WHERE r.vailid = @sid
ORDER BY r.id;
PRINT @raw;

PRINT 'CURRENT PROCEDURE ORDER (master_profile_id, profile_id, testtype, id):';

DECLARE @cur NVARCHAR(MAX) = N'';
SELECT TOP 22 @cur = @cur + '  ' + RIGHT('      ' + CAST(r.id AS VARCHAR(10)), 8)
                    + '  ' + LEFT(r.testtype + '        ', 8)
                    + '  ' + LEFT(ISNULL(r.testname, '(none)'), 44) + CHAR(10)
FROM dbo.tbl_med_mcc_patient_test_result r
WHERE r.vailid = @sid
ORDER BY r.master_profile_id, r.profile_id,
         CASE r.testtype WHEN 'Head' THEN 0 WHEN 'Profile' THEN 1 WHEN 'Test' THEN 2 ELSE 3 END,
         r.id;
PRINT @cur;
GO
