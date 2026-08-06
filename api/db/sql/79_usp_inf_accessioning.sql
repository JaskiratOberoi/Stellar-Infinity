/* QUOTED_IDENTIFIER is baked in at creation time; see script 70. */
SET QUOTED_IDENTIFIER ON;
GO
/*
 * 79_usp_inf_accessioning.sql
 *
 * The two worklists between an order and the bench.
 *
 * An order does not reach a worksheet the moment it is booked. It passes
 * through two stages, and until both are done the sample is invisible to the
 * lab:
 *
 *   1. AWAITING SAMPLE IDs   the order exists and its tests are known, but no
 *                            barcode has been attached to a tube yet. There is
 *                            no sample row at all.
 *   2. AWAITING ACCESSIONING the barcode exists and the sample row is at
 *                            status 1 (Sample Sent). The worksheet procedure
 *                            excludes sample_status <= 1, so it is still not on
 *                            anyone's bench list.
 *
 * Registering the sample moves it to 2 (Sample Registered) and it appears.
 *
 * ── BOTH PLATFORMS' ORDERS, DELIBERATELY ───────────────────────────────────
 * Telo's equivalent reads filter `b.addedby LIKE 'telo:%'`. Copying that here
 * would give Infinity a queue containing only Infinity's own orders, and Telo a
 * queue containing only Telo's — so an order booked on one platform would never
 * be accessioned by someone working in the other, and its sample would sit
 * unbarcoded indefinitely with nothing anywhere reporting it as stuck.
 *
 * The lab is one lab. These match telo: OR inf:, exactly like the mobile
 * allowance in usp_telo_create_order. Native LIS orders are still excluded —
 * they are accessioned in the LIS itself and are not this queue's business.
 *
 * NOTE: the converse change on Telo's side has NOT been made. Telo's queues
 * still show only telo: orders, so an Infinity-booked order is currently
 * invisible there. Fixing that is a one-line change to the two queries in
 * telo-web/db/read/orders.ts and should happen before anyone books real work
 * in Infinity while still accessioning in Telo.
 */

-- ---------------------------------------------------------------- awaiting SIDs --
CREATE OR ALTER PROCEDURE dbo.usp_inf_pending_accessions
    @client_codes dbo.ClientCodeList READONLY,
    @page         INT = 1,
    @page_size    INT = 100
