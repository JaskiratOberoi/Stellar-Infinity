/*
 * 85_diagnose_identity_safety.sql
 *
 * READ-ONLY. Tests whether a proposed cross-visit patient key is SAFE, i.e.
 * whether it ever merges two different people.
 *
 * The risk being measured: a delta graph joins "this patient's previous
 * results". If the join key merges a father and son who share a phone, the
 * graph shows one person another's clinical history and invites a decision on
 * it. A false merge is materially worse than showing no history at all, so the
 * key has to be chosen on evidence.
 *
 * A merge is detected as one key spanning an implausible age spread or more
 * than one gender.
 *
 * Writes nothing.
 */
SET NOCOUNT ON;

-- ---- MRNID: coverage and distinctness -------------------------------------
DECLARE @rows INT = (SELECT COUNT(*) FROM dbo.tbl_med_mcc_patient_master);
DECLARE @mrn INT = (SELECT COUNT(*) FROM dbo.tbl_med_mcc_patient_master
                    WHERE MRNID IS NOT NULL AND LTRIM(RTRIM(MRNID)) <> '');
DECLARE @mrnDistinct INT = (SELECT COUNT(DISTINCT LTRIM(RTRIM(MRNID))) FROM dbo.tbl_med_mcc_patient_master
                            WHERE MRNID IS NOT NULL AND LTRIM(RTRIM(MRNID)) <> '');

PRINT 'MRNID coverage : ' + CAST(@mrn AS VARCHAR(20)) + ' of ' + CAST(@rows AS VARCHAR(20))
    + '  (' + CAST(CAST(100.0 * @mrn / NULLIF(@rows, 0) AS DECIMAL(5,1)) AS VARCHAR(10)) + '%)';
PRINT 'MRNID distinct : ' + CAST(@mrnDistinct AS VARCHAR(20));
PRINT '';

-- ---- does (name, mobile) ever merge two people? ---------------------------
DECLARE @keys INT, @genderClash INT, @ageClash INT;

;WITH k AS (
    SELECT UPPER(LTRIM(RTRIM(p.name))) AS nm,
           LTRIM(RTRIM(p.mobile_number)) AS mob,
           COUNT(DISTINCT p.gender) AS genders,
           -- Age advances between visits, so a spread is expected. More than
           -- ~15 years apart is a different person, not the same one older.
           MAX(CASE WHEN p.age_type = 1 THEN p.age END)
             - MIN(CASE WHEN p.age_type = 1 THEN p.age END) AS ageSpread,
           COUNT(DISTINCT p.id) AS visits
    FROM dbo.tbl_med_mcc_patient_master p
    WHERE p.mobile_number IS NOT NULL AND LEN(LTRIM(RTRIM(p.mobile_number))) >= 10
      AND p.name IS NOT NULL AND LTRIM(RTRIM(p.name)) <> ''
    GROUP BY UPPER(LTRIM(RTRIM(p.name))), LTRIM(RTRIM(p.mobile_number))
    HAVING COUNT(DISTINCT p.id) > 1
)
SELECT @keys = COUNT(*),
       @genderClash = SUM(CASE WHEN genders > 1 THEN 1 ELSE 0 END),
       @ageClash = SUM(CASE WHEN ageSpread > 15 THEN 1 ELSE 0 END)
FROM k;

PRINT 'Key = (name, mobile), multi-visit keys: ' + CAST(ISNULL(@keys, 0) AS VARCHAR(20));
PRINT '  spanning >1 gender      : ' + CAST(ISNULL(@genderClash, 0) AS VARCHAR(20));
PRINT '  spanning >15y age range : ' + CAST(ISNULL(@ageClash, 0) AS VARCHAR(20));
PRINT '';

-- ---- and mobile ALONE, which is the tempting shortcut ---------------------
DECLARE @mkeys INT, @mGender INT, @mNames INT;

;WITH m AS (
    SELECT LTRIM(RTRIM(p.mobile_number)) AS mob,
           COUNT(DISTINCT p.gender) AS genders,
           COUNT(DISTINCT UPPER(LTRIM(RTRIM(p.name)))) AS names
    FROM dbo.tbl_med_mcc_patient_master p
    WHERE p.mobile_number IS NOT NULL AND LEN(LTRIM(RTRIM(p.mobile_number))) >= 10
      AND p.name IS NOT NULL AND LTRIM(RTRIM(p.name)) <> ''
    GROUP BY LTRIM(RTRIM(p.mobile_number))
    HAVING COUNT(DISTINCT p.id) > 1
)
SELECT @mkeys = COUNT(*),
       @mGender = SUM(CASE WHEN genders > 1 THEN 1 ELSE 0 END),
       @mNames = SUM(CASE WHEN names > 1 THEN 1 ELSE 0 END)
FROM m;

PRINT 'Key = mobile alone, multi-visit keys: ' + CAST(ISNULL(@mkeys, 0) AS VARCHAR(20));
PRINT '  spanning >1 NAME        : ' + CAST(ISNULL(@mNames, 0) AS VARCHAR(20));
PRINT '  spanning >1 gender      : ' + CAST(ISNULL(@mGender, 0) AS VARCHAR(20));
PRINT '  (a shared family phone shows up here)';
GO
