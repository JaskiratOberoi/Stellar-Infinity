/*
 * 22_usp_inf_admin_set_active.sql
 *
 * Enables/disables an account's INFINITY login.
 *
 * Infinity-managed accounts: toggles inf_active and re-derives
 * IsActive = (inf_active AND lis_access). Disabling therefore also revokes LIS
 * access; re-enabling restores whatever lis_access intent was previously set,
 * rather than silently granting it.
 *
 * Native LIS users (no inf_account row): REFUSED. Telo's equivalent quietly
 * toggled tbl_med_user_master.IsActive for these, which means "disable in Telo"
 * actually locked the person out of the LIS they use to do their job. Infinity
 * will not disable an account it does not own — deactivate it in the LIS, or
 * claim it into Infinity first.
 *
 * Telo-managed accounts: REFUSED for the shared-column reason documented in
 * 21_usp_inf_admin_set_lis_access.sql.
 *
 * Always bumps the session version so outstanding tokens die with the account.
 *
 * Returns { ok, error_code, message }.
 */
CREATE OR ALTER PROCEDURE dbo.usp_inf_admin_set_active
    @userId INT,
    @active BIT,
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

    IF NOT EXISTS (SELECT 1 FROM dbo.inf_account WHERE user_id = @userId)
    BEGIN
        SELECT ok = CAST(0 AS BIT), error_code = 'VALIDATION',
               message = N'Only Infinity-created accounts can be enabled or disabled here.';
        RETURN;
    END

    IF EXISTS (SELECT 1 FROM dbo.telo_account WHERE user_id = @userId)
    BEGIN
        SELECT ok = CAST(0 AS BIT), error_code = 'CONFLICT',
               message = N'This account is also managed by Telo. Change it in one system only.';
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

    /* An admin locking themselves out is an easy accident and an annoying
       recovery — it needs another Super Admin or direct SQL. */
    IF @userId = @actor AND @active = 0
    BEGIN
        SELECT ok = CAST(0 AS BIT), error_code = 'VALIDATION',
               message = N'You cannot disable your own account.';
        RETURN;
    END

    BEGIN TRY
        BEGIN TRAN;

        UPDATE dbo.inf_account
        SET inf_active = @active,
            updated_at = SYSDATETIME(),
            updated_by = @actor
        WHERE user_id = @userId;

        UPDATE u
        SET u.IsActive    = (a.inf_active & a.lis_access),
            u.updatedby   = CONCAT(N'inf:', @actor),
            u.updatedDate = GETDATE()
        FROM dbo.tbl_med_user_master u
        JOIN dbo.inf_account a ON a.user_id = u.id
        WHERE u.id = @userId;

        EXEC dbo.usp_inf_bump_session_version @userId = @userId, @reason = N'active changed';

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
