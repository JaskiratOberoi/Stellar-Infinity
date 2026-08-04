/*
 * 84_verify_strict_identity.sql
 *
 * READ-ONLY. Measures the residual false-merge rate of the STRICT cross-visit
 * key actually used by the history feature:
 *
 *     normalised name + mobile (>=10 digits) + gender
 *     + age consistent with the elapsed time between visits
 *
 * Established by 85_diagnose_identity_safety.sql:
 *   - MRNID is unique per registration, so it does not link visits at all
 *   - mobile alone spans >1 name in 87% of multi-visit cases (a household phone)
 *   - name+mobile alone still merges ~6% (258 gender clashes, 388 age clashes)
 *
 * Writes nothing.
 */
SET NOCOUNT ON;

DECLARE @keys INT = 0, @ageClash INT = 0;

;WITH k AS (
    SELECT UPPER(LTRIM(RTRIM(p.name))) AS nm,
           LTRIM(RTRIM(p.mobile_number)) AS mob,
           p.gender,
           -- Years between the earliest and latest visit on this key.
           DATEDIFF(YEAR, MIN(p.sample_date), MAX(p.sample_date)) AS spanYears,
           MAX(CASE WHEN p.age_type = 1 THEN p.age END)
             - MIN(CASE WHEN p.age_type = 1 THEN p.age END) AS ageSpread,
           COUNT(DISTINCT p.id) AS visits
    FROM dbo.tbl_med_mcc_patient_master p
    WHERE p.mobile_number IS NOT NULL AND LEN(LTRIM(RTRIM(p.mobile_number))) >= 10
      AND p.name IS NOT NULL AND LTRIM(RTRIM(p.name)) <> ''
      AND p.gender IS NOT NULL
    GROUP BY UPPER(LTRIM(RTRIM(p.name))), LTRIM(RTRIM(p.mobile_number)), p.gender
    HAVING COUNT(DISTINCT p.id) > 1
)
SELECT @keys = COUNT(*),
       -- A real person ages at most one year per elapsed year. Allow 2 years of
       -- slack for rounding and for ages recorded approximately.
       @ageClash = SUM(CASE WHEN ageSpread > spanYears + 2 THEN 1 ELSE 0 END)
FROM k;

PRINT 'STRICT key = name + mobile + gender';
PRINT '  multi-visit keys           : ' + CAST(ISNULL(@keys, 0) AS VARCHAR(20));
PRINT '  age inconsistent with span : ' + CAST(ISNULL(@ageClash, 0) AS VARCHAR(20));

IF ISNULL(@keys, 0) > 0
    PRINT '  residual merge risk        : '
        + CAST(CAST(100.0 * ISNULL(@ageClash, 0) / @keys AS DECIMAL(5,2)) AS VARCHAR(10)) + '%'
        + '  (removed by the age filter in usp_inf_result_history)';

PRINT '';
PRINT 'The age filter is applied per candidate visit, not per key, so the';
PRINT 'implausible visits are excluded individually rather than the whole';
PRINT 'patient being dropped.';
GO
