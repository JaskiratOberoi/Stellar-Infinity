/* QUOTED_IDENTIFIER is baked in at creation time; see script 70. */
SET QUOTED_IDENTIFIER ON;
GO
/*
 * 75_usp_inf_result_history.sql
 *
 * Prior results for the SAME PERSON, per analyte, so the worksheet can show a
 * delta trend beside each parameter.
 *
 * ── HOW A PERSON IS IDENTIFIED, AND WHY IT IS THIS STRICT ──────────────────
 * tbl_med_mcc_patient_master gets a new row per REGISTRATION: 3.4M rows for a
 * far smaller number of people. patient_id is a visit, not a person, so
 * trending across visits needs a cross-visit key. Measured on live data
 * (85_diagnose_identity_safety.sql):
 *
 *   MRNID          72.6% populated, but 2,465,749 distinct values across
 *                  2,471,807 rows — unique per registration, so it links
 *                  nothing.
 *   mobile alone   of 29,312 multi-visit keys, 25,563 span more than one NAME
 *                  and 14,717 more than one gender. It is a household phone.
 *   name+mobile    still merges: 258 keys span two genders, 388 span over 15
 *                  years of age.
 *
 * So the key here is name + mobile + gender, PLUS a per-visit age plausibility
 * check: a real person ages at most one year per elapsed year, allowing two
 * years of slack for approximate ages. 84_verify_strict_identity.sql measures
 * what that filter removes.
 *
 * The bias is deliberate. Showing NO history is a mild inconvenience; showing
 * a father's creatinine trend under his son's name is a clinical error someone
 * may act on. Where identity is uncertain, this returns nothing.
 *
 * Consequence to surface in the UI: a patient with no recorded mobile gets no
 * history, and that is the majority of registrations. Absence of a trend here
 * does NOT mean the patient has never been tested.
 *
 * ── WHAT IDENTIFIES ONE ANALYTE ────────────────────────────────────────────
 * NOT testcode. testcode names the PANEL: sample 8340592 carries 22 rows under
 * HE011, one per CBC differential parameter, and grouping on it drew twenty-two
 * unrelated numbers as a single "trend". Measured over the 3000 newest samples,
 * keys that repeat within one sample:
 *
 *   testcode           1737
 *   testname             38
 *   (testid, paramid)     3
 *
 * So the key is (testid, paramid), with paramid 0 for plain Test rows, and the
 * three residual duplicates are collapsed to the latest row per visit below.
 */
