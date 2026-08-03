SET QUOTED_IDENTIFIER ON;
GO
/*
 * 40_usp_inf_worksheet_sample.sql
 *
 * Everything the result-entry screen needs for one sample, in one round-trip:
 * the sample header, its analyte rows, and the reference range in force for
 * THIS patient (age, age unit and sex) for each row.
 *
 * Three result sets:
 *   1. the sample header (one row, or none if out of scope / not found)
 *   2. the analyte rows
 *   3. the auto-authorisation rules that apply to this sample's tests
 *
 * ---------------------------------------------------------------------------
 * THE TWO RANGE SETS
 *
 * Noble stores two kinds of reference range per test, distinguished by
 * tbl_med_test_normalranges.ReportType:
 *
 *   'Report' — the human-readable string printed on the report ("3.5 - 5.1").
 *              Snapshotted onto the result row as testnormal_range when the row
 *              is created, and never recomputed. That snapshotting is correct
 *              and Infinity keeps it: the range printed on a report must be the
 *              range that was in force when the result was produced.
 *
 *   'Auth'   — numeric fnormal/tnormal bounds, used to decide in-range.
 *
 * This procedure returns both: the frozen display string from the result row,
 * and the live numeric bounds so the UI can flag high/low as the user types.
 * The bounds are advisory in the UI — usp_inf_result_save recomputes them
 * server-side and does not trust anything the client sends back.
 *
 * fnormal/tnormal are NVARCHAR(500) in Noble, not numeric. Some rows hold text
 * ("Negative", "< 0.5"). TRY_CONVERT yields NULL for those rather than failing
 * the batch, and a NULL bound simply means "cannot range-check this analyte",
 * which is the correct outcome.
 *
 * Range rows are matched on age type, exact sex, and an age band. A patient
 * whose age falls in no band gets no bounds — again, correctly, since the lab
 * has not defined what normal means for them.
 * ---------------------------------------------------------------------------
 *
 * Scope is enforced by the caller passing its client codes as a TVP, exactly as
 * usp_listec_worksheet_report_by_codes does. An empty TVP means unrestricted;
 * the API short-circuits the "user may see nothing" case before calling.
 *
 * Read-only.
 */
