SET QUOTED_IDENTIFIER ON;
GO
/*
 * 156_sample_drawn_is_two_columns.sql
 *
 * usp_inf_worksheet_sample, usp_inf_worksheet_list and usp_inf_report_by_sid,
 * each re-issued whole from its script (50, 76, 77 — all three diffed equal to
 * the deployed bodies first) with ONE change: sample_drawn is composed from
 * sample_date (the day) and the clock time of sample_time, as the legacy LIS
 * composes its Sample Drawn Date. Reading sample_time alone showed a draw
 * keyed in after midnight a day late — 22-09 23:39 in the LIS, 23/09 in the
 * report. 1,322 of the last 30 days' 115,977 registrations differ that way.
 * The API's SampleHeaderRepository reads the same expression.
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
        -- The drawn stamp is TWO legacy columns: sample_date holds the day (at
                    -- midnight) and sample_time the clock time on whatever day the record
                    -- was saved — a 23:39 draw keyed in after midnight carries the next
                    -- day's date there. The LIS shows date from the first and time from
                    -- the second; so does this. (156, 2026-09-23)
        CASE WHEN p.sample_date IS NULL OR p.sample_time IS NULL THEN COALESCE(p.sample_time, p.sample_date)
                         ELSE DATEADD(DAY, DATEDIFF(DAY, 0, p.sample_date), CAST(CAST(p.sample_time AS TIME) AS DATETIME)) END AS sample_drawn,
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
        CAST(CASE WHEN s.sample_status = 3             THEN 1 ELSE 0 END AS BIT) AS is_rejected,

        -- The remaining four fields Listec's own worksheet header prints, so an
        -- operator checking the tube against the screen sees the same set in
        -- either system.
        p.initial                       AS title,
        -- Both referral fields are "a master row, or free text when nothing
        -- matched". Listec reads the joined name and falls back to the _other
        -- column when it comes back empty, so NULLIF is needed for a master row
        -- whose name is blank rather than NULL — COALESCE alone would stop at
        -- the empty string and hide a perfectly good free-text value.
        COALESCE(NULLIF(LTRIM(RTRIM(doc.doctor_name)), ''),
                 NULLIF(LTRIM(RTRIM(p.ref_doctor_other)), ''))   AS ref_doctor,
        COALESCE(NULLIF(LTRIM(RTRIM(cust.customer_name)), ''),
                 NULLIF(LTRIM(RTRIM(p.ref_customer_other)), '')) AS ref_customer,
        sm.Sampletype                   AS sample_type,

        -- What is on the tube, as the LIS worklist names it: the profile and
        -- test names booked onto this sample, in the LIS's own CSV. The grid
        -- below shows the same profiles as heading rows, but spread down forty
        -- analytes; this is the one-line answer at the top.
        s.testnames                     AS test_names,
        -- The package (LIS "master profile") the tube was booked under, from
        -- the order line every tube of the visit shares. Only for a tube whose
        -- type CSV says a code came out of a package ('mt'/'mp'); see the same
        -- rule, and why testnames cannot be trusted for it, in
        -- usp_inf_worksheet_list.
        CASE WHEN s.testtypes LIKE '%m%' THEN
            (SELECT STRING_AGG(CONVERT(NVARCHAR(MAX), LTRIM(RTRIM(t.test_name))), N', ')
                        WITHIN GROUP (ORDER BY t.id)
             FROM dbo.tbl_med_mcc_patient_tests t
             WHERE t.patient_id = s.patient_id
               AND t.test_type = 'Master'
               AND NULLIF(LTRIM(RTRIM(t.test_name)), '') IS NOT NULL)
        END                             AS package_names,
        -- The lab the tube is processed at, for the tag the worklists draw
        -- beside the client code (HALDWANI -> HAL).
        bu.BusinessUnitCode             AS business_unit
    FROM dbo.tbl_med_mcc_patient_samples s
    JOIN dbo.tbl_med_mcc_patient_master  p ON p.id = s.patient_id
    JOIN dbo.tbl_med_mcc_unit_master     u ON u.id = p.mcc_code
    LEFT JOIN dbo.tbl_med_mcc_patient_samples_status_master st ON st.id = s.sample_status
    LEFT JOIN dbo.tbl_med_user_master    auth_user ON auth_user.id = s.authorised_by
    LEFT JOIN dbo.tbl_med_signature_master sig ON sig.id = s.signature_id
    LEFT JOIN dbo.tbl_med_mcc_doctors    doc  ON doc.id  = p.ref_doctor
    LEFT JOIN dbo.tbl_med_mcc_customer   cust ON cust.id = p.ref_customer
    LEFT JOIN dbo.tbl_med_sample_master  sm   ON sm.id   = s.sampleid
    LEFT JOIN dbo.tbl_med_business_unit_master bu ON bu.id = s.business_unit_id
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
    /* RAW INSERTION ORDER, and nothing else.
     *
     * The LIS already stores these rows in the order it prints them, with each
     * Head immediately followed by the analytes it introduces:
     *
     *     Profile  CBC WITH ESR
     *     Head     Complete Blood Count
     *     Param    Hemoglobin, RBC Count, ...
     *     Head     Differential Counts %
     *     Param    Neutrophils %, Lymphocytes %, ...
     *
     * A previous version sorted by testtype ahead of id, on the reasoning that
     * Head rows are scaffolding and should sit above their analytes. That is
     * true of ONE head and its own params, but sorting cannot express it:
     * ranking every Head above every Param hoists ALL the section titles to the
     * top of the profile and dumps every analyte underneath the last one. On a
     * urine examination that rendered as four consecutive empty headings
     * followed by an undifferentiated list of fields.
     *
     * Telo's sampleReport.ts reads this table the same way and says so — the
     * insertion order IS the report structure, so any re-sort destroys it.
     */
    ORDER BY r.id;

    -- ---- 3. auto-authorisation rules in force for this sample -----------
    -- Returned so the screen can tell the technologist which analytes will be
    -- signed by the system on save. Auto-authorisation that the operator cannot
    -- see coming is how the legacy "Check" button surprised people.
    -- Scoped to THIS sample's business unit, matching usp_inf_result_save.
    -- Listing a rule that will not actually fire here would mislead the
    -- technologist in the direction that matters least safely: telling them
    -- the system will sign something when it will not.
    DECLARE @sample_bu INT =
        (SELECT business_unit_id FROM dbo.tbl_med_mcc_patient_samples WHERE id = @sample_id);

    SELECT DISTINCT
        cfg.scope_type,
        cfg.scope_key,
        cfg.scope_label,
        cfg.business_unit_id,
        cfg.business_unit_name,
        cfg.require_in_range,
        cfg.allow_out_of_range,
        cfg.numeric_only
    FROM dbo.inf_auto_auth_config cfg
    WHERE cfg.enabled = 1
      -- Same guard as the rows query: an out-of-scope SID must produce nothing
      -- from any result set, not just the header.
      AND @sample_id IS NOT NULL
      AND (cfg.business_unit_id IS NULL OR cfg.business_unit_id = @sample_bu)
      AND (
            (cfg.scope_type = 'test'
             AND EXISTS (SELECT 1 FROM dbo.tbl_med_mcc_patient_test_result r
                         WHERE r.vailid = @sid AND r.testcode = cfg.scope_key))
         OR (cfg.scope_type = 'profile'
             AND EXISTS (SELECT 1 FROM dbo.tbl_med_mcc_patient_test_result r
                         WHERE r.vailid = @sid
                           AND TRY_CONVERT(INT, cfg.scope_key) IN (r.profile_id, r.master_profile_id)))
          );
