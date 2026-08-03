/*
 * 30_usp_inf_admin_list_users.sql
 *
 * Admin-panel user list. Returns every LIS user with the Infinity-side state
 * layered on, so one screen can show all three populations and make the
 * management boundary obvious rather than surprising the admin with a refusal
 * after they click.
 *
 * `managed_by` is the column the UI should key on:
 *   'infinity' -> Infinity created it; all admin actions are available.
 *   'telo'     -> Telo owns its LIS gate; show it read-only with an explanation.
 *   'lis'      -> a native LIS account; only role assignment is available.
 *
 * Paged, and searchable by username / name / email. @search is applied with a
 * leading wildcard, which cannot use an index — acceptable for an admin screen
 * over a few thousand users, but do not reuse this pattern on a hot path.
 */
CREATE OR ALTER PROCEDURE dbo.usp_inf_admin_list_users
    @search   NVARCHAR(100) = NULL,
    @page     INT = 1,
    @pageSize INT = 50
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @size INT = CASE WHEN @pageSize BETWEEN 1 AND 200 THEN @pageSize ELSE 50 END;
    DECLARE @skip INT = (CASE WHEN @page > 0 THEN @page ELSE 1 END - 1) * @size;
    DECLARE @q NVARCHAR(102) = CASE
        WHEN @search IS NULL OR LTRIM(RTRIM(@search)) = N'' THEN NULL
        ELSE N'%' + LTRIM(RTRIM(@search)) + N'%'
    END;

    SELECT
        u.id                AS user_id,
        u.Username          AS username,
        u.firstname         AS first_name,
        u.lastname          AS last_name,
        u.Email             AS email,
        u.usertypeid        AS usertype_id,
        ut.Name             AS usertype_name,
        CAST(ISNULL(u.IsActive, 0) AS BIT) AS lis_is_active,

        CASE
            WHEN ia.user_id IS NOT NULL THEN 'infinity'
            WHEN ta.user_id IS NOT NULL THEN 'telo'
            ELSE 'lis'
        END                 AS managed_by,

        -- NULL for accounts Infinity does not manage: the UI should render an
        -- em dash, not a misleading "disabled".
        ia.inf_active       AS infinity_active,
        ia.lis_access       AS infinity_lis_access,

        ur.role             AS infinity_role,
        CAST(ISNULL(sv.version, 0) AS INT) AS session_version,
        ia.created_at       AS infinity_created_at,

        COUNT(*) OVER()     AS total_count

    FROM dbo.tbl_med_user_master u
    LEFT JOIN dbo.tbl_med_usertypes ut          ON ut.id = u.usertypeid
    LEFT JOIN dbo.inf_account ia                ON ia.user_id = u.id
    LEFT JOIN dbo.telo_account ta               ON ta.user_id = u.id
    LEFT JOIN dbo.inf_user_role ur              ON ur.user_id = u.id
    LEFT JOIN dbo.inf_user_session_version sv   ON sv.user_id = u.id
    WHERE @q IS NULL
       OR u.Username  LIKE @q
       OR u.firstname LIKE @q
       OR u.lastname  LIKE @q
       OR u.Email     LIKE @q
    ORDER BY
        -- Infinity's own accounts first: they are what this screen manages.
        CASE WHEN ia.user_id IS NOT NULL THEN 0 ELSE 1 END,
        u.Username
    OFFSET @skip ROWS FETCH NEXT @size ROWS ONLY;
END
GO