CREATE OR ALTER PROCEDURE dbo.usp_inf_worksheet_sample
    @sid          NVARCHAR(50),
    @client_codes dbo.ClientCodeList READONLY
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @unrestricted BIT = CASE WHEN EXISTS (SELECT 1 FROM @client_codes) THEN 0 ELSE 1 END;

    DECLARE @patient_id INT,
            @sample_id  INT,
            @age        INT,
            @age_type   INT,
            @gender     INT;

    SELECT TOP 1
        @sample_id  = s.id,
        @patient_id = p.id,
        @age        = p.age,
        @age_type   = p.age_type,
        @gender     = p.gender
    FROM dbo.tbl_med_mcc_patient_samples s
    JOIN dbo.tbl_med_mcc_patient_master  p ON p.id = s.patient_id
    JOIN dbo.tbl_med_mcc_unit_master     u ON u.id = p.mcc_code
    WHERE s.vailid = @sid
      AND (@unrestricted = 1
           OR EXISTS (SELECT 1 FROM @client_codes c
                      WHERE c.code = LTRIM(RTRIM(u.MCCUnitCode))));

    -- ---- 1. header ------------------------------------------------------
    SELECT
        s.vailid                        AS sid,
        p.id                            AS pid,
        p.name                          AS patient_name,
        CASE p.gender WHEN 1 THEN 'Male' ELSE 'Female' END AS sex,
        p.age,
        CASE p.age_type WHEN 1 THEN 'Year(s)'
                        WHEN 2 THEN 'Month(s)'
                        WHEN 3 THEN 'Day(s)'
                        ELSE 'Unknown' END AS age_unit,
        LTRIM(RTRIM(u.MCCUnitCode))     AS client_code,
        u.short_name,
        p.order_number,
        p.bill_number,
        p.sample_time                   AS sample_drawn,
        s.modifieddate                  AS registered_at,
        s.lastmodified_date             AS last_modified_at,
        s.sample_status                 AS status_code,
        st.status                       AS status,
        s.Sample_Comments               AS sample_comments,
        s.Sample_ClinicalHistory        AS sample_clinical_history,
        p.Clinical_History              AS patient_clinical_history,
        s.reject_comments,
        s.authorised_by,
        auth_user.Username              AS authorised_by_username,
        s.signature_id,
        sig.Doctorname                  AS signatory_name,
        sig.Designation                 AS signatory_designation,

        -- The editability rule, computed once here rather than re-derived in
        -- the UI. 7/8/9 are authorised or printed and need an explicit reopen;
        -- 3 is rejected. The legacy CheckSampleEnable blocks only 7 and 9,
        -- which leaves a rejected sample freely editable.
        CAST(CASE WHEN s.sample_status IN (3, 7, 8, 9) THEN 0 ELSE 1 END AS BIT) AS is_editable,
        CAST(CASE WHEN s.sample_status IN (7, 8, 9)    THEN 1 ELSE 0 END AS BIT) AS needs_reopen,
        CAST(CASE WHEN s.sample_status = 3             THEN 1 ELSE 0 END AS BIT) AS is_rejected
    FROM dbo.tbl_med_mcc_patient_samples s
    JOIN dbo.tbl_med_mcc_patient_master  p ON p.id = s.patient_id
    JOIN dbo.tbl_med_mcc_unit_master     u ON u.id = p.mcc_code
    LEFT JOIN dbo.tbl_med_mcc_patient_samples_status_master st ON st.id = s.sample_status
    LEFT JOIN dbo.tbl_med_user_master    auth_user ON auth_user.id = s.authorised_by
    LEFT JOIN dbo.tbl_med_signature_master sig ON sig.id = s.signature_id
    WHERE s.id = @sample_id;

    -- ---- 2. analyte rows ------------------------------------------------
    -- The live 'Auth' bounds for this patient, one row per result at most.
    -- Multiple range rows can match a patient when bands overlap in the master
    -- data; ROW_NUMBER picks the lowest id deterministically rather than
    -- letting the result depend on scan order, which is what the legacy
    -- foreach-and-return-on-first-match does by accident.
    WITH bounds AS (
        SELECT
            r.id AS result_id,
            TRY_CONVERT(DECIMAL(18,6), nr.fnormal) AS low,
            TRY_CONVERT(DECIMAL(18,6), nr.tnormal) AS high,
            nr.unit AS range_unit,
            ROW_NUMBER() OVER (PARTITION BY r.id ORDER BY nr.id) AS rn
        FROM dbo.tbl_med_mcc_patient_test_result r
        JOIN dbo.tbl_med_test_normalranges nr
              ON nr.testid     = r.testid
             AND nr.ReportType = 'Auth'
             AND ISNULL(nr.IsActive, 1) = 1
             AND nr.agetype    = CONVERT(NVARCHAR(10), @age_type)
             AND nr.gender     = @gender
             AND @age BETWEEN nr.fage AND nr.tage
        WHERE r.vailid = @sid
          AND r.testtype = 'Test'

        UNION ALL

        SELECT
            r.id,
            TRY_CONVERT(DECIMAL(18,6), pnr.fnormal),
            TRY_CONVERT(DECIMAL(18,6), pnr.tnormal),
            pnr.unit,
            ROW_NUMBER() OVER (PARTITION BY r.id ORDER BY pnr.id)
        FROM dbo.tbl_med_mcc_patient_test_result r
        JOIN dbo.tbl_med_test_param_normalranges pnr
              ON pnr.testid     = r.testid
             AND pnr.paramid    = r.paramid
             AND pnr.ReportType = 'Auth'
             AND ISNULL(pnr.IsActive, 1) = 1
             AND pnr.agetype    = CONVERT(NVARCHAR(10), @age_type)
             AND pnr.gender     = @gender
             AND @age BETWEEN pnr.fage AND pnr.tage
        WHERE r.vailid = @sid
          AND r.testtype = 'Param'
    )
    SELECT
        r.id                AS result_id,
        r.testid,
        r.paramid,
        r.testcode,
        r.testname,
        r.testtype,
        r.value,
        r.testunit          AS unit,
        r.testnormal_range  AS normal_range,        -- frozen display string
        b.low               AS range_low,           -- live numeric bounds
        b.high              AS range_high,
        ISNULL(r.abnormal, 0) AS abnormal,
        ISNULL(r.auth, 0)     AS authorized,
        r.comments,
        r.profile_id,
        r.master_profile_id,
        r.machine_name,
        r.addedby,
        r.addeddate,
        r.updatedby,
        r.updateddate,
        ISNULL(r.attachment, 0) AS has_attachment,
        d.Code              AS department_code,
        d.Name              AS department_name,
        tm.DepartmentId     AS department_id,

        -- The coded-value option list. Noble carries it in a column called
        -- mobile_number on the result row — a repurposed VARCHAR(12), which
        -- silently truncates any option set longer than twelve characters.
        -- Surfaced as-is so the UI can offer a dropdown where one exists; the
        -- truncation is a legacy data problem, not something to paper over here.
        r.mobile_number     AS coded_options,

        -- Whether this analyte can be range-checked at all. A narrative or
        -- coded result has no numeric bounds and must never be auto-authorised.
        CAST(CASE WHEN b.low IS NOT NULL AND b.high IS NOT NULL THEN 1 ELSE 0 END AS BIT) AS is_numeric_range
    FROM dbo.tbl_med_mcc_patient_test_result r
    LEFT JOIN bounds b            ON b.result_id = r.id AND b.rn = 1
    LEFT JOIN dbo.tbl_med_test_master tm ON tm.id = r.testid
    LEFT JOIN dbo.tbl_med_department_master d ON d.id = tm.DepartmentId
    WHERE r.vailid = @sid
      AND @sample_id IS NOT NULL
    -- Head and Profile rows are display scaffolding and must sort above the
    -- analytes they introduce, or the grid reads as a jumble.
    ORDER BY
        r.master_profile_id,
        r.profile_id,
        CASE r.testtype WHEN 'Head' THEN 0 WHEN 'Profile' THEN 1 WHEN 'Test' THEN 2 ELSE 3 END,
        r.id;

    -- ---- 3. auto-authorisation rules in force for this sample -----------
    -- Returned so the screen can tell the technologist which analytes will be
    -- signed by the system on save. Auto-authorisation that the operator cannot
    -- see coming is how the legacy "Check" button surprised people.
    SELECT DISTINCT
        cfg.scope_type,
        cfg.scope_key,
        cfg.scope_label,
        cfg.require_in_range,
        cfg.allow_out_of_range,
        cfg.numeric_only
    FROM dbo.inf_auto_auth_config cfg
    WHERE cfg.enabled = 1
      -- Same guard as the rows query: an out-of-scope SID must produce nothing
      -- from any result set, not just the header.
      AND @sample_id IS NOT NULL
      AND (
            (cfg.scope_type = 'test'
             AND EXISTS (SELECT 1 FROM dbo.tbl_med_mcc_patient_test_result r
                         WHERE r.vailid = @sid AND r.testcode = cfg.scope_key))
         OR (cfg.scope_type = 'profile'
             AND EXISTS (SELECT 1 FROM dbo.tbl_med_mcc_patient_test_result r
                         WHERE r.vailid = @sid
                           AND TRY_CONVERT(INT, cfg.scope_key) IN (r.profile_id, r.master_profile_id)))
         OR (cfg.scope_type = 'department'
             AND EXISTS (SELECT 1 FROM dbo.tbl_med_mcc_patient_test_result r
                         JOIN dbo.tbl_med_test_master tm ON tm.id = r.testid
                         WHERE r.vailid = @sid AND tm.DepartmentId = TRY_CONVERT(INT, cfg.scope_key)))
          );
END
GO