END
GO

CREATE OR ALTER PROCEDURE dbo.usp_inf_worksheet_list
    @client_codes    dbo.ClientCodeList READONLY,
    @from_date       DATE,
    @to_date         DATE,
    @patient_name    NVARCHAR(200) = NULL,
    @sid             NVARCHAR(50)  = NULL,
    -- CSV of sample_status values, e.g. '2,4,5,6'. NULL means every status.
    -- A set, not a scalar: this is the whole point of the procedure.
    @status_ids      VARCHAR(200)  = NULL,
    -- ---- the rest of the legacy worksheet's filter set ----------------------
    -- Hour-of-day bounds on the date window, as the LIS's two time dropdowns.
    -- A night shift filters 20:00 to 08:00 by narrowing these, not the dates.
    @from_hour       TINYINT       = 0,
    @to_hour         TINYINT       = 24,
    -- Patient number. tbl_med_mcc_patient_master.id, which the LIS labels
    -- "Patient Number" and Infinity shows in the PID column.
    @pid             INT           = NULL,
    -- ONE client code. Narrows within the caller's scope and can never widen
    -- it: the scope TVP below is applied as well, not instead.
    @client_code     NVARCHAR(50)  = NULL,
    @department_id   INT           = NULL,
    @business_unit_id INT          = NULL,
    @test_code       NVARCHAR(50)  = NULL,
    -- Comma-separated codes, OR-combined: a sample matches if it carries ANY
    -- of them. Supersedes @test_code (kept for callers deployed before the
    -- filter went multi-select).
    @test_codes      NVARCHAR(1000) = NULL,
    @page            INT           = 1,
    @page_size       INT           = 100,
    -- Upper bound on modifieddate, pinned by the caller so that paging walks a
    -- fixed set. NULL means "now", which the procedure returns for the caller
    -- to send back on subsequent pages.
    @as_of           DATETIME      = NULL,
    -- 1 (the default): a patient's samples are listed TOGETHER, the group
    -- placed by its latest registration, so two tubes of one visit registered
    -- an hour apart on a busy day no longer land fifty rows — and a page —
    -- apart. Reporting always asks for this; the worksheet passes its own
    -- toggle, since a bench sometimes works in pure registration order (0).
    @group_by_patient BIT          = 1
