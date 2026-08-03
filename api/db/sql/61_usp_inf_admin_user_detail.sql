/*
 * 61_usp_inf_admin_user_detail.sql
 *
 * Everything the admin panel needs about ONE user, in a single round trip:
 * the account, its Infinity flags, and the client codes it can reach.
 *
 * Returns three result sets:
 *   1. the account
 *   2. the client codes currently mapped to it (tbl_med_user_sales_mcc_mapping)
 *   3. its own centre(s) from PCC_Id / sub_pcc_id
 *
 * Result set 3 matters and is easy to miss: a user's effective scope is the
 * UNION of their explicit mappings and their own centre. An admin looking only
 * at set 2 would conclude a client user has no access at all, then "fix" it by
 * adding a mapping that was never needed. Showing both, separately, makes the
 * real scope legible.
 */
CREATE OR ALTER PROCEDURE dbo.usp_inf_admin_user_detail
    @userId INT
AS
BEGIN
    SET NOCOUNT ON;

    -- 1. the account
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
        CAST(ISNULL(u.IsActive, 0) AS BIT) AS lis_is_active,
        CASE WHEN ia.user_id IS NOT NULL THEN 'infinity'
             WHEN ta.user_id IS NOT NULL THEN 'telo'
             ELSE 'lis' END AS managed_by,
        ia.inf_active       AS infinity_active,
        ia.lis_access       AS infinity_lis_access,
        ur.role             AS infinity_role,
        CAST(ISNULL(sv.version, 0) AS INT) AS session_version,
        -- Legacy per-usertype security bits, shown read-only so an admin can see
        -- what the LIS itself will let this account do.
        CAST(ISNULL(sa.Auth, 0)             AS BIT) AS lis_cap_auth,
        CAST(ISNULL(sa.Result_Entry, 0)     AS BIT) AS lis_cap_result_entry,
        CAST(ISNULL(sa.EditPatientTests, 0) AS BIT) AS lis_cap_edit_tests,
        CAST(ISNULL(sa.Discount, 0)         AS BIT) AS lis_cap_discount
    FROM dbo.tbl_med_user_master u
    LEFT JOIN dbo.tbl_med_usertypes ut               ON ut.id = u.usertypeid
    LEFT JOIN dbo.tbl_med_mcc_user_security_auth sa  ON sa.user_type = u.usertypeid
    LEFT JOIN dbo.inf_account ia                     ON ia.user_id = u.id
    LEFT JOIN dbo.telo_account ta                    ON ta.user_id = u.id
    LEFT JOIN dbo.inf_user_role ur                   ON ur.user_id = u.id
    LEFT JOIN dbo.inf_user_session_version sv        ON sv.user_id = u.id
    WHERE u.id = @userId;

    -- 2. explicitly mapped client codes
    SELECT
        m.mcc_code          AS mcc_id,
        c.MCCUnitCode       AS client_code,
        c.MCCUnitName       AS client_name,
        m.addedby           AS added_by,
        m.addeddate         AS added_at,
        -- So the UI can warn before removing a mapping Infinity did not create.
        CAST(CASE WHEN m.addedby LIKE 'inf:%' THEN 1 ELSE 0 END AS BIT) AS added_by_infinity
    FROM dbo.tbl_med_user_sales_mcc_mapping m
    LEFT JOIN dbo.tbl_med_mcc_unit_master c ON c.id = m.mcc_code
    WHERE m.user_id = @userId
    ORDER BY c.MCCUnitCode;

    -- 3. the user's own centre(s) — implicit scope, not stored as a mapping
    SELECT DISTINCT
        c.id            AS mcc_id,
        c.MCCUnitCode   AS client_code,
        c.MCCUnitName   AS client_name,
        CASE WHEN c.id = u.PCC_Id THEN 'PCC_Id' ELSE 'sub_pcc_id' END AS source
    FROM dbo.tbl_med_user_master u
    JOIN dbo.tbl_med_mcc_unit_master c
      ON c.id IN (NULLIF(u.PCC_Id, 0), NULLIF(u.sub_pcc_id, 0))
    WHERE u.id = @userId;
END
GO
