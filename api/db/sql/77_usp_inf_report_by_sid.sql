SET QUOTED_IDENTIFIER ON;
GO
/*
 * 77_usp_inf_report_by_sid.sql
 *
 * ONE report, by exact SID.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 *
 * Opening a single report took 13 SECONDS, every time, measured in the API's
 * own db.slow log (op=reports.worksheet, ms=13315 / 14174 / 13430 / 13354).
 *
 * The cause was not an index and not the reference-range join. It was the route
 * taken to fetch one sample: ReportsRepository.GetBySidAsync called the paged
 * SEARCH procedure, usp_listec_worksheet_report_by_codes, and — because that
 * procedure requires a date window and a SID lookup should not depend on the
 * operator guessing when the sample was drawn — it passed
 *
 *     fromDate: '2015-01-01', toDate: tomorrow
 *
 * so every report open swept a decade of samples. Worse, that procedure's SID
 * filter is a search filter:
 *
 *     S.vailid LIKE '%' + @sid + '%'
 *
 * A leading wildcard cannot seek. tbl_med_mcc_patient_test_result carries 67.4
 * million rows and tbl_med_mcc_patient_samples is sized to match, so the plan
 * had no choice but to scan ten years of samples and evaluate a wildcard
 * against each one, to return the single row already identified by an exact,
 * unique key.
 *
 * The LIKE is correct where it lives: that procedure powers the worksheet's
 * SID search box, where typing "9388" must find 09388225, and it is SHARED with
 * Telo, so it is not Infinity's to narrow. The mistake was reusing a search for
 * a lookup.
 *
 * This procedure is the lookup. `S.vailid = @sid` seeks — the table already
 * carries seven indexes leading on vailid — and there is no date window at all,
 * because an exact unique key does not need one.
 *
 * Column-for-column identical to the search procedure's projection, including
 * results_json, so ReportsRepository maps the same reader either way.
 * ---------------------------------------------------------------------------
 *
 * Scope is enforced by the caller passing its client codes as a TVP. An empty
 * TVP means unrestricted; the endpoint short-circuits "may see nothing" before
 * calling. Read-only.
 */
CREATE OR ALTER PROCEDURE dbo.usp_inf_report_by_sid
    @sid                    NVARCHAR(100),
    @client_codes           dbo.ClientCodeList READONLY,
    @include_unauthorized   BIT = 1
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @codeCount INT = (SELECT COUNT(*) FROM @client_codes);

    ;WITH H AS (
        SELECT
            P.id AS pid,
            U.MCCUnitCode AS client_code,
            BU.BusinessUnitCode AS business_unit,
            P.name AS patient_name,
            CASE P.gender WHEN 1 THEN 'Male' ELSE 'Female' END AS sex,
            P.age,
            CASE P.age_type
                WHEN 1 THEN 'Year(s)'
                WHEN 2 THEN 'Month(s)'
                WHEN 3 THEN 'Day(s)'
                ELSE 'Unknown'
            END AS age_unit,
            S.vailid AS sid,
            P.sample_time AS sample_drawn,
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
                -- NVARCHAR(MAX): Interpretation is a text/ntext column on the
                -- legacy schema and FOR JSON will not serialise it untouched.
                CAST(m.Interpretation AS NVARCHAR(MAX)) AS interpretation,
                -- The real parent link. The report's nesting was being inferred
                -- from row order alone, which is right until a profile's rows
                -- are not contiguous.
                r.profile_id,
                sm.Sampletype AS specimen
            FROM dbo.tbl_med_mcc_patient_test_result r
            LEFT JOIN dbo.tbl_med_test_master m ON r.testid = m.id
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