AS
BEGIN
    SET NOCOUNT ON;
    -- Matches the legacy procedure deliberately. This is a read of a live LIS
    -- that clinicians are writing to; taking shared locks across a date range
    -- would block result entry, and a worklist tolerates a dirty read.
    SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;

    -- Hour bounds exactly as the legacy procedure computes them: @to_hour of 24
    -- means "to the last second of the to-date", not midnight at its start.
    DECLARE @from DATETIME = DATEADD(HOUR, @from_hour, CAST(@from_date AS DATETIME));
    DECLARE @to   DATETIME =
        CASE WHEN @to_hour >= 24
             THEN DATEADD(SECOND, -1, DATEADD(DAY, 1, CAST(@to_date AS DATETIME)))
             ELSE DATEADD(HOUR, @to_hour, CAST(@to_date AS DATETIME))
        END;

    -- The snapshot. Never widens the requested window — it only ever pins the
    -- upper edge earlier, so a caller cannot use it to read outside its dates.
    DECLARE @snapshot DATETIME = ISNULL(@as_of, GETDATE());
    IF @snapshot < @to SET @to = @snapshot;

    DECLARE @pageSafe INT = CASE WHEN @page < 1 THEN 1 ELSE @page END;
    -- Ceiling of 1000 rather than the legacy 5000: this is a per-request
    -- transfer limit, not a limit on what the operator can reach. Every row is
    -- still reachable by paging, and total_count tells the client how far to go.
    DECLARE @size INT =
        CASE WHEN @page_size < 1 THEN 100
             WHEN @page_size > 1000 THEN 1000
             ELSE @page_size END;
    DECLARE @offset INT = (@pageSafe - 1) * @size;

    -- Empty TVP means "no client-code filter", matching the legacy contract.
    -- Callers must never pass an empty list to mean "this user sees nothing" —
    -- the endpoint short-circuits that case before it gets here.
    DECLARE @codeCount INT = (SELECT COUNT(*) FROM @client_codes);

    -- The status set, parsed once into a table so the WHERE clause is a plain
    -- EXISTS rather than a LIKE over a string (which would match 5 inside 15).
    DECLARE @statuses TABLE (status_id INT PRIMARY KEY);
    IF @status_ids IS NOT NULL AND LTRIM(RTRIM(@status_ids)) <> ''
    BEGIN
        INSERT INTO @statuses (status_id)
        SELECT DISTINCT TRY_CONVERT(INT, LTRIM(RTRIM(value)))
        FROM STRING_SPLIT(@status_ids, ',')
        WHERE TRY_CONVERT(INT, LTRIM(RTRIM(value))) IS NOT NULL;
    END
    DECLARE @statusCount INT = (SELECT COUNT(*) FROM @statuses);

    /*
     * Sample Sent (1): a tube the centre has barcoded and dispatched but the
     * lab has not received. Excluded from every list by default — it is not
     * on any bench and has no report — exactly as the legacy portal's
     * usp_pcc_samplestatus leaves it out of "--All--". But that portal DOES
     * show it when the centre picks the status: it is how a centre sees
     * what is in transit, and Infinity gave it no way at all (the worksheet
     * procedure dropped status 1 unconditionally, 24,000 rows a month with
     * nowhere to be seen). So status 1 rows are listed ONLY when asked for
     * by id. The date window uses the row's added date where the LIS left
     * modifieddate NULL, which it does for most of them — the sample has
     * not been modified; it has only been sent.
     */
    DECLARE @wantsSent BIT = CASE WHEN EXISTS (SELECT 1 FROM @statuses WHERE status_id = 1) THEN 1 ELSE 0 END;

    ;WITH H AS (
        SELECT
            P.id                    AS pid,
            U.MCCUnitCode           AS client_code,
            BU.BusinessUnitCode     AS business_unit,
            P.name                  AS patient_name,
            CASE P.gender WHEN 1 THEN 'Male' ELSE 'Female' END AS sex,
            P.age,
            CASE P.age_type
                WHEN 1 THEN 'Year(s)'
                WHEN 2 THEN 'Month(s)'
                WHEN 3 THEN 'Day(s)'
                ELSE 'Unknown'
            END                     AS age_unit,
            S.vailid                AS sid,
            -- The drawn stamp is TWO legacy columns: sample_date holds the day (at
                        -- midnight) and sample_time the clock time on whatever day the record
                        -- was saved — a 23:39 draw keyed in after midnight carries the next
                        -- day's date there. The LIS shows date from the first and time from
                        -- the second; so does this. (156, 2026-09-23)
            CASE WHEN P.sample_date IS NULL OR P.sample_time IS NULL THEN COALESCE(P.sample_time, P.sample_date)
                             ELSE DATEADD(DAY, DATEDIFF(DAY, 0, P.sample_date), CAST(CAST(P.sample_time AS TIME) AS DATETIME)) END AS sample_drawn,
            S.modifieddate          AS regd_at,
            S.lastmodified_date     AS last_modified_at,
            STAT.id                 AS status_code,
            STAT.status             AS status,
            S.testnames             AS test_names_csv,
            -- The per-code type CSV the LIS writes beside testnames: 't'/'p'
            -- for a test or profile booked on its own, 'mt'/'mp' for one that
            -- came out of a package (a "master profile"). Not returned; it is
            -- what decides whether the package lookup below applies to this
            -- tube at all.
            S.testtypes             AS test_types_csv,
            S.patient_id            AS visit_id,
            P.order_number,
            P.bill_number,
            S.Sample_Comments       AS sample_comments,
            S.Sample_ClinicalHistory AS clinical_history,
            SM.Sampletype           AS sample_type,
            -- The bench walks a patient's tubes in a fixed order: EDTA,
            -- fluoride (the NaF plasma family), serum, urine, then whatever
            -- else. Matched on the NAME because the master holds 150 rows of
            -- freehand variants ("Plasma- NaF (F)", "24 Hr Urine Collection")
            -- and an id list would rot the first time someone adds one.
            CASE
                WHEN UPPER(SM.Sampletype) LIKE '%EDTA%' THEN 1
                WHEN UPPER(SM.Sampletype) LIKE '%NAF%'
                  OR UPPER(SM.Sampletype) LIKE '%FLUORIDE%'
                  OR UPPER(SM.Sampletype) LIKE '%FLOURIDE%' THEN 2
                WHEN UPPER(SM.Sampletype) LIKE '%SERUM%' THEN 3
                WHEN UPPER(SM.Sampletype) LIKE '%URINE%' THEN 4
                ELSE 5
            END AS specimen_rank
        FROM dbo.tbl_med_mcc_patient_samples S
        INNER JOIN dbo.tbl_med_mcc_patient_master P ON S.patient_id = P.id
        INNER JOIN dbo.tbl_med_mcc_unit_master U ON P.mcc_code = U.id
        LEFT JOIN dbo.tbl_med_business_unit_master BU ON BU.id = S.business_unit_id
        LEFT JOIN dbo.tbl_med_mcc_patient_samples_status_master STAT ON STAT.id = S.sample_status
        LEFT JOIN dbo.tbl_med_sample_master SM ON SM.id = S.sampleid
        WHERE (
                (S.sample_status > 1 AND S.modifieddate BETWEEN @from AND @to)
             OR (S.sample_status = 1 AND @wantsSent = 1
                 AND COALESCE(S.modifieddate, S.addeddate) BETWEEN @from AND @to)
              )
          AND (@statusCount = 0 OR EXISTS (SELECT 1 FROM @statuses st WHERE st.status_id = S.sample_status))
          AND (
                @sid IS NULL
                OR S.vailid LIKE '%' + @sid + '%'
                OR P.bill_number LIKE '%' + @sid + '%'
              )
          AND (
                @codeCount = 0
                OR EXISTS (SELECT 1 FROM @client_codes c WHERE c.code = U.MCCUnitCode)
              )
          AND (
                @patient_name IS NULL
                OR P.name LIKE '%' + @patient_name + '%'
                OR P.MRNID = @patient_name
              )
          AND (@pid IS NULL OR P.id = @pid)
          -- Narrows WITHIN the scope filter above, never instead of it. A
          -- caller naming a code they were not granted still matches nothing.
          AND (@client_code IS NULL OR U.MCCUnitCode = @client_code)
          AND (@business_unit_id IS NULL OR S.business_unit_id = @business_unit_id)
          AND (
                @department_id IS NULL
                OR EXISTS (
                    SELECT 1
                    FROM dbo.tbl_med_mcc_patient_test_result r
                    INNER JOIN dbo.tbl_med_test_master m ON r.testid = m.id
                    WHERE r.vailid = S.vailid
                      AND m.DepartmentId = @department_id
                      -- 'Head' as well as 'Test': a profile's heading row
                      -- carries the department for panels whose members do not.
                      AND r.testtype IN (N'Test', N'Head')
                )
              )
          AND (
                @test_code IS NULL
                -- The denormalised CSV on the sample answers most lookups
                -- without touching the results table at all.
                OR S.testcodes LIKE '%' + @test_code + '%'
                OR EXISTS (
                    SELECT 1
                    FROM dbo.tbl_med_mcc_patient_test_result r
                    WHERE r.vailid = S.vailid
                      AND (r.testcode = @test_code OR r.testname LIKE '%' + @test_code + '%')
                )
              )
          -- The multi-select form: any one of the listed codes matching admits
          -- the sample. Same per-code match as @test_code above.
          AND (
                @test_codes IS NULL
                OR EXISTS (
                    SELECT 1
                    FROM STRING_SPLIT(@test_codes, ',') c
                    CROSS APPLY (SELECT code = LTRIM(RTRIM(c.value))) t
                    WHERE t.code <> ''
                      AND (
                            S.testcodes LIKE '%' + t.code + '%'
                            OR EXISTS (
                                SELECT 1
                                FROM dbo.tbl_med_mcc_patient_test_result r
                                WHERE r.vailid = S.vailid
                                  AND (r.testcode = t.code OR r.testname LIKE '%' + t.code + '%')
                            )
                          )
                )
              )
    )
    SELECT
        page.client_code,
        page.business_unit,
        page.pid,
        page.patient_name,
        page.sex,
        page.age,
        page.age_unit,
        page.sid,
        page.sample_drawn,
        page.regd_at,
        page.last_modified_at,
        page.status_code,
        page.status,
        page.test_names_csv,
        page.order_number,
        page.bill_number,
        page.sample_comments,
        page.clinical_history,
        page.sample_type,
        page.specimen_rank,
        page.total_count,
        page.patient_count,
        page.as_of,
        /*
         * The package this tube was booked under — what the LIS calls a master
         * profile (ROHTAK HR203A, GENOMIC 20) — so the worklist can name it the
         * way the legacy grid did.
         *
         * NOT read off testnames. The LIS appends "[PACKAGE]" to that CSV on
         * only some of a package's tubes: a four-tube ROHTAK order tags the
         * serum and EDTA tubes and leaves the fluoride and urine tubes as bare
         * "Glucose - Fasting" and "Complete Urine Examination". The order line
         * (tbl_med_mcc_patient_tests, test_type = 'Master') is the one record
         * every tube shares, so it is read from there, and only for a tube
         * whose type CSV says one of its codes came out of a package — a tube
         * of tests booked on their own beside the package must not inherit it.
         *
         * Computed AFTER paging, on the derived table, so it costs one indexed
         * seek per row shown rather than one per row matched.
         */
        CASE WHEN page.test_types_csv LIKE '%m%' THEN
            (SELECT STRING_AGG(CONVERT(NVARCHAR(MAX), LTRIM(RTRIM(t.test_name))), N', ')
                        WITHIN GROUP (ORDER BY t.id)
             FROM dbo.tbl_med_mcc_patient_tests t
             WHERE t.patient_id = page.visit_id
               AND t.test_type = 'Master'
               AND NULLIF(LTRIM(RTRIM(t.test_name)), '') IS NOT NULL)
        END AS package_names
    FROM (
        SELECT
            H.client_code,
            H.business_unit,
            H.pid,
            H.patient_name,
            H.sex,
            H.age,
            H.age_unit,
            H.sid,
            H.sample_drawn,
            H.regd_at,
            H.last_modified_at,
            H.status_code,
            H.status,
            H.test_names_csv,
            H.test_types_csv,
            H.visit_id,
            H.order_number,
            H.bill_number,
            H.sample_comments,
            H.clinical_history,
            H.sample_type,
            H.specimen_rank,
            H.pid_last,
            -- The count of the FILTERED set, before paging. This is what lets the
            -- client say "showing 51-100 of 3,412" instead of guessing.
            COUNT(*) OVER() AS total_count,
            -- Distinct patients over the same set. COUNT(DISTINCT) has no windowed
            -- form, so this is the textbook substitute: the highest dense rank
            -- over pid IS the number of distinct pids, in the same single pass.
            MAX(H.pid_rank) OVER () AS patient_count,
            -- Echoed back by the client on every later page so the set stays fixed.
            @snapshot AS as_of
        FROM (SELECT H0.*,
                     pid_rank = DENSE_RANK() OVER (ORDER BY H0.pid),
                     -- The patient's latest registration in this set: the key a
                     -- grouped list sorts the GROUP by, so a patient sits where
                     -- their newest tube would have, with the older tubes
                     -- beside it rather than pages below.
                     pid_last = MAX(H0.regd_at) OVER (PARTITION BY H0.pid)
              FROM H H0) H
        -- sid is unique per sample, so this ordering is total. Without the
        -- tiebreak, OFFSET paging over tied regd_at values silently duplicates and
        -- drops rows between pages. Grouped: latest-visit patients first, one
        -- patient's tubes contiguous (pid), newest tube first within them.
        ORDER BY
            CASE WHEN @group_by_patient = 1 THEN H.pid_last END DESC,
            CASE WHEN @group_by_patient = 1 THEN H.pid END DESC,
            H.regd_at DESC, H.sid DESC
        OFFSET @offset ROWS FETCH NEXT @size ROWS ONLY
    ) AS page
    -- Restated on the outside: a derived table's ORDER BY only serves its
    -- OFFSET, and the rows it hands out carry no ordering guarantee.
    ORDER BY
        CASE WHEN @group_by_patient = 1 THEN page.pid_last END DESC,
        CASE WHEN @group_by_patient = 1 THEN page.pid END DESC,
        page.regd_at DESC, page.sid DESC
    /* ----------------------------------------------------------------------
     * A plan per call, deliberately.
     *
     * This procedure has twelve optional filters, and the shapes it is asked
     * for differ by orders of magnitude: "today, pending" is a few hundred
     * rows; "ninety days, authorised" is half a million; a patient-name search
     * is a handful. One cached plan has to serve all of them, and whichever
     * shape compiled it wins — every other caller then runs someone else's
     * plan. That is what the API's db.slow log was recording as
     * op=reports.worklist swinging between 570ms and 18.7 SECONDS for the same
     * screen: not load, but whose plan happened to be cached.
     *
     * Measured, with the cache primed by a narrow name search and then asked
     * for the ordinary worksheet page:
     *
     *     worksheet default (2 days, 100 rows)   486ms -> 26ms
     *     page size 1000                         832ms -> 82ms
     *     patient-name search                    519ms -> 75ms
     *     reporting default (7 days)             609ms -> 371ms
     *
     * The trade is real and worth stating: a 90-day window measured slightly
     * SLOWER (2088ms -> 2800ms). Recompiling cannot help a query whose work is
     * genuinely reading half a million rows, and the compilation is then pure
     * cost. That case is rare — the screens default to 1 and 7 days — and a
     * predictable two seconds is a better trade than an unpredictable eighteen.
     * ---------------------------------------------------------------------- */
    OPTION (RECOMPILE);
