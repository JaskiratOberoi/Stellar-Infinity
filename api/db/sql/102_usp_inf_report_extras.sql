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
    -- Infinity's own footer identity wins over the shared row: BU 1 (Delhi)
    -- carries placeholder data there ("QUGEN PATHLABS"), which the legacy LIS
    -- never prints — its Crystal footer is hardcoded. inf_business_unit_footer
    -- (137) holds what Infinity prints instead, plus the accreditation line
    -- ("MC-2547 NABL Accredited") the LISTEC portal shows for Delhi.
    -- A footer row REPLACES the identity outright — including a NULL phone,
    -- so Delhi prints exactly what the old portal prints, with no stray
    -- "Ph:" tail from the placeholder row.
    SELECT TOP 1
        id            = b.id,
        name          = CASE WHEN f.business_unit_id IS NOT NULL THEN f.display_name
                             ELSE NULLIF(LTRIM(RTRIM(b.BusinessUnitName)), N'') END,
        address       = CASE WHEN f.business_unit_id IS NOT NULL THEN f.address
                             ELSE NULLIF(LTRIM(RTRIM(b.address)), N'') END,
        city          = CASE WHEN f.business_unit_id IS NOT NULL THEN f.city
                             ELSE NULLIF(LTRIM(RTRIM(b.city)), N'') END,
        phone         = CASE WHEN f.business_unit_id IS NOT NULL THEN f.phone
                             ELSE NULLIF(LTRIM(RTRIM(b.phone)), N'') END,
        accreditation = f.accreditation
    FROM dbo.tbl_med_business_unit_master b
    LEFT JOIN dbo.inf_business_unit_footer f ON f.business_unit_id = b.id
    WHERE b.id = @businessUnitId;

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
    -- ord carries the print order through to the final SELECT.
    --
    -- COLLATE DATABASE_DEFAULT is not decoration. A temp table takes TEMPDB's
    -- collation, not this database's, and Noble is Latin1_General_CI_AI against
    -- a tempdb of SQL_Latin1_General_CP1_CI_AS. Comparing this column to a Noble
    -- column then fails with "Cannot resolve the collation conflict".
    CREATE TABLE #signers (
        ord          INT IDENTITY(1,1),
        id           INT,
        doctor_name  NVARCHAR(200) COLLATE DATABASE_DEFAULT,
        designation  NVARCHAR(200) COLLATE DATABASE_DEFAULT,
        doc_type     INT,
        signature    VARBINARY(MAX)
    );

    /*
     * ── SIGNATORY SELECTION: A FAITHFUL PORT OF THE LIS ───────────────────
     *
     * The old rule printed EVERY unit signatory not tied to a department — and
     * most units tie none — so a unit with two DOC_TYPE=1 doctors and one
     * DOC_TYPE=2 printed all THREE (the extra-third-signature bug: a head-office
     * pathologist beside the unit's own consultant pathologist and
     * microbiologist). It also mapped via tbl_med_department_master.Fist_doctor/
     * Second_doctor, which are unset for most units.
     *
     * This resolves the PRIMARY and SECONDARY signatory exactly as the LIS's own
     * report proc GET_PATIENT_REPORT_VAIL_ID does — the CASE expressions below
     * are a direct transcription of its Expr1/Expr2/Expr3 (primary) and
     * Doctorname/Designation/Signature (secondary) output columns, evaluated per
     * result row and then taken distinct:
     *
     *   PRIMARY:   the unit's DOC_TYPE=1 signatory whose department_id matches
     *              the test's department; else the unit's first DOC_TYPE=1; else
     *              the department's Department_View_Sign primary (Expr1..3).
     *              Head office (sample business_unit_id = 1) always uses the view.
     *   SECONDARY: the unit's DOC_TYPE=2 signatory; else the department's
     *              Department_View_Sign secondary. Dropped for the LIS's
     *              microbiology case (dept 4 with its own DOC_TYPE=1) and unit 19.
     *
     * Keeping it byte-for-byte with the LIS is deliberate: a signature is a
     * compliance surface and the two systems must name the same doctors on the
     * same report. Verified against the LIS proc across a broad report sample.
     */
    ;WITH lis AS (
        SELECT
            bu_code = u.BusinessUnitCode,
            samp_bu = samp.business_unit_id,
            dept_id = m.DepartmentId,
            dvs_e1 = dv.Expr1, dvs_e2 = dv.Expr2, dvs_e3 = dv.Expr3,
            dvs_dn = dv.Doctorname, dvs_dg = dv.Designation, dvs_sig = dv.Signature
        FROM dbo.tbl_med_mcc_patient_test_result r
        JOIN dbo.tbl_med_test_master m ON m.id = r.testid
        JOIN dbo.tbl_med_mcc_patient_samples samp ON samp.vailid = r.vailid
        JOIN dbo.tbl_med_mcc_patient_master p ON p.id = r.patientid
        JOIN dbo.tbl_med_mcc_unit_master u ON u.id = p.mcc_code
        LEFT JOIN dbo.tbl_med_department_master dm ON dm.id = m.DepartmentId
        LEFT JOIN dbo.Department_View_Sign dv ON dv.id = dm.id
        WHERE r.vailid = @v AND r.auth = 1
    ),
    -- Primary (tier 1) and secondary (tier 2), each pulled as ONE row so a
    -- doctor's name, designation and signature always come from the SAME record.
    -- The LIS emits these as independent TOP-1 subqueries per column, which can
    -- pair one doctor's name with another's designation; taking a single row
    -- fixes that while resolving the same doctor the LIS names. UNION ALL, not
    -- UNION: the signature is varbinary(max) and cannot be a UNION operand, and
    -- the per-name dedup below collapses the duplicates the report's rows make.
    flat AS (
        -- PRIMARY (LIS Expr1/Expr2/Expr3): unit's department-matched DOC_TYPE=1,
        -- then any DOC_TYPE=1; head office (sample BU 1) and non-units use the
        -- department's Department_View_Sign primary.
        SELECT tier = 1, name = pr.nm, desig = pr.dg, sig = pr.sg
        FROM lis l
        OUTER APPLY (
            SELECT TOP 1 nm, dg, sg FROM (
                SELECT prio = 1, nm = s.Doctorname, dg = s.Designation, sg = s.Signature
                FROM dbo.tbl_med_signature_master s
                WHERE l.samp_bu <> 1 AND l.bu_code > 1 AND s.Business_Unit_id = l.bu_code
                  AND s.IsActive = 1 AND s.DOC_TYPE = 1 AND s.department_id = l.dept_id
                UNION ALL
                SELECT prio = 2, s.Doctorname, s.Designation, s.Signature
                FROM dbo.tbl_med_signature_master s
                WHERE l.samp_bu <> 1 AND l.bu_code > 1 AND s.Business_Unit_id = l.bu_code
                  AND s.IsActive = 1 AND s.DOC_TYPE = 1
                UNION ALL
                SELECT prio = 3, l.dvs_e1, l.dvs_e2, l.dvs_e3
            ) c ORDER BY prio
        ) pr
        UNION ALL
        -- SECONDARY (LIS Doctorname/Designation/Signature): unit's DOC_TYPE=2,
        -- else the department's Department_View_Sign secondary. Dropped for the
        -- microbiology case (dept 4 with its own DOC_TYPE=1) and for unit 19.
        SELECT tier = 2, sc.nm, sc.dg, sc.sg
        FROM lis l
        OUTER APPLY (
            SELECT TOP 1 nm, dg, sg FROM (
                SELECT prio = 1, nm = s.Doctorname, dg = s.Designation, sg = s.Signature
                FROM dbo.tbl_med_signature_master s
                WHERE l.bu_code > 1 AND s.Business_Unit_id = l.bu_code
                  AND s.IsActive = 1 AND s.DOC_TYPE = 2
                  AND NOT (l.dept_id = 4 AND EXISTS (
                      SELECT 1 FROM dbo.tbl_med_signature_master s2
                      WHERE s2.Business_Unit_id = l.bu_code AND s2.IsActive = 1
                        AND s2.DOC_TYPE = 1 AND s2.department_id = 4))
                UNION ALL
                SELECT prio = 2, l.dvs_dn, l.dvs_dg, l.dvs_sig
                WHERE l.bu_code <> 19
                  AND NOT (l.bu_code > 1 AND l.dept_id = 4 AND EXISTS (
                      SELECT 1 FROM dbo.tbl_med_signature_master s2
                      WHERE s2.Business_Unit_id = l.bu_code AND s2.IsActive = 1
                        AND s2.DOC_TYPE = 1 AND s2.department_id = 4))
                  AND NOT (l.bu_code > 1 AND EXISTS (
                      SELECT 1 FROM dbo.tbl_med_signature_master s3
                      WHERE s3.Business_Unit_id = l.bu_code AND s3.IsActive = 1
                        AND s3.DOC_TYPE = 2))
            ) c ORDER BY prio
        ) sc
    ),
    usable AS (
        SELECT tier, name = NULLIF(LTRIM(RTRIM(name)), N''), desig, sig
        FROM flat
        WHERE NULLIF(LTRIM(RTRIM(name)), N'') IS NOT NULL
          AND sig IS NOT NULL AND DATALENGTH(sig) > 0
    ),
    -- One row per person; the same doctor is the default for several departments.
    deduped AS (
        SELECT *, rn = ROW_NUMBER() OVER (
            PARTITION BY LOWER(REPLACE(REPLACE(REPLACE(REPLACE(
                CASE WHEN name LIKE N'Dr.%' THEN LTRIM(SUBSTRING(name, 4, 200))
                     WHEN name LIKE N'Dr %'  THEN LTRIM(SUBSTRING(name, 3, 200))
                     ELSE name END,
                N' ', N''), N'.', N''), N',', N''), N'-', N''))
            ORDER BY tier)
        FROM usable
    )
    INSERT INTO #signers (id, doctor_name, designation, doc_type, signature)
    SELECT TOP 3
        id = -ROW_NUMBER() OVER (ORDER BY tier, name),
        name, NULLIF(LTRIM(RTRIM(desig)), N''), doc_type = tier, sig
    FROM deduped
    WHERE rn = 1
    ORDER BY tier, name;

    SELECT id, doctor_name, designation, doc_type, signature
    FROM #signers
    ORDER BY ord;

    DROP TABLE #signers;

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
