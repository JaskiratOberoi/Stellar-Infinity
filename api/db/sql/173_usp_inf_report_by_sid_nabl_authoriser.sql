/* QUOTED_IDENTIFIER is baked in at creation time; see script 70. */
SET QUOTED_IDENTIFIER ON;
GO
/*
 * 173_usp_inf_report_by_sid_nabl_authoriser.sql  (re-issue of 77 as deployed)
 *
 * The NABL medallion needs the sample stamped as Delhi-processed (business
 * unit 1) AND authorised by a Delhi-unit user. The LIS stamps the sample with
 * the accessioning or inwarding LOGIN's unit, and LUCKNOWACC's user record
 * says unit 1, so a CBC run and signed in Lucknow (SID 23664594, 2026-09-30)
 * printed the mark. Jas's decision, 2026-09-30: guard on the authoriser too.
 * A sample that records no authoriser keeps the stamped-unit rule alone.
 *
 * This is Infinity's own read procedure; the legacy LIS prints from its own
 * code and is untouched. Departs from legacy parity on purpose.
 *
 * Generated from the deployed body (OBJECT_DEFINITION) with the two
 * additions below; everything else is as deployed.
 */

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
            -- The unit of the user who authorised the sample, for the NABL
            -- rule below: the mark needs the sample stamped Delhi AND a Delhi
            -- authoriser. A sample accessioned under a login whose LIS user
            -- record says unit 1 (LUCKNOWACC, 2026-09-30: SID 23664594) is
            -- stamped Delhi though Lucknow ran and signed it. NULL when the
            -- sample records no authoriser (an older sample, an auto-auth).
            (SELECT TOP (1) um.Business_Unit_id FROM dbo.tbl_med_user_master um
              WHERE um.id = NULLIF(S.authorised_by, 0)) AS auth_bu,
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
                                   AND ((H.bu_id = 1 AND m.Nabl_Logo = 1
                                         -- Script 173: and authorised from Delhi,
                                         -- when the sample says who authorised it.
                                         AND (H.auth_bu IS NULL OR H.auth_bu = 1))
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
