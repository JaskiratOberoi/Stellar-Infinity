/* QUOTED_IDENTIFIER is baked in at creation time; see script 70. */
SET QUOTED_IDENTIFIER ON;
GO
/*
 * 76_usp_inf_worksheet_list.sql
 *
 * The worklist, paged HONESTLY: every filter is applied before paging, and the
 * total row count comes back with the page.
 *
 * ── WHY THIS EXISTS RATHER THAN REUSING THE LEGACY PROCEDURE ───────────────
 * dbo.usp_listec_worksheet_report_by_codes is shared with Telo and must not be
 * altered. Three of its properties made the worklist quietly lie:
 *
 *   1. It takes ONE @status_id. Infinity's default "pending only" view wants a
 *      SET of statuses, so the SPA fetched a page of 50 and filtered it in the
 *      browser. If 6 of those 50 were pending, the operator saw six rows and a
 *      disabled Next button — a page of results presented as the whole list.
 *      Filtering after paging cannot be made correct by any amount of care in
 *      the client; the filter has to reach the WHERE clause.
 *
 *   2. It returns no total. The SPA inferred "there is a next page" from a full
 *      page of rows, which is wrong in both directions: a result set that is an
 *      exact multiple of the page size offers a Next that leads nowhere, and any
 *      client-side filtering makes the inference meaningless.
 *
 *   3. ORDER BY regd_at DESC alone is not deterministic. regd_at ties are
 *      common — a patient's tubes are registered in the same second — and with
 *      OFFSET paging a tie that sorts differently between two queries shows one
 *      row twice and drops another entirely. The tiebreak below is what makes
 *      paging total rather than approximate.
 *
 * This procedure also drops the per-row results_json subquery. The list view has
 * never rendered it, and FOR JSON PATH per row was the dominant cost — which is
 * what made large pages expensive and small pages tempting in the first place.
 * Opening a sample still reads the full results through the worksheet path.
 *
 * ── @as_of: WHY PAGING A LIVE TABLE NEEDS A SNAPSHOT ───────────────────────
 * This is a production LIS with registrations arriving continuously. Measured
 * while walking 40 pages of a 30-day window, the matching total rose from
 * 183,767 to 183,774 mid-walk. Because the sort is newest-first, each new row
 * lands at the TOP and pushes everything down by one — so a row on page 3 slides
 * onto page 4 and is shown twice, while the row that was at the foot of page 4
 * slides to page 5 and, if the operator was already past it, is never seen.
 *
 * That is the failure this whole change exists to remove, arriving by a
 * different door: the operator believes they have worked the list, and a sample
 * they never saw is sitting in it.
 *
 * So the caller pins @as_of on the first request and echoes it back on every
 * later page. Every page then describes ONE set. The trade is that the snapshot
 * ages, which is why as_of is returned for the UI to display and why refreshing
 * clears it — a stale list the operator can see is stale beats a moving one
 * they cannot.
 *
 * ── FILTER PARITY WITH THE LEGACY WORKSHEET ────────────────────────────────
 * SampleWorksheet.aspx offers: from/to date each with an hour, patient name,
 * patient number, status, client code (PCC), test code, barcode/SID,
 * department, business unit, and a TAT checkbox. Every one of those is a
 * parameter here, and the predicates are copied from the legacy procedure so a
 * search returns the same rows in both systems.
 *
 * The exception is TAT. The LIS passes @tat into
 * usp_worksheet_sample02072020, and that procedure never references it — the
 * checkbox has no effect on the results. It is therefore NOT reproduced here:
 * carrying over a control that silently does nothing would be worse than
 * leaving it out, because an operator would believe they had filtered.
 */
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
    @page            INT           = 1,
    @page_size       INT           = 100,
    -- Upper bound on modifieddate, pinned by the caller so that paging walks a
    -- fixed set. NULL means "now", which the procedure returns for the caller
    -- to send back on subsequent pages.
    @as_of           DATETIME      = NULL
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
            P.sample_time           AS sample_drawn,
            S.modifieddate          AS regd_at,
            S.lastmodified_date     AS last_modified_at,
            STAT.id                 AS status_code,
            STAT.status             AS status,
            S.testnames             AS test_names_csv,
            P.order_number,
            P.bill_number,
            S.Sample_Comments       AS sample_comments,
            S.Sample_ClinicalHistory AS clinical_history
        FROM dbo.tbl_med_mcc_patient_samples S
        INNER JOIN dbo.tbl_med_mcc_patient_master P ON S.patient_id = P.id
        INNER JOIN dbo.tbl_med_mcc_unit_master U ON P.mcc_code = U.id
        LEFT JOIN dbo.tbl_med_business_unit_master BU ON BU.id = S.business_unit_id
        LEFT JOIN dbo.tbl_med_mcc_patient_samples_status_master STAT ON STAT.id = S.sample_status
        WHERE S.modifieddate BETWEEN @from AND @to
          AND S.sample_status > 1
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
        -- The count of the FILTERED set, before paging. This is what lets the
        -- client say "showing 51-100 of 3,412" instead of guessing.
        COUNT(*) OVER() AS total_count,
        -- Echoed back by the client on every later page so the set stays fixed.
        @snapshot AS as_of
    FROM H
    -- sid is unique per sample, so this ordering is total. Without the
    -- tiebreak, OFFSET paging over tied regd_at values silently duplicates and
    -- drops rows between pages.
    ORDER BY H.regd_at DESC, H.sid DESC
    OFFSET @offset ROWS FETCH NEXT @size ROWS ONLY;
END
GO
