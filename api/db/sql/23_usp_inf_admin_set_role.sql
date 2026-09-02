/*
 * 23_usp_inf_admin_set_role.sql
 *
 * Assigns an Infinity role to ANY user — including native LIS users who have no
 * inf_account row. That is intentional and differs from the other admin procs:
 * giving an existing LIS user an Infinity role writes only to Infinity's own
 * table and changes nothing about their LIS access, so there is no shared-column
 * hazard and no reason to refuse.
 *
 * Upsert: one role per user (UQ_inf_user_role_user).
 *
 * Bumps the session version, because capabilities are baked into issued tokens
 * and a demotion must take effect without waiting for the token to expire.
 *
 * Returns { ok, error_code, message }.
 */
CREATE OR ALTER PROCEDURE dbo.usp_inf_admin_set_role
    @userId INT,
    @role   NVARCHAR(30),
    @actor  INT
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    IF NOT EXISTS (SELECT 1 FROM dbo.tbl_med_user_master WHERE id = @userId)
    BEGIN
        SELECT ok = CAST(0 AS BIT), error_code = 'NOT_FOUND',
               message = N'User not found';
        RETURN;
    END

    /* Keep in step with Auth/InfinityRoles.cs and SP 20 (create_user). */
    IF @role NOT IN (N'super_admin', N'admin', N'lab_manager',
                     N'technician', N'reporting', N'client',
                     N'client_b2c', N'client_reporting', N'sub_client', N'viewer')
    BEGIN
        SELECT ok = CAST(0 AS BIT), error_code = 'VALIDATION',
               message = N'Unknown Infinity role';
        RETURN;
    END

    /* Escalation guard, both directions: only an LIS Super Admin may grant
       super_admin, or modify someone who already holds the LIS Super Admin type. */
    IF @role = N'super_admin'
       AND NOT EXISTS (SELECT 1 FROM dbo.tbl_med_user_master
                       WHERE id = @actor AND usertypeid = 1)
    BEGIN
        SELECT ok = CAST(0 AS BIT), error_code = 'FORBIDDEN',
               message = N'Only an LIS Super Admin may grant the Super Admin role';
        RETURN;
    END

    IF EXISTS (SELECT 1 FROM dbo.tbl_med_user_master
               WHERE id = @userId AND usertypeid = 1)
       AND NOT EXISTS (SELECT 1 FROM dbo.tbl_med_user_master
                       WHERE id = @actor AND usertypeid = 1)
    BEGIN
        SELECT ok = CAST(0 AS BIT), error_code = 'FORBIDDEN',
               message = N'Only an LIS Super Admin may modify this user';
        RETURN;
    END

    /* Demoting yourself out of user:manage strands the panel. */
    IF @userId = @actor AND @role <> N'super_admin' AND @role <> N'admin'
    BEGIN
        SELECT ok = CAST(0 AS BIT), error_code = 'VALIDATION',
               message = N'You cannot remove your own administrative role.';
        RETURN;
    END

    BEGIN TRY
        BEGIN TRAN;

        MERGE dbo.inf_user_role AS t
        USING (SELECT @userId AS user_id) AS s
            ON t.user_id = s.user_id
        WHEN MATCHED THEN
            UPDATE SET role = @role, assigned_by = @actor, assigned_at = SYSDATETIME()
        WHEN NOT MATCHED THEN
            INSERT (user_id, role, assigned_by) VALUES (@userId, @role, @actor);

        EXEC dbo.usp_inf_bump_session_version @userId = @userId, @reason = N'role changed';

        COMMIT;

        SELECT ok = CAST(1 AS BIT), error_code = CAST(NULL AS VARCHAR(20)),
               message = CAST(NULL AS NVARCHAR(200));
    END TRY
    BEGIN CATCH
        IF @@TRANCOUNT > 0 ROLLBACK;
        SELECT ok = CAST(0 AS BIT), error_code = 'INTERNAL',
               message = LEFT(ERROR_MESSAGE(), 200);
    END CATCH
END
GO