AS
BEGIN
    SET NOCOUNT ON;
    SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;

    DECLARE @pageSafe INT = CASE WHEN @page < 1 THEN 1 ELSE @page END;
    DECLARE @size INT =
        CASE WHEN @page_size < 1 THEN 100
             WHEN @page_size > 1000 THEN 1000
             ELSE @page_size END;
    DECLARE @offset INT = (@pageSafe - 1) * @size;

    DECLARE @codeCount INT = (SELECT COUNT(*) FROM @client_codes);

    ;WITH ours AS (
        SELECT b.id AS billId, b.bill_number AS billNumber, b.bill_date AS billDate,
               TRY_CONVERT(INT, b.medid) AS patientId,
               b.patientname AS patientName, b.mcc_code AS mccCode,
               u.MCCUnitCode AS clientCode,
               b.amount AS total, b.Balance AS balance,
               -- Which platform booked it. Shown in the UI so an operator
               -- accessioning a queue that spans both can tell them apart.
               origin = CASE WHEN b.addedby LIKE 'inf:%' THEN 'infinity' ELSE 'telo' END
        FROM dbo.tbl_billing_patient_detail b
        LEFT JOIN dbo.tbl_med_mcc_unit_master u ON u.id = b.mcc_code
        WHERE (b.addedby LIKE 'telo:%' OR b.addedby LIKE 'inf:%')
          AND TRY_CONVERT(INT, b.medid) IS NOT NULL
          AND (@codeCount = 0
               OR EXISTS (SELECT 1 FROM @client_codes c WHERE c.code = u.MCCUnitCode))
    )
    SELECT o.billId, o.billNumber, o.billDate, o.patientId, o.patientName,
           o.mccCode, o.clientCode, o.total, o.balance, o.origin,
           req.requiredGroups,
           haveGroups = ISNULL(h.haveGroups, 0),
           COUNT(*) OVER() AS total_count
    FROM ours o
    -- How many distinct tubes the order needs, resolved through profiles and
    -- master profiles down to the tests that actually have a sample type.
    CROSS APPLY (
        SELECT COUNT(DISTINCT x.sampleTypeId) AS requiredGroups
        FROM (
            -- Direct tests. test_type is 'Test'/'Profile'/'Master' on newer
            -- orders and 'p'/'t' on older ones, so both spellings are handled.
            SELECT ISNULL(tm.SampleId, -1) AS sampleTypeId
            FROM dbo.tbl_med_mcc_patient_tests pt
            JOIN dbo.tbl_med_test_master tm ON tm.id = pt.test_id AND tm.IsActive = 1
            WHERE pt.patient_id = o.patientId
              AND pt.test_type NOT IN ('p', 'Profile', 'Master')

            UNION ALL

            -- Profiles -> their constituent tests
            SELECT ISNULL(tm.SampleId, -1)
            FROM dbo.tbl_med_mcc_patient_tests pt
            JOIN dbo.tbl_med_test_profile_param pp ON pp.profileid = pt.test_id
            JOIN dbo.tbl_med_test_master tm ON tm.id = pp.testid AND tm.IsActive = 1
            WHERE pt.patient_id = o.patientId
              AND pt.test_type IN ('p', 'Profile')

            UNION ALL

            -- Master profiles -> child tests
            SELECT ISNULL(tm.SampleId, -1)
            FROM dbo.tbl_med_mcc_patient_tests pt
            JOIN dbo.tbl_med_test_master_test_param mtp ON mtp.master_profileid = pt.test_id
            JOIN dbo.tbl_med_test_master tm ON tm.id = mtp.testid AND tm.IsActive = 1
            WHERE pt.patient_id = o.patientId
              AND pt.test_type = 'Master'

            UNION ALL

            -- Master profiles -> child profiles -> their constituent tests
            SELECT ISNULL(tm.SampleId, -1)
            FROM dbo.tbl_med_mcc_patient_tests pt
            JOIN dbo.tbl_med_test_master_profile_param mpp ON mpp.master_profileid = pt.test_id
            JOIN dbo.tbl_med_test_profile_param pp ON pp.profileid = mpp.profileid
            JOIN dbo.tbl_med_test_master tm ON tm.id = pp.testid AND tm.IsActive = 1
            WHERE pt.patient_id = o.patientId
              AND pt.test_type = 'Master'
        ) x
    ) req
    OUTER APPLY (
        SELECT COUNT(*) AS haveGroups
        FROM dbo.tbl_med_mcc_patient_samples s
        WHERE s.patient_id = o.patientId
    ) h
    -- Still short of at least one tube.
    WHERE req.requiredGroups > ISNULL(h.haveGroups, 0)
    ORDER BY o.billId DESC
    OFFSET @offset ROWS FETCH NEXT @size ROWS ONLY;
END
GO

-- ------------------------------------------------ tubes ONE order still needs --
/*
 * The tube breakdown for an existing order, for the barcode form.
 *
 * Distinct from the cart preview, which answers "what would this BASKET need"
 * for the current user. Here the order already exists and its tests are rows in
 * tbl_med_mcc_patient_tests, so the question is what THIS patient needs and
 * which tubes already have a barcode. Using the cart preview would have shown
 * the operator whatever happened to be in their own basket.
 */
CREATE OR ALTER PROCEDURE dbo.usp_inf_order_tubes
    @patient_id INT
