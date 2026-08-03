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
    @userId INT,
    @search NVARCHAR(100) = NULL,
    @top    INT = 50
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @n INT = CASE WHEN @top BETWEEN 1 AND 200 THEN @top ELSE 50 END;
    DECLARE @q NVARCHAR(102) = CASE
        WHEN @search IS NULL OR LTRIM(RTRIM(@search)) = N'' THEN NULL
        ELSE N'%' + LTRIM(RTRIM(@search)) + N'%'
    END;

    SELECT TOP (@n)
        c.id            AS mcc_id,
        c.MCCUnitCode   AS client_code,
        c.MCCUnitName   AS client_name,
        CAST(CASE WHEN m.user_id IS NULL THEN 0 ELSE 1 END AS BIT) AS already_mapped
    FROM dbo.tbl_med_mcc_unit_master c
    LEFT JOIN dbo.tbl_med_user_sales_mcc_mapping m
           ON m.mcc_code = c.id AND m.user_id = @userId
    WHERE c.MCCUnitCode IS NOT NULL
      AND LTRIM(RTRIM(c.MCCUnitCode)) <> ''
      AND (@q IS NULL OR c.MCCUnitCode LIKE @q OR c.MCCUnitName LIKE @q)
    -- Already-granted codes first so an admin can see current access at a glance.
    ORDER BY CASE WHEN m.user_id IS NULL THEN 1 ELSE 0 END, c.MCCUnitCode;
END
GO
