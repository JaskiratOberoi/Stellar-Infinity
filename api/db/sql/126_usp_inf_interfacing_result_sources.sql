/* QUOTED_IDENTIFIER is baked in at creation time; see script 70. */
SET QUOTED_IDENTIFIER ON;
GO
/*
 * 126_usp_inf_interfacing_result_sources.sql
 *
 * Interfaced-vs-manual result counts, per day per business unit per machine,
 * from the LIS's own result table.
 *
 * GROUND TRUTH. dbo.tbl_med_mcc_patient_test_result.machine_name records HOW a
 * value arrived: non-empty means an analyser or import wrote it ('IMPORT' is
 * the file importer; any other value is the instrument/machine name — the
 * remote Synapse middleware writes machine_name the same way), and empty/NULL
 * means a human typed it. That single column is what this whole breakdown
 * hangs off.
 *
 * ── JOIN AND DATE TOPOLOGY — MIRRORED FROM usp_inf_worksheet_list (76) ──────
 * The result table carries 67.4 MILLION rows (measured in script 77) and no
 * useful date index of its own, so this must never be driven by a date
 * predicate on the results. Instead it copies the shape every existing stats
 * and worksheet read uses:
 *
 *   1. Drive from dbo.tbl_med_mcc_patient_samples S, filtered on
 *      S.modifieddate BETWEEN @from-midnight AND @to-end-of-day — the same
 *      indexed registration-date window scripts 76 and the legacy worksheet
 *      procedure seek on.
 *   2. Join results by r.vailid = S.vailid — an equality on the key the
 *      result table "already carries seven indexes leading on" (script 77).
 *   3. Business unit from S.business_unit_id → tbl_med_business_unit_master,
 *      exactly as 76 resolves BusinessUnitCode/BusinessUnitName.
 *
 * The reported "day" is therefore the sample's REGISTRATION day
 * (S.modifieddate), matching what the worksheet and reporting screens call a
 * day — not the moment the value was written, which the LIS does not index.
 *
 * READ UNCOMMITTED for the same reason 76 states: this reads a live LIS that
 * clinicians are writing to, and an aggregation taking shared locks across a
 * date range would block result entry. A monitoring count tolerates a dirty
 * read.
 *
 * The caller (API) limits the range to 92 days; the guard here is the
 * backstop so nobody can aim an unbounded scan at the live LIS by calling the
 * procedure directly.
 */
CREATE OR ALTER PROCEDURE dbo.usp_inf_interfacing_result_sources
    @from DATE,
    @to   DATE
AS
BEGIN
    SET NOCOUNT ON;
    SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;

    IF @from IS NULL OR @to IS NULL OR @from > @to
    BEGIN
        RAISERROR('A from/to date range is required.', 16, 1);
        RETURN;
    END

    IF DATEDIFF(DAY, @from, @to) > 92
    BEGIN
        RAISERROR('The range may cover at most 92 days.', 16, 1);
        RETURN;
    END

    -- Hour bounds exactly as script 76 computes its window: to the last second
    -- of the to-date, not midnight at its start.
    DECLARE @fromDt DATETIME = CAST(@from AS DATETIME);
    DECLARE @toDt   DATETIME = DATEADD(SECOND, -1, DATEADD(DAY, 1, CAST(@to AS DATETIME)));

    SELECT
        [day]              = CAST(S.modifieddate AS DATE),
        business_unit_id   = S.business_unit_id,
        business_unit_code = BU.BusinessUnitCode,
        business_unit_name = BU.BusinessUnitName,
        -- NULL for manual: the machine grouping only means something for
        -- interfaced rows, and folding every hand-typed value under an empty
        -- machine "name" would print a machine that does not exist.
        machine_name = CASE WHEN NULLIF(LTRIM(RTRIM(r.machine_name)), N'') IS NULL
                            THEN CAST(NULL AS NVARCHAR(50))
                            ELSE LTRIM(RTRIM(r.machine_name)) END,
        entry_mode = CASE WHEN NULLIF(LTRIM(RTRIM(r.machine_name)), N'') IS NULL
                          THEN 'manual' ELSE 'interfaced' END,
        result_count = COUNT_BIG(*)
    FROM dbo.tbl_med_mcc_patient_samples S
    INNER JOIN dbo.tbl_med_mcc_patient_test_result r ON r.vailid = S.vailid
    LEFT JOIN dbo.tbl_med_business_unit_master BU ON BU.id = S.business_unit_id
    WHERE S.modifieddate BETWEEN @fromDt AND @toDt
      -- Sample Sent (1) never reaches a result, matching 76/77.
      AND S.sample_status > 1
      -- Real measured values only: headings and profile scaffolding rows carry
      -- no value of their own, and an empty value is a row nobody entered yet.
      AND r.testtype IN (N'Test', N'Param')
      AND NULLIF(LTRIM(RTRIM(r.value)), N'') IS NOT NULL
    GROUP BY
        CAST(S.modifieddate AS DATE),
        S.business_unit_id,
        BU.BusinessUnitCode,
        BU.BusinessUnitName,
        CASE WHEN NULLIF(LTRIM(RTRIM(r.machine_name)), N'') IS NULL
             THEN CAST(NULL AS NVARCHAR(50))
             ELSE LTRIM(RTRIM(r.machine_name)) END,
        CASE WHEN NULLIF(LTRIM(RTRIM(r.machine_name)), N'') IS NULL
             THEN 'manual' ELSE 'interfaced' END
    ORDER BY [day] DESC, business_unit_name, entry_mode, machine_name
    /* A plan per call, for the same reason 76 takes one: the window swings
       from one day to three months, and whichever shape compiled first would
       otherwise serve every other caller its plan. The API caches this result
       for five minutes, so the compile is paid rarely. */
    OPTION (RECOMPILE);
END
GO

PRINT 'Created/updated usp_inf_interfacing_result_sources.';
GO