END
GO

CREATE OR ALTER PROCEDURE dbo.usp_inf_report_by_sid
    @sid                    NVARCHAR(100),
    @client_codes           dbo.ClientCodeList READONLY,
    @include_unauthorized   BIT = 1,
    @public                 BIT = 0
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @codeCount INT = (SELECT COUNT(*) FROM @client_codes);

    ;WITH H AS (
        SELECT
            P.id AS pid,
            U.MCCUnitCode AS client_code,
            BU.BusinessUnitCode AS business_unit,
            -- Numeric processing-unit id, for the NABL rule below. NOT
            -- BU.BusinessUnitCode, which is a STRING here ('QUGEN') — the
            -- numeric column of that name lives on the MCC table.
            S.business_unit_id AS bu_id,
            /*
             * Salutation + name, as the legacy report prints it. The title
             * lives in its own column (initial: 'Mrs', 'Dr', ...) and the
             * order form stores an EMPTY string for the operator's explicit
             * no-salutation choice — see 108's note — so blank and NULL both
             * collapse to just the name, never a stray leading space.
             */
            CONCAT(NULLIF(LTRIM(RTRIM(ISNULL(P.initial, N''))), N'') + N' ',
                   P.name) AS patient_name,
            CASE P.gender WHEN 1 THEN 'Male' ELSE 'Female' END AS sex,
            P.age,
            CASE P.age_type
                WHEN 1 THEN 'Year(s)'
                WHEN 2 THEN 'Month(s)'
                WHEN 3 THEN 'Day(s)'
                ELSE 'Unknown'
            END AS age_unit,
            S.vailid AS sid,
            -- The drawn stamp is TWO legacy columns: sample_date holds the day (at
                        -- midnight) and sample_time the clock time on whatever day the record
                        -- was saved — a 23:39 draw keyed in after midnight carries the next
                        -- day's date there. The LIS shows date from the first and time from
                        -- the second; so does this. (156, 2026-09-23)
            CASE WHEN P.sample_date IS NULL OR P.sample_time IS NULL THEN COALESCE(P.sample_time, P.sample_date)
                             ELSE DATEADD(DAY, DATEDIFF(DAY, 0, P.sample_date), CAST(CAST(P.sample_time AS TIME) AS DATETIME)) END AS sample_drawn,
            S.modifieddate AS regd_at,
            S.lastmodified_date AS last_modified_at,
            STAT.id AS status_code,
            STAT.status AS status,
            S.testnames AS test_names_csv,
            P.order_number,
            P.bill_number,
            S.Sample_Comments AS sample_comments,
            S.Sample_ClinicalHistory AS clinical_history,
            -- Referrers. A linked master row wins; the free-text column is what
            -- the LIS keeps when the name was typed rather than picked, and a
            -- report that prints neither is a report that lost the referral.
            ISNULL(NULLIF(LTRIM(RTRIM(RD.doctor_name)), N''),
                   NULLIF(LTRIM(RTRIM(P.ref_doctor_other)), '')) AS ref_doctor,
            ISNULL(NULLIF(LTRIM(RTRIM(RC.customer_name)), N''),
                   NULLIF(LTRIM(RTRIM(P.ref_customer_other)), '')) AS ref_customer,
            /*
             * Passport / travel ID.
             *
             * usp_telo_create_order mirrors the LIS order form and never leaves
             * MRNID blank: with no passport entered it backfills the PATIENT
             * ID. Printing that verbatim would put the patient id under a
             * "Passport" label on every report that never had one, so an MRNID
             * equal to the pid is treated as absent. Telo draws the same
             * distinction, for the same reason.
             */
            CASE WHEN NULLIF(LTRIM(RTRIM(P.MRNID)), '') IS NOT NULL
                  AND LTRIM(RTRIM(P.MRNID)) <> CONVERT(VARCHAR(20), P.id)
                 THEN LTRIM(RTRIM(P.MRNID)) END AS passport_no,
            -- Date of birth, from the Infinity sidecar. The LIS keeps none; see
            -- 119_table_inf_patient_dob.sql. NULL for any patient booked before
            -- the order form began storing it, and the report prints without a
            -- DOB in that case.
            PD.dob AS date_of_birth
        FROM dbo.tbl_med_mcc_patient_samples S
        INNER JOIN dbo.tbl_med_mcc_patient_master P
            ON S.patient_id = P.id
        LEFT JOIN dbo.inf_patient_dob PD
            ON PD.patient_id = P.id
        LEFT JOIN dbo.tbl_med_mcc_doctors RD
            ON RD.id = P.ref_doctor
        LEFT JOIN dbo.tbl_med_mcc_customer RC
            ON RC.id = P.ref_customer
        INNER JOIN dbo.tbl_med_mcc_unit_master U
            ON P.mcc_code = U.id
        LEFT JOIN dbo.tbl_med_business_unit_master BU
            ON BU.id = S.business_unit_id
        LEFT JOIN dbo.tbl_med_mcc_patient_samples_status_master STAT
            ON STAT.id = S.sample_status
        -- The whole point: an equality predicate on a unique key.
        WHERE S.vailid = @sid
          -- Sample Sent (1) never reaches a report, matching the search
          -- procedure so the two cannot disagree about what exists.
          AND S.sample_status > 1
          AND (
                @codeCount = 0
                OR EXISTS (
                    SELECT 1 FROM @client_codes c
                    WHERE c.code = LTRIM(RTRIM(U.MCCUnitCode))
                )
              )
    )
    SELECT
        H.client_code,
        H.business_unit,
        H.pid,
        H.patient_name,
        H.sex,
        H.age,
        H.age_unit,
        H.sid,
        H.sample_drawn,
        H.regd_at,
        H.last_modified_at,
        H.status_code,
        H.status,
        H.test_names_csv,
        H.order_number,
        H.bill_number,
        H.sample_comments,
        H.clinical_history,
        H.ref_doctor,
        H.ref_customer,
        H.passport_no,
        H.date_of_birth,
        (
            SELECT MAX(r2.updateddate)
            FROM dbo.tbl_med_mcc_patient_test_result r2
            WHERE r2.vailid = H.sid
        ) AS tat,
        (
            SELECT
                r.id AS result_id,
                r.testcode AS test_code,
                -- The catalogue id this row was measured against. Not display
                -- data: it is the key the report's own structure is rebuilt
                -- from. A multi-parameter test emits an untitled "report name"
                -- Head immediately before the real coded Head its Param rows
                -- hang off, and the two are the same test only in that they
                -- share this id — without it the report prints the title
                -- twice. It is also what the interpretation-image attachment
                -- and the age-banded reference range are keyed on.
                r.testid AS test_id,
                r.testname AS test_name,
                r.testtype AS test_type,
                r.value,
                r.testunit AS unit,
                r.testnormal_range AS normal_range,
                CONVERT(bit, ISNULL(r.abnormal, 0)) AS abnormal,
                CONVERT(bit, ISNULL(r.auth, 0)) AS authorized,
                r.comments,
                r.updateddate AS updated_at,
                d.Code AS department_code,
                d.Name AS department_name,
                -- The catalogue's display name, for a row that carries none of
                -- its own. NOT the name to print in preference to r.testname:
                -- this join is on r.testid, and a profile's heading, its
                -- sub-headings and every analyte beneath them all share one
                -- testid — so this column holds the same string for all of
                -- them. See nameOf() in PrintReport.tsx.
                m.ReportTestname AS report_test_name,
                m.Method AS method,
                -- The PARAMETER's own method, from the parameter master, where
                -- the row has one. m.Method above is the TEST's — one string
                -- for the whole CBC ("Automated 5 Part Analyzer, DLC
                -- Flowcytometry") — and printing it on every analyte named the
                -- instrument, not the method. Haemoglobin is Colorimetry, RBC
                -- is Electrical Impedance, MCV is Calculated; the differential
                -- sub-heads carry theirs and their analytes fall back to it.
                -- Resolution order lives in reportModel.ts.
                pm.Method AS param_method,
                -- NVARCHAR(MAX): Interpretation is a text/ntext column on the
                -- legacy schema and FOR JSON will not serialise it untouched.
                CAST(m.Interpretation AS NVARCHAR(MAX)) AS interpretation,
                -- The real parent link. The report's nesting was being inferred
                -- from row order alone, which is right until a profile's rows
                -- are not contiguous.
                r.profile_id,
                sm.Sampletype AS specimen,
                /*
                 * NABL medallion, as the legacy LIS prints it: a Delhi-processed
                 * sample (business unit 1 — the NABL-accredited lab) marks every
                 * accredited test's own row and its section headings, never the
                 * Param analytes and never the Profile banner. Ported from the
                 * GET_PATIENT_REPORT_* family's
                 *     CASE WHEN BusinessUnitCode = 1 AND Nabl_Logo = 1
                 *           AND testtype IN ('Test','Head') THEN 1 ELSE 0 END
                 * with one correction verified against the LIS's own printed
                 * output: the deployed print keys on the SAMPLE's processing
                 * unit, not the collection centre's home unit — a BU-17 centre's
                 * sample processed in Delhi (SID 9293660) prints the medallions.
                 * Accreditation belongs to the lab that ran the test.
                 *
                 * Or the report is listed in inf_report_nabl_override (script
                 * 142): a per-SID, one-time decision to print the mark on a
                 * report whose test the catalogue does not accredit. Same
                 * rows as the rule above — Test and Head, never Param — so
                 * the print is indistinguishable from an accredited one.
                 * An override flagged qr_only applies to the patient's copy
                 * behind the QR alone (@public = 1); the lab's own downloads
                 * and viewer print the report as the catalogue has it.
                 */
                CONVERT(bit, CASE WHEN r.testtype IN (N'Test', N'Head')
                                   AND ((H.bu_id = 1 AND m.Nabl_Logo = 1)
                                        OR EXISTS (SELECT 1 FROM dbo.inf_report_nabl_override o
                                                   WHERE o.sid = H.sid
                                                     AND (o.qr_only = 0 OR @public = 1)))
                                  THEN 1 ELSE 0 END) AS nabl
            FROM dbo.tbl_med_mcc_patient_test_result r
            LEFT JOIN dbo.tbl_med_test_master m ON r.testid = m.id
            LEFT JOIN dbo.tbl_med_parameter_master pm ON pm.id = r.paramid
            LEFT JOIN dbo.tbl_med_department_master d ON m.DepartmentId = d.id
            LEFT JOIN dbo.tbl_med_sample_master sm ON sm.id = m.SampleId
            WHERE r.vailid = H.sid
              AND (@include_unauthorized = 1 OR r.auth = 1)
            -- Report order: headings, then profile rows, then analytes.
            ORDER BY
                CASE r.testtype
                    WHEN N'Head' THEN 0
                    WHEN N'Profile' THEN 1
                    WHEN N'Test' THEN 2
                    ELSE 3
                END,
                r.id
            FOR JSON PATH
        ) AS results_json
    FROM H
    -- A SID is unique, but the legacy data has been known to carry a duplicate;
    -- newest wins, matching the search procedure's ordering.
    ORDER BY H.regd_at DESC;
END
GO
