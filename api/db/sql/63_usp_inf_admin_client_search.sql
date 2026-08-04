/*
 * 63_usp_inf_admin_client_search.sql
 *
 * Client-code picker for the admin panel: search the centre master, marking
 * which codes the user already has.
 *
 * Deliberately no IsActive filter. That bit is not a liveness flag for client
 * codes and the LIS itself ignores it — filtering on it kept roughly 1,700 live
 * codes out of Telo's pickers, so an admin could not grant access to centres
 * that were plainly operating. Same reasoning as ScopeRepository.
 */
CREATE OR ALTER PROCEDURE dbo.usp_inf_admin_client_search
    @userId    INT,
    @search    NVARCHAR(100) = NULL,
    @page      INT = 1,
    @page_size INT = 50
AS
BEGIN
    SET NOCOUNT ON;

    -- Paged, with the match count returned. A code the administrator needs to
    -- grant must be reachable; "search harder" is not an acceptable answer when
    -- the code they want is the 51st match and nothing says so.
    DECLARE @pageSafe INT = CASE WHEN @page < 1 THEN 1 ELSE @page END;
    DECLARE @n INT =
        CASE WHEN @page_size < 1 THEN 50
             WHEN @page_size > 500 THEN 500
             ELSE @page_size END;
    DECLARE @offset INT = (@pageSafe - 1) * @n;

    DECLARE @q NVARCHAR(102) = CASE
        WHEN @search IS NULL OR LTRIM(RTRIM(@search)) = N'' THEN NULL
        ELSE N'%' + LTRIM(RTRIM(@search)) + N'%'
    END;

    SELECT
        c.id            AS mcc_id,
        c.MCCUnitCode   AS client_code,
        c.MCCUnitName   AS client_name,
        CAST(CASE WHEN m.user_id IS NULL THEN 0 ELSE 1 END AS BIT) AS already_mapped,
        COUNT(*) OVER() AS total_count
    FROM dbo.tbl_med_mcc_unit_master c
    LEFT JOIN dbo.tbl_med_user_sales_mcc_mapping m
           ON m.mcc_code = c.id AND m.user_id = @userId
    WHERE c.MCCUnitCode IS NOT NULL
      AND LTRIM(RTRIM(c.MCCUnitCode)) <> ''
      AND (@q IS NULL OR c.MCCUnitCode LIKE @q OR c.MCCUnitName LIKE @q)
    -- Already-granted codes first so an admin can see current access at a glance.
    -- c.id breaks ties on duplicate codes, without which paging could repeat one
    -- centre and hide another.
    ORDER BY CASE WHEN m.user_id IS NULL THEN 1 ELSE 0 END, c.MCCUnitCode, c.id
    OFFSET @offset ROWS FETCH NEXT @n ROWS ONLY;
END
GO
