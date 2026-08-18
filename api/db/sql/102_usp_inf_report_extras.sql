/*
 * Everything a printed report carries that is not a result.
 *
 * The collection centre it was drawn at, the business unit that processed it,
 * who signs it, and the profile-level clinical interpretation. All keyed off
 * one SID so the renderer makes one round trip rather than five — this runs on
 * every PDF, and a report is not rendered until the last of them lands.
 *
 * Four result sets, in this order:
 *   1. collection centre   (0 or 1 rows)
 *   2. business unit       (0 or 1 rows)
 *   3. signatories         (0..3 rows, ordered, WITH the signature image)
 *   4. profile interpretations for the profiles ON this report
 *
 * Ported from Telo's db/read/{mccUnits,signatures,profileInterpretations}.ts.
 * The queries are theirs; the packaging into one procedure is not, because
 * Telo issues them as separate awaited reads from Node and Infinity renders
 * from a single API call.
 */
CREATE OR ALTER PROCEDURE dbo.usp_inf_report_extras
    @sid NVARCHAR(50)
AS
BEGIN
    SET NOCOUNT ON;
    SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;

    DECLARE @v NVARCHAR(50) = NULLIF(LTRIM(RTRIM(@sid)), N'');

    DECLARE @patientId INT, @clientCode NVARCHAR(50), @businessUnitId INT;

    SELECT TOP 1
        @patientId      = S.patient_id,
        @clientCode     = U.MCCUnitCode,
        @businessUnitId = S.business_unit_id
    FROM dbo.tbl_med_mcc_patient_samples S
    INNER JOIN dbo.tbl_med_mcc_patient_master P ON P.id = S.patient_id
    LEFT JOIN dbo.tbl_med_mcc_unit_master U ON U.id = P.mcc_code
    WHERE S.vailid = @v;

    -- 1 ── where the sample was collected -----------------------------------
    -- The centre's own name and contact, printed as "Collected at". A patient
    -- ringing about a report rings the centre they walked into, not the lab.
    SELECT TOP 1
        code    = LTRIM(RTRIM(MCCUnitCode)),
        name    = NULLIF(LTRIM(RTRIM(MCCUnitName)), N''),
        address = NULLIF(LTRIM(RTRIM(address)), N''),
        city    = NULLIF(LTRIM(RTRIM(city)), N''),
        phone   = NULLIF(LTRIM(RTRIM(phone)), N''),
        email   = NULLIF(LTRIM(RTRIM(email)), N'')
    FROM dbo.tbl_med_mcc_unit_master
    WHERE MCCUnitCode = @clientCode;

    -- 2 ── which lab processed it -------------------------------------------
    SELECT TOP 1
        id      = id,
        name    = NULLIF(LTRIM(RTRIM(BusinessUnitName)), N''),
        address = NULLIF(LTRIM(RTRIM(address)), N''),
        city    = NULLIF(LTRIM(RTRIM(city)), N''),
        phone   = NULLIF(LTRIM(RTRIM(phone)), N'')
    FROM dbo.tbl_med_business_unit_master
    WHERE id = @businessUnitId;

    /*
     * 3 ── who signs it
     *
     * ── WHY THIS IS DEPARTMENT-AWARE ───────────────────────────────────────
     * A business unit's signatory list contains specialists. The microbiology
     * MD is configured against the BU, but signing a lipid profile is not
     * something they did — and the LIS's own Department_View_Sign export knows
     * that, because tbl_med_department_master carries Fist_doctor/Second_doctor
     * pointing back at the signature rows.
     *
     * So a signatory mapped to one or more departments prints only when the
     * report actually contains one of them. A signatory mapped to NO department
     * is general to the unit and always prints. Getting this wrong puts a real
     * doctor's signature on a report they had no part in, which is the whole
     * reason the mapping exists.
     *
     * Deduplicated by name: the same person is frequently configured twice, and
     * a report with one signature printed twice looks like a mistake because it
     * is one. The department-mapped row wins the tie, since it is the more
     * specific configuration.
     *
     * Capped at three. The letterhead's signature band fits three; a fourth
     * would print over the footer.
     */
    -- The departments this report actually contains.
    --
    -- A temp table rather than a CTE or a table variable, for two reasons: it
    -- is read twice (once to decide which configured signatory is entitled to
    -- sign, once by the fallback), and a #temp is visible inside the nested
    -- sp_executesql scope the fallback runs in, where a @variable would not be.
    CREATE TABLE #depts (dept NVARCHAR(200) PRIMARY KEY);
    INSERT INTO #depts (dept)
    SELECT DISTINCT UPPER(LTRIM(RTRIM(d.Name)))
    FROM dbo.tbl_med_mcc_patient_test_result r
    LEFT JOIN dbo.tbl_med_test_master m ON m.id = r.testid
    LEFT JOIN dbo.tbl_med_department_master d ON d.id = m.DepartmentId
    WHERE r.vailid = @v AND d.Name IS NOT NULL;

    -- ord carries the print order through to the final SELECT: the fallback
    -- path below has no DOC_TYPE to sort by, only the order it inserted in.
    CREATE TABLE #signers (
        ord          INT IDENTITY(1,1),
        id           INT,
        doctor_name  NVARCHAR(200),
        designation  NVARCHAR(200),
        doc_type     INT,
        signature    VARBINARY(MAX)
    );

    ;WITH dept_signers AS (
        SELECT sig_id = d.Fist_doctor,   dept = UPPER(LTRIM(RTRIM(d.Name)))
        FROM dbo.tbl_med_department_master d WHERE d.Fist_doctor   IS NOT NULL
        UNION
        SELECT sig_id = d.Second_doctor, dept = UPPER(LTRIM(RTRIM(d.Name)))
        FROM dbo.tbl_med_department_master d WHERE d.Second_doctor IS NOT NULL
    ),
    candidates AS (
        SELECT
            s.id,
            doctor_name = NULLIF(LTRIM(RTRIM(s.Doctorname)), N''),
            designation = NULLIF(LTRIM(RTRIM(s.Designation)), N''),
            doc_type    = ISNULL(s.DOC_TYPE, 99),
            -- Configured against any department at all?
            is_mapped   = CASE WHEN EXISTS (
                              SELECT 1 FROM dept_signers ds WHERE ds.sig_id = s.id)
                          THEN 1 ELSE 0 END,
            -- Configured against a department THIS report contains?
            signs_here  = CASE WHEN EXISTS (
                              SELECT 1 FROM dept_signers ds
                              INNER JOIN #depts rd ON rd.dept = ds.dept
                              WHERE ds.sig_id = s.id)
                          THEN 1 ELSE 0 END
        FROM dbo.tbl_med_signature_master s
        WHERE s.Business_Unit_id = @businessUnitId
          AND ISNULL(s.IsActive, 1) = 1
          AND s.Signature IS NOT NULL
    ),
    eligible AS (
        SELECT * FROM candidates WHERE is_mapped = 0 OR signs_here = 1
    ),
    -- One row per person. Strip a leading "Dr" and any punctuation so the same
    -- doctor spelled two ways collapses to one.
    deduped AS (
        SELECT *, rn = ROW_NUMBER() OVER (
            PARTITION BY LOWER(
                REPLACE(REPLACE(REPLACE(REPLACE(
                    CASE WHEN doctor_name LIKE N'Dr.%' THEN LTRIM(SUBSTRING(doctor_name, 4, 200))
                         WHEN doctor_name LIKE N'Dr %'  THEN LTRIM(SUBSTRING(doctor_name, 3, 200))
                         ELSE doctor_name END,
                    N' ', N''), N'.', N''), N',', N''), N'-', N''))
            -- The department-mapped configuration is the more specific one.
            ORDER BY signs_here DESC, doc_type, id)
        FROM eligible
    )
    INSERT INTO #signers (id, doctor_name, designation, doc_type, signature)
    SELECT TOP 3
        d.id, d.doctor_name, d.designation, d.doc_type, s.Signature
    FROM deduped d
    INNER JOIN dbo.tbl_med_signature_master s ON s.id = d.id
    WHERE d.rn = 1
    ORDER BY d.doc_type, d.id;

    /*
     * ── THE FALLBACK, AND WHY A REPORT MUST NOT GO OUT WITHOUT ONE ─────────
     *
     * Not every business unit has signatories of its own. Where
     * tbl_med_signature_master holds no usable row for the unit, everything
     * above selects nothing and the report printed UNSIGNED.
     *
     * That is the one failure here a reader cannot see is a failure. A missing
     * result is obvious; a missing signature is a sheet that looks complete
     * with an empty space where a pathologist put their name, and it is not a
     * report at all — it is a page of numbers nobody has taken responsibility
     * for.
     *
     * The LIS does not do that. GET_PATIENT_REPORT_VAIL_ID falls back to
     * Department_View_Sign, which carries each department's default PRIMARY
     * (Expr1/Expr2/Expr3) and SECONDARY (Doctorname/Designation/Signature)
     * doctor — the head-office signatories. Restricted to the departments on
     * THIS report, so a microbiology report is signed by the microbiologist
     * and a biochemistry one is not.
     *
     * Primaries before secondaries, mirroring the DOC_TYPE 1 → 2 ordering the
     * configured path uses, so a given person lands on the same side of the QR
     * whichever path found them. Ids are synthetic and NEGATIVE: these rows do
     * not come from tbl_med_signature_master and must never be taken for a row
     * that does.
     *
     * Ported from Telo's getDefaultSigners (db/read/signatures.ts).
     *
     * Wrapped in sp_executesql for the same reason the interpretation block
     * below is: the view belongs to the LIS, and a deployment that lacks it
     * should print an unsigned report rather than fail to render one at all.
     */
    IF NOT EXISTS (SELECT 1 FROM #signers)
       AND OBJECT_ID('dbo.Department_View_Sign') IS NOT NULL
    BEGIN
        EXEC sp_executesql N'
            ;WITH flat AS (
                SELECT tier = 1,
                       doctor_name = NULLIF(LTRIM(RTRIM(v.Expr1)), N''''),
                       designation = NULLIF(LTRIM(RTRIM(v.Expr2)), N''''),
                       signature   = v.Expr3
                FROM dbo.Department_View_Sign v
                WHERE UPPER(LTRIM(RTRIM(v.Name))) IN (SELECT dept FROM #depts)
                UNION ALL
                SELECT tier = 2,
                       NULLIF(LTRIM(RTRIM(v.Doctorname)), N''''),
                       NULLIF(LTRIM(RTRIM(v.Designation)), N''''),
                       v.Signature
                FROM dbo.Department_View_Sign v
                WHERE UPPER(LTRIM(RTRIM(v.Name))) IN (SELECT dept FROM #depts)
            ),
            usable AS (
                SELECT * FROM flat
                WHERE doctor_name IS NOT NULL
                  AND signature IS NOT NULL
                  AND DATALENGTH(signature) > 0
            ),
            -- The same head-office doctor is the default for several
            -- departments, so a three-department report would otherwise print
            -- one signature three times.
            ranked AS (
                SELECT *, rn = ROW_NUMBER() OVER (
                    PARTITION BY LOWER(REPLACE(doctor_name, N'' '', N''''))
                    ORDER BY tier)
                FROM usable
            )
            INSERT INTO #signers (id, doctor_name, designation, doc_type, signature)
            SELECT TOP 3
                   id = -ROW_NUMBER() OVER (ORDER BY tier, doctor_name),
                   doctor_name, designation, doc_type = tier, signature
            FROM ranked
            WHERE rn = 1
            ORDER BY tier, doctor_name;';
    END

    SELECT id, doctor_name, designation, doc_type, signature
    FROM #signers
    ORDER BY ord;

    DROP TABLE #signers;
    DROP TABLE #depts;

    /*
     * 4 ── profile-level interpretation
     *
     * dbo.telo_profile_interpretation is Telo's sidecar, edited in Telo's admin
     * screen. Infinity READS it and does not own it: the clinical text under a
     * profile must be the same sentence whichever platform printed the report,
     * and a second copy is two sentences waiting to disagree.
     *
     * Wrapped because the table is Telo's to deploy — if it is not there, a
     * report should print without the interpretation rather than fail.
     */
    IF OBJECT_ID('dbo.telo_profile_interpretation', 'U') IS NOT NULL
    BEGIN
        EXEC sp_executesql N'
            SELECT DISTINCT
                pi.profile_id,
                interpretation = CAST(pi.interpretation AS NVARCHAR(MAX))
            FROM dbo.telo_profile_interpretation pi
            WHERE pi.interpretation IS NOT NULL
              AND LEN(CAST(pi.interpretation AS NVARCHAR(MAX))) > 0
              -- Only the profiles actually on this report.
              AND EXISTS (
                  SELECT 1 FROM dbo.tbl_med_mcc_patient_test_result r
                  WHERE r.vailid = @v AND r.profile_id = pi.profile_id)',
            N'@v NVARCHAR(50)', @v = @v;
    END
    ELSE
    BEGIN
        -- Same shape, no rows, so the caller reads four result sets either way.
        SELECT profile_id = CAST(NULL AS INT), interpretation = CAST(NULL AS NVARCHAR(MAX))
        WHERE 1 = 0;
    END
END
GO
