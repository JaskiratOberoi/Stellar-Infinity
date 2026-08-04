/*
 * 86_verify_result_history.sql
 *
 * READ-ONLY. Picks two live subjects for the history feature and computes, by
 * an INDEPENDENT query, what dbo.usp_inf_result_history ought to return for
 * them. The actual procedure is then exercised end-to-end over HTTP and the two
 * answers compared.
 *
 * Why not INSERT ... EXEC the procedure here and diff it in SQL: that captures
 * every result set into one table, and this procedure deliberately returns two
 * of different shapes (the series, then how the patient was identified). The
 * HTTP path is also the one that actually ships, so it is the better thing to
 * assert on.
 *
 * The two subjects:
 *   [1] a patient with several visits on one name+mobile+gender — must produce
 *       a multi-point trend
 *   [2] a patient with no usable mobile — must produce NO cross-visit points.
 *       This is the deliberate "show nothing when identity is uncertain" path.
 *
 * Writes nothing.
 */
SET NOCOUNT ON;

DECLARE @sidMulti NVARCHAR(50), @sidNoMobile NVARCHAR(50);

-- ---- a SID whose patient demonstrably has earlier visits -------------------
;WITH repeat_people AS (
    SELECT TOP 1
           UPPER(LTRIM(RTRIM(p.name)))   AS nm,
           LTRIM(RTRIM(p.mobile_number)) AS mob,
           p.gender
    FROM dbo.tbl_med_mcc_patient_master p
    WHERE p.mobile_number IS NOT NULL AND LEN(LTRIM(RTRIM(p.mobile_number))) >= 10
      AND p.name IS NOT NULL AND LTRIM(RTRIM(p.name)) <> ''
      AND p.gender IS NOT NULL
      AND p.sample_date > DATEADD(YEAR, -2, GETDATE())
    GROUP BY UPPER(LTRIM(RTRIM(p.name))), LTRIM(RTRIM(p.mobile_number)), p.gender
    HAVING COUNT(DISTINCT p.id) BETWEEN 3 AND 12
    ORDER BY COUNT(DISTINCT p.id) DESC
)
SELECT TOP 1 @sidMulti = s.vailid
FROM repeat_people rp
JOIN dbo.tbl_med_mcc_patient_master p
  ON UPPER(LTRIM(RTRIM(p.name))) = rp.nm
 AND LTRIM(RTRIM(p.mobile_number)) = rp.mob
 AND p.gender = rp.gender
JOIN dbo.tbl_med_mcc_patient_samples s ON s.patient_id = p.id
WHERE EXISTS (SELECT 1 FROM dbo.tbl_med_mcc_patient_test_result r
              WHERE r.vailid = s.vailid AND TRY_CONVERT(DECIMAL(18,6), r.value) IS NOT NULL)
ORDER BY p.sample_date DESC;

-- ---- and one with no usable mobile, the fall-back path ---------------------
SELECT TOP 1 @sidNoMobile = s.vailid
FROM dbo.tbl_med_mcc_patient_samples s
JOIN dbo.tbl_med_mcc_patient_master p ON p.id = s.patient_id
WHERE (p.mobile_number IS NULL OR LEN(LTRIM(RTRIM(p.mobile_number))) < 10)
  AND EXISTS (SELECT 1 FROM dbo.tbl_med_mcc_patient_test_result r
              WHERE r.vailid = s.vailid AND TRY_CONVERT(DECIMAL(18,6), r.value) IS NOT NULL)
ORDER BY p.sample_date DESC;

PRINT 'SUBJECT_MULTI=' + ISNULL(@sidMulti, '');
PRINT 'SUBJECT_NOMOBILE=' + ISNULL(@sidNoMobile, '');
PRINT '';

-- ---- independent expectation for subject [1] -------------------------------
IF @sidMulti IS NOT NULL
BEGIN
    DECLARE @nm NVARCHAR(200), @mob VARCHAR(50), @gen INT, @age INT, @at INT, @drawn DATETIME;
    SELECT TOP 1 @nm = UPPER(LTRIM(RTRIM(p.name))), @mob = LTRIM(RTRIM(p.mobile_number)),
                 @gen = p.gender, @age = p.age, @at = p.age_type, @drawn = p.sample_date
    FROM dbo.tbl_med_mcc_patient_samples s
    JOIN dbo.tbl_med_mcc_patient_master p ON p.id = s.patient_id
    WHERE s.vailid = @sidMulti
    ORDER BY s.id DESC;

    DECLARE @people TABLE (patient_id INT PRIMARY KEY);
    INSERT INTO @people (patient_id)
    SELECT p.id FROM dbo.tbl_med_mcc_patient_master p
    WHERE LTRIM(RTRIM(p.mobile_number)) = @mob
      AND UPPER(LTRIM(RTRIM(p.name))) = @nm
      AND p.gender = @gen
      AND (@at <> 1 OR p.age_type <> 1 OR p.age IS NULL OR @age IS NULL
           OR ABS(p.age - (@age - DATEDIFF(YEAR, p.sample_date, @drawn))) <= 2);

    DECLARE @visits INT = (SELECT COUNT(*) FROM @people);

    -- Analytes on the current sample that have more than one numeric value
    -- across those visits: exactly the cards the UI should draw.
    --
    -- Keyed on (testid, paramid), NOT testcode. A CBC differential carries one
    -- testcode across all 22 of its parameters, so counting by code says "1
    -- analyte" where the operator sees twenty-two.
    DECLARE @trended INT;
    ;WITH ct AS (
        SELECT DISTINCT r.testid, ISNULL(r.paramid, 0) AS paramid
        FROM dbo.tbl_med_mcc_patient_test_result r
        WHERE r.vailid = @sidMulti AND r.testtype IN ('Test','Param') AND r.testid IS NOT NULL
    ),
    pts AS (
        -- COUNT(DISTINCT vailid): the proc keeps one point per visit, so the
        -- expectation has to count visits, not rows.
        SELECT r.testid, ISNULL(r.paramid, 0) AS paramid, COUNT(DISTINCT r.vailid) AS n
        FROM dbo.tbl_med_mcc_patient_test_result r
        JOIN @people pe ON pe.patient_id = r.patientid
        JOIN ct ON ct.testid = r.testid AND ct.paramid = ISNULL(r.paramid, 0)
        WHERE r.testtype IN ('Test','Param')
          AND TRY_CONVERT(DECIMAL(18,6), LTRIM(RTRIM(r.value))) IS NOT NULL
        GROUP BY r.testid, ISNULL(r.paramid, 0)
    )
    SELECT @trended = COUNT(*) FROM pts WHERE n > 1;

    PRINT 'EXPECT_MULTI_PRIORVISITS=' + CAST(@visits - 1 AS VARCHAR(10));
    PRINT 'EXPECT_MULTI_TRENDED_ANALYTES=' + CAST(ISNULL(@trended, 0) AS VARCHAR(10));
END

-- ---- and for subject [2]: nothing beyond this registration -----------------
IF @sidNoMobile IS NOT NULL
    PRINT 'EXPECT_NOMOBILE_PRIORVISITS=0';
GO