AS
BEGIN
    SET NOCOUNT ON;
    SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;

    ;WITH required AS (
        SELECT DISTINCT sampleTypeId = ISNULL(tm.SampleId, -1)
        FROM dbo.tbl_med_mcc_patient_tests pt
        JOIN dbo.tbl_med_test_master tm ON tm.id = pt.test_id AND tm.IsActive = 1
        WHERE pt.patient_id = @patient_id
          AND pt.test_type NOT IN ('p', 'Profile', 'Master')

        UNION

        SELECT DISTINCT ISNULL(tm.SampleId, -1)
        FROM dbo.tbl_med_mcc_patient_tests pt
        JOIN dbo.tbl_med_test_profile_param pp ON pp.profileid = pt.test_id
        JOIN dbo.tbl_med_test_master tm ON tm.id = pp.testid AND tm.IsActive = 1
        WHERE pt.patient_id = @patient_id
          AND pt.test_type IN ('p', 'Profile')

        UNION

        SELECT DISTINCT ISNULL(tm.SampleId, -1)
        FROM dbo.tbl_med_mcc_patient_tests pt
        JOIN dbo.tbl_med_test_master_test_param mtp ON mtp.master_profileid = pt.test_id
        JOIN dbo.tbl_med_test_master tm ON tm.id = mtp.testid AND tm.IsActive = 1
        WHERE pt.patient_id = @patient_id
          AND pt.test_type = 'Master'

        UNION

        SELECT DISTINCT ISNULL(tm.SampleId, -1)
        FROM dbo.tbl_med_mcc_patient_tests pt
        JOIN dbo.tbl_med_test_master_profile_param mpp ON mpp.master_profileid = pt.test_id
        JOIN dbo.tbl_med_test_profile_param pp ON pp.profileid = mpp.profileid
        JOIN dbo.tbl_med_test_master tm ON tm.id = pp.testid AND tm.IsActive = 1
        WHERE pt.patient_id = @patient_id
          AND pt.test_type = 'Master'
    )
    SELECT
        r.sampleTypeId,
        sampleTypeName = ISNULL(sm.Sampletype, 'Unspecified'),
        -- What the tube is for, so the operator can tell two barcodes apart.
        testNames = STUFF((
            SELECT ', ' + LTRIM(RTRIM(t2.Testname))
            FROM dbo.tbl_med_mcc_patient_tests pt2
            JOIN dbo.tbl_med_test_master t2 ON t2.id = pt2.test_id
            WHERE pt2.patient_id = @patient_id
              AND ISNULL(t2.SampleId, -1) = r.sampleTypeId
            FOR XML PATH(''), TYPE).value('.', 'NVARCHAR(MAX)'), 1, 2, ''),
        -- Already barcoded? The form must not offer a second label for a tube
        -- that has one; the procedure would reject it anyway.
        existingVailid = (
            SELECT TOP 1 s.vailid
            FROM dbo.tbl_med_mcc_patient_samples s
            WHERE s.patient_id = @patient_id AND ISNULL(s.sampleid, -1) = r.sampleTypeId)
    FROM required r
    LEFT JOIN dbo.tbl_med_sample_master sm ON sm.id = r.sampleTypeId
    ORDER BY sampleTypeName;
END
GO

-- ------------------------------------------------------- awaiting accessioning --
CREATE OR ALTER PROCEDURE dbo.usp_inf_pending_registrations
    @client_codes dbo.ClientCodeList READONLY,
    @page         INT = 1,
    @page_size    INT = 100
AS
BEGIN
    SET NOCOUNT ON;
    SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;

    DECLARE @pageSafe INT = CASE WHEN @page < 1 THEN 1 ELSE @page END;
    DECLARE @size INT =
        CASE WHEN @page_size < 1 THEN 100
             WHEN @page_size > 1000 THEN 1000
             ELSE @page_size END;
    DECLARE @offset INT = (@pageSafe - 1) * @size;

    DECLARE @codeCount INT = (SELECT COUNT(*) FROM @client_codes);

    SELECT
        s.id            AS sampleId,
        s.vailid        AS vailid,
        s.patient_id    AS patientId,
        p.name          AS patientName,
        p.mcc_code      AS mccCode,
        u.MCCUnitCode   AS clientCode,
        s.sample_status AS sampleStatus,
        -- The tube type. Column is `sampleid` on the sample row and
        -- `Sampletype` on the master — neither name matches the other, and
        -- neither matches what Telo's TypeScript calls them.
        st.Sampletype   AS sampleTypeName,
        s.testnames     AS testNames,
        s.addeddate     AS addedAt,
        origin = CASE WHEN s.addedby LIKE 'inf:%' THEN 'infinity' ELSE 'telo' END,
        COUNT(*) OVER() AS total_count
    FROM dbo.tbl_med_mcc_patient_samples s
    JOIN dbo.tbl_med_mcc_patient_master p ON p.id = s.patient_id
    LEFT JOIN dbo.tbl_med_mcc_unit_master u ON u.id = p.mcc_code
    LEFT JOIN dbo.tbl_med_sample_master st ON st.id = s.sampleid
    -- Status 1 is Sample Sent: the barcode exists, the LIS has not received it,
    -- and the worksheet excludes it. This queue is exactly that gap.
    WHERE s.sample_status = 1
      AND (s.addedby LIKE 'telo:%' OR s.addedby LIKE 'inf:%')
      AND (@codeCount = 0
           OR EXISTS (SELECT 1 FROM @client_codes c WHERE c.code = u.MCCUnitCode))
    ORDER BY s.id DESC
    OFFSET @offset ROWS FETCH NEXT @size ROWS ONLY;
END
GO
