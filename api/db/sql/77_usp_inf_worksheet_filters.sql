/* QUOTED_IDENTIFIER is baked in at creation time; see script 70. */
SET QUOTED_IDENTIFIER ON;
GO
/*
 * 77_usp_inf_worksheet_filters.sql
 *
 * The option lists behind the worklist's dropdowns: departments, business
 * units, and the client codes this user may actually filter by.
 *
 * Three result sets in one round trip, because the worklist screen needs all
 * three the moment it mounts and three separate requests would be three
 * connections on a shared production server for no benefit.
 *
 * ── THE CLIENT CODE LIST IS SCOPED ─────────────────────────────────────────
 * Departments and business units are lab reference data — knowing that a
 * HEMATOLOGY department exists reveals nothing about a patient. Client codes
 * are different: the list of centres is the list of the lab's customers, and a
 * user restricted to two centres should not be handed a dropdown naming all
 * 3,588. So the codes come from the caller's own scope, passed in as a TVP by
 * the endpoint that already resolved it.
 *
 * An empty TVP means unrestricted (the same convention as the worklist
 * procedure), and only then is the full list returned.
 */
CREATE OR ALTER PROCEDURE dbo.usp_inf_worksheet_filters
    @client_codes dbo.ClientCodeList READONLY
AS
BEGIN
    SET NOCOUNT ON;
    SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;

    DECLARE @codeCount INT = (SELECT COUNT(*) FROM @client_codes);

    -- ---- 1. departments ----------------------------------------------------
    SELECT d.id, d.Name AS name
    FROM dbo.tbl_med_department_master d
    WHERE ISNULL(d.IsActive, 1) = 1
      AND d.Name IS NOT NULL AND LTRIM(RTRIM(d.Name)) <> ''
    ORDER BY d.Name;

    -- ---- 2. business units -------------------------------------------------
    SELECT b.id, b.BusinessUnitCode AS name
    FROM dbo.tbl_med_business_unit_master b
    WHERE b.BusinessUnitCode IS NOT NULL AND LTRIM(RTRIM(b.BusinessUnitCode)) <> ''
    ORDER BY b.BusinessUnitCode;

    -- ---- 3. client codes, within scope -------------------------------------
    -- The numeric id comes back too: the worklist filters by CODE, but pricing
    -- and order entry key on the id, and one picker serves all three.
    --
    -- is_active is returned rather than filtered on. A deactivated client still
    -- has historical samples worth filtering a worklist by; what it cannot do
    -- is take a NEW order (usp_telo_create_order refuses it). Order entry hides
    -- them, the worklist does not.
    SELECT u.id, u.MCCUnitCode AS code, u.MCCUnitName AS name,
           is_active = CAST(CASE WHEN ISNULL(u.IsActive, 0) = 1 THEN 1 ELSE 0 END AS BIT)
    FROM dbo.tbl_med_mcc_unit_master u
    WHERE u.MCCUnitCode IS NOT NULL AND LTRIM(RTRIM(u.MCCUnitCode)) <> ''
      AND (@codeCount = 0 OR EXISTS (SELECT 1 FROM @client_codes c WHERE c.code = u.MCCUnitCode))
    ORDER BY u.MCCUnitCode;
    /* ---- 4. tests, for the test-code filter ------------------------------
     * The worksheet's test-code box used to be free text, so it only helped
     * someone who already knew the code. 1,821 active tests is small enough to
     * hand over once and filter in the browser, which is what makes typing
     * "thyroid" find HE011 rather than needing the code up front.
     *
     * Reference data, so not scoped by client code — every centre orders from
     * the same catalogue. Inactive tests are excluded: they cannot be ordered,
     * but history that already carries them is still reachable by typing the
     * code, because the filter matches the sample's stored codes rather than
     * this list.
     */
    SELECT t.TestCode AS code, t.Testname AS name
    FROM dbo.tbl_med_test_master t
    WHERE ISNULL(t.IsActive, 1) = 1
      AND ISNULL(t.TestCode, '') <> ''
    ORDER BY t.Testname;

END
GO
