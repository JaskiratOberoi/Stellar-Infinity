/*
 * 10_usp_inf_authenticate.sql
 *
 * Read-only credential check for Infinity. Returns exactly one row on success,
 * zero rows on failure.
 *
 * Passwords in Noble are PLAINTEXT (a pre-existing, stakeholder-accepted risk
 * inherited from the legacy LIS). The comparison uses a typed SQL parameter, so
 * this is not a SQL-injection vector — but it does mean a database read exposes
 * every credential, and Infinity must never log @Password.
 *
 * ---------------------------------------------------------------------------
 * THREE POPULATIONS, THREE GATES
 *
 * Noble's user table is shared by three kinds of account, and each has its own
 * notion of "is this login allowed". Telo only had to distinguish two; Infinity
 * arrives third and must not lock out either of the existing groups.
 *
 *  1. Infinity-managed  (dbo.inf_account row)
 *       -> gate on inf_account.inf_active
 *       IsActive is deliberately 0 for these until an admin grants LIS access,
 *       so the legacy LIS rejects them while Infinity admits them.
 *
 *  2. Telo-managed      (dbo.telo_account row, no inf_account row)
 *       -> gate on telo_account.telo_active
 *       These are real staff accounts that Telo created. Many have IsActive = 0
 *       precisely because Telo locked them out of the LIS. Gating them on
 *       IsActive would lock them out of Infinity too, for a reason that has
 *       nothing to do with Infinity. Gate on Telo's own active flag instead, so
 *       a user disabled in Telo is also denied here.
 *
 *  3. Native LIS user   (neither sidecar row)
 *       -> gate on tbl_med_user_master.IsActive, the legacy rule, unchanged.
 *       This is what lets every existing LIS user sign in to Infinity with
 *       their original LIS credentials on day one, with no migration step.
 *
 * Note the asymmetry that satisfies the requirement "Infinity credentials must
 * not work on the LIS unless enabled": the LIS reads only IsActive, which for an
 * Infinity account stays 0 until dbo.usp_inf_admin_set_lis_access re-derives it.
 * ---------------------------------------------------------------------------
 *
 * MCC scope is deliberately NOT resolved here — it is thousands of mapping rows
 * and does not belong in the login round-trip. The API resolves and caches it
 * separately.
 */
CREATE OR ALTER PROCEDURE dbo.usp_inf_authenticate
    @Username NVARCHAR(50),
    @Password NVARCHAR(50)
AS
BEGIN
    SET NOCOUNT ON;

    SELECT
        u.id                AS user_id,
        u.Username          AS username,
        u.firstname         AS first_name,
        u.lastname          AS last_name,
        u.Email             AS email,
        u.usertypeid        AS usertype_id,
        ut.Name             AS usertype_name,
        u.PCC_Id            AS pcc_id,
        u.sub_pcc_id        AS sub_pcc_id,
        u.Business_Unit_id  AS business_unit_id,

        -- Explicit Infinity role, or NULL to let the API derive one from
        -- usertype_id. Kept out of the WHERE clause so a user is never locked
        -- out merely for lacking a role row.
        ur.role             AS infinity_role,

        -- Which system owns this account, so the API can shape the admin UI
        -- without a second query.
        CAST(CASE WHEN ia.user_id IS NOT NULL THEN 1 ELSE 0 END AS BIT) AS is_infinity_managed,
        CAST(CASE WHEN ta.user_id IS NOT NULL THEN 1 ELSE 0 END AS BIT) AS is_telo_managed,

        -- Effective LIS login state for this credential. For an Infinity account
        -- this is the admin-panel switch; for anyone else it is simply the LIS
        -- bit as it stands.
        CAST(ISNULL(ia.lis_access, u.IsActive) AS BIT) AS lis_access,

        -- Token revocation counter; 0 when the user has never been bumped.
        CAST(ISNULL(sv.version, 0) AS INT) AS session_version,

        -- Legacy LIS security bits. Infinity shapes capability from its own role
        -- model, but these are surfaced for screens that must mirror LIS rules.
        CAST(ISNULL(sa.Auth, 0)             AS BIT) AS cap_auth,
        CAST(ISNULL(sa.Discount, 0)         AS BIT) AS cap_discount,
        CAST(ISNULL(sa.EditPatientTests, 0) AS BIT) AS cap_edit_patient_tests,
        CAST(ISNULL(sa.Result_Entry, 0)     AS BIT) AS cap_result_entry,
        CAST(ISNULL(sa.patient_details, 0)  AS BIT) AS cap_patient_details

    FROM dbo.tbl_med_user_master u
    LEFT JOIN dbo.tbl_med_usertypes ut
        ON ut.id = u.usertypeid
    LEFT JOIN dbo.tbl_med_mcc_user_security_auth sa
        ON sa.user_type = u.usertypeid
    LEFT JOIN dbo.inf_account ia
        ON ia.user_id = u.id
    LEFT JOIN dbo.telo_account ta
        ON ta.user_id = u.id
    LEFT JOIN dbo.inf_user_role ur
        ON ur.user_id = u.id
    LEFT JOIN dbo.inf_user_session_version sv
        ON sv.user_id = u.id
    WHERE u.Username = @Username
      AND u.password = @Password
      AND (
            -- 1. Infinity-managed
            (ia.user_id IS NOT NULL AND ia.inf_active = 1)
            -- 2. Telo-managed, not claimed by Infinity
         OR (ia.user_id IS NULL AND ta.user_id IS NOT NULL AND ta.telo_active = 1)
            -- 3. Native LIS user
         OR (ia.user_id IS NULL AND ta.user_id IS NULL AND u.IsActive = 1)
          );
END
GO
