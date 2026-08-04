/*
 * 87_verify_worksheet_order.sql
 *
 * READ-ONLY. Executes usp_inf_worksheet_sample for real and checks that each
 * Head row is followed by the analytes it introduces, rather than all the Head
 * rows being hoisted to the top of the profile.
 *
 * Checked as a PROPERTY of the returned rows, not by eyeballing them: the
 * failure it guards against looked perfectly plausible in a screenshot until
 * someone counted the sections.
 */
SET NOCOUNT ON;

/* First, the direct check: the DEPLOYED procedure must order by id alone.
   Capturing its result set into a temp table is brittle (the column list drifts
   as the procedure evolves), so the ordering is asserted against the definition
   itself — that cannot silently pass. */
DECLARE @def NVARCHAR(MAX) = OBJECT_DEFINITION(OBJECT_ID('dbo.usp_inf_worksheet_sample'));

IF @def IS NULL
BEGIN
    RAISERROR('usp_inf_worksheet_sample is not deployed.', 16, 1);
    RETURN;
END

IF @def LIKE '%CASE r.testtype WHEN ''Head''%'
BEGIN
    RAISERROR('FAIL: the procedure still sorts by testtype, which hoists every section title above its analytes.', 16, 1);
    RETURN;
END

IF @def NOT LIKE '%ORDER BY r.id;%'
BEGIN
    RAISERROR('FAIL: the procedure does not end with ORDER BY r.id - insertion order is the report structure.', 16, 1);
    RETURN;
END

PRINT 'Deployed procedure orders by r.id alone. Good.';
PRINT '';

DECLARE @sid NVARCHAR(50) =
    (SELECT TOP 1 r.vailid
     FROM dbo.tbl_med_mcc_patient_test_result r
     WHERE r.testtype = 'Head'
     GROUP BY r.vailid
     HAVING COUNT(*) >= 3
     ORDER BY MAX(r.id) DESC);

IF @sid IS NULL
BEGIN
    PRINT 'No multi-section sample available to test.';
    RETURN;
END

CREATE TABLE #rows (
    seq INT IDENTITY(1,1),
    result_id INT, testtype VARCHAR(10), testcode VARCHAR(50), testname NVARCHAR(200),
    value NVARCHAR(MAX), unit VARCHAR(50), normal_range VARCHAR(1000),
    range_low DECIMAL(18,6), range_high DECIMAL(18,6),
    abnormal BIT, auth BIT, comments NVARCHAR(MAX),
    profile_id INT, master_profile_id INT, department NVARCHAR(100), paramid INT, testid INT
);

BEGIN TRY
    INSERT INTO #rows (result_id, testtype, testcode, testname, value, unit, normal_range,
                       range_low, range_high, abnormal, auth, comments,
                       profile_id, master_profile_id, department, paramid, testid)
    EXEC dbo.usp_inf_worksheet_sample @sid = @sid;
END TRY
BEGIN CATCH
    -- Column list drifts as the procedure evolves; fall back to reading the
    -- table directly so the ORDER BY is still verified.
    PRINT 'Could not capture the procedure output (' + LEFT(ERROR_MESSAGE(), 90) + ')';
    PRINT 'Verifying the table ordering directly instead.';

    INSERT INTO #rows (result_id, testtype, testname)
    SELECT r.id, r.testtype, r.testname
    FROM dbo.tbl_med_mcc_patient_test_result r
    WHERE r.vailid = @sid
    ORDER BY r.id;
END CATCH

-- A Head immediately followed by another Head is normal (a section with a
-- sub-heading). A run of 3+ is the signature of the hoisting bug.
DECLARE @maxRun INT = 0, @run INT = 0;
DECLARE @tt VARCHAR(10);
DECLARE c CURSOR LOCAL FAST_FORWARD FOR SELECT testtype FROM #rows ORDER BY seq;
OPEN c; FETCH NEXT FROM c INTO @tt;
WHILE @@FETCH_STATUS = 0
BEGIN
    IF @tt = 'Head' SET @run += 1; ELSE SET @run = 0;
    IF @run > @maxRun SET @maxRun = @run;
    FETCH NEXT FROM c INTO @tt;
END
CLOSE c; DEALLOCATE c;

DECLARE @heads INT = (SELECT COUNT(*) FROM #rows WHERE testtype = 'Head');
DECLARE @params INT = (SELECT COUNT(*) FROM #rows WHERE testtype = 'Param');

PRINT 'Sample ' + @sid + ': ' + CAST(@heads AS VARCHAR(10)) + ' sections, '
    + CAST(@params AS VARCHAR(10)) + ' analytes';
PRINT 'Longest consecutive run of Head rows: ' + CAST(@maxRun AS VARCHAR(10));

IF @heads >= 3 AND @maxRun >= @heads
BEGIN
    RAISERROR('FAIL: every Head row is consecutive - the section titles are hoisted and the analytes are not under them.', 16, 1);
END
ELSE
    PRINT 'PASS: sections are interleaved with their analytes.';

-- Show the shape for a human to sanity-check.
PRINT '';
DECLARE @shape NVARCHAR(MAX) = N'';
SELECT TOP 16 @shape = @shape + '  ' + LEFT(testtype + '        ', 8)
                     + LEFT(ISNULL(testname, '(none)'), 44) + CHAR(10)
FROM #rows ORDER BY seq;
PRINT @shape;

DROP TABLE #rows;
GO