CREATE OR ALTER PROCEDURE dbo.usp_inf_result_history
    @sid        NVARCHAR(50),
    @max_points INT = 12
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @n INT = CASE WHEN @max_points BETWEEN 2 AND 50 THEN @max_points ELSE 12 END;

    -- ---- who is this sample's patient, and when ----------------------------
    DECLARE @patientId INT, @name NVARCHAR(200), @mobile VARCHAR(50),
            @gender INT, @age INT, @ageType INT, @drawn DATETIME;

    SELECT TOP 1
        @patientId = p.id,
        @name      = UPPER(LTRIM(RTRIM(p.name))),
        @mobile    = LTRIM(RTRIM(p.mobile_number)),
        @gender    = p.gender,
        @age       = p.age,
        @ageType   = p.age_type,
        @drawn     = p.sample_date
    FROM dbo.tbl_med_mcc_patient_samples s
    JOIN dbo.tbl_med_mcc_patient_master p ON p.id = s.patient_id
    WHERE s.vailid = @sid
    ORDER BY s.id DESC;

    IF @patientId IS NULL
    BEGIN
        -- Empty series + an empty identity row, so the caller can distinguish
        -- "no such sample" from "identified, but nothing prior".
        SELECT TOP 0 CAST(NULL AS VARCHAR(30)) AS test_key, CAST(NULL AS VARCHAR(50)) AS test_code,
                     CAST(NULL AS NVARCHAR(400)) AS test_name,
                     CAST(NULL AS NVARCHAR(MAX)) AS value, CAST(NULL AS VARCHAR(50)) AS unit,
                     CAST(NULL AS NVARCHAR(100)) AS vailid, CAST(NULL AS DATETIME) AS drawn_at,
                     CAST(0 AS BIT) AS is_current;
        SELECT matched_on = CAST('none' AS VARCHAR(20)), prior_visits = 0, has_mobile = CAST(0 AS BIT);
        RETURN;
    END

    -- ---- the visits that are plausibly the same person --------------------
    DECLARE @people TABLE (patient_id INT PRIMARY KEY);

    IF @mobile IS NOT NULL AND LEN(@mobile) >= 10 AND @name IS NOT NULL AND @name <> ''
    BEGIN
        INSERT INTO @people (patient_id)
        SELECT p.id
        FROM dbo.tbl_med_mcc_patient_master p
        WHERE LTRIM(RTRIM(p.mobile_number)) = @mobile          -- indexed
          AND UPPER(LTRIM(RTRIM(p.name))) = @name
          AND p.gender = @gender
          AND (
                -- Age check only where both visits record years; months/days
                -- are paediatric and move too fast for this comparison.
                @ageType <> 1 OR p.age_type <> 1 OR p.age IS NULL OR @age IS NULL
                OR ABS(p.age - (@age - DATEDIFF(YEAR, p.sample_date, @drawn))) <= 2
              );
    END
    ELSE
    BEGIN
        -- No usable mobile: fall back to THIS registration only. Other samples
        -- drawn in the same visit are certainly the same person; anything
        -- further back cannot be established safely.
        INSERT INTO @people (patient_id) VALUES (@patientId);
    END

    -- Always include the current visit even if the age rule excluded it.
    IF NOT EXISTS (SELECT 1 FROM @people WHERE patient_id = @patientId)
        INSERT INTO @people (patient_id) VALUES (@patientId);

    -- ---- the series, restricted to analytes ON THIS sample ----------------
    -- Only tests present on the current sample matter: the graph sits beside
    -- those rows, and returning the patient's entire history would be a large
    -- payload nothing renders.
    -- The label and unit come from the CURRENT sample, so the card is headed
    -- with the same wording the worksheet and the report use, even if an older
    -- visit recorded the analyte under a since-renamed name.
    ;WITH current_tests AS (
        SELECT r.testid,
               ISNULL(r.paramid, 0) AS paramid,
               test_code = MIN(LTRIM(RTRIM(r.testcode))),
               test_name = MIN(r.testname),
               unit      = MIN(r.testunit)
        FROM dbo.tbl_med_mcc_patient_test_result r
        WHERE r.vailid = @sid
          AND r.testtype IN ('Test', 'Param')
          AND r.testid IS NOT NULL
        GROUP BY r.testid, ISNULL(r.paramid, 0)
    ),
    raw AS (
        SELECT
            ct.test_code,
            ct.test_name,
            ct.unit,
            r.testid,
            ISNULL(r.paramid, 0) AS paramid,
            r.value       AS value,
            r.vailid      AS vailid,
            p.sample_date AS drawn_at,
            CAST(CASE WHEN r.vailid = @sid THEN 1 ELSE 0 END AS BIT) AS is_current,
            -- One analyte can appear twice on a single visit (rare: 3 cases in
            -- 3000 samples). Keep the latest; two points from one draw is not a
            -- trend, it is a re-entry.
            ROW_NUMBER() OVER (
                PARTITION BY r.testid, ISNULL(r.paramid, 0), r.vailid
                ORDER BY r.id DESC) AS dup_rn
        FROM dbo.tbl_med_mcc_patient_test_result r
        JOIN @people pe ON pe.patient_id = r.patientid
        JOIN dbo.tbl_med_mcc_patient_master p ON p.id = r.patientid
        JOIN current_tests ct
          ON ct.testid = r.testid
         AND ct.paramid = ISNULL(r.paramid, 0)
        WHERE r.testtype IN ('Test', 'Param')
          AND r.value IS NOT NULL
          AND LTRIM(RTRIM(r.value)) <> ''
          -- Numeric only: a trend line through "Negative" and "Trace" would be
          -- meaningless, and those analytes are better read as text.
          AND TRY_CONVERT(DECIMAL(18,6), LTRIM(RTRIM(r.value))) IS NOT NULL
    ),
    series AS (
        SELECT *,
            -- is_current DESC in the tiebreak so that trimming to @n can never
            -- drop the value the operator is looking at.
            ROW_NUMBER() OVER (
                PARTITION BY testid, paramid
                ORDER BY drawn_at DESC, is_current DESC, vailid DESC) AS rn
        FROM raw
        WHERE dup_rn = 1
    )
    SELECT
        test_key = CAST(testid AS VARCHAR(12)) + ':' + CAST(paramid AS VARCHAR(12)),
        test_code, test_name, value, unit, vailid, drawn_at, is_current
    FROM series
    WHERE rn <= @n
    -- Grouped by key so the reader can stream it; oldest first so the sparkline
    -- runs left to right, with the current sample last among same-day draws.
    ORDER BY test_key, drawn_at, is_current;

    -- ---- how the match was made, so the UI can say so ---------------------
    DECLARE @visits INT = (SELECT COUNT(*) FROM @people);

    SELECT
        matched_on = CASE
            WHEN @mobile IS NULL OR LEN(@mobile) < 10 THEN 'visit'
            WHEN @visits > 1 THEN 'name+mobile+gender'
            ELSE 'visit'
        END,
        prior_visits = @visits - 1,
        has_mobile = CAST(CASE WHEN @mobile IS NOT NULL AND LEN(@mobile) >= 10 THEN 1 ELSE 0 END AS BIT);
END
GO
