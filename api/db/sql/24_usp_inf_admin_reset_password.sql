/*
 * 24_usp_inf_admin_reset_password.sql
 *
 * Resets the password on ANY account — Infinity is standing in for the LIS's
 * own admin, so an admin resetting a password here is setting THE credential,
 * the one that also works on the legacy LIS. That shared-column effect used to
 * be the reason to refuse native LIS accounts; under the replacement plan it is
 * the point. Native LIS accounts are now allowed.
 *
 * Telo-managed accounts are still refused: two systems writing one credential
 * is a genuine conflict, not a feature, so that credential is changed in one
 * place. The Super-Admin-only-touches-Super-Admin guard also stays.
 *
 * Bumps the session version, so every token issued under the old password dies
 * immediately. Without this a compromised session survives the reset that was
 * meant to end it.
 *
 * Returns { ok, error_code, message }.
 */
CREATE OR ALTER PROCEDURE dbo.usp_inf_admin_reset_password
    @userId   INT,
    @password NVARCHAR(50),
    @actor    INT
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    IF @password IS NULL OR LTRIM(RTRIM(@password)) = N''
    BEGIN
        SELECT ok = CAST(0 AS BIT), error_code = 'VALIDATION',
               message = N'Password is required';
        RETURN;
    END

    IF NOT EXISTS (SELECT 1 FROM dbo.tbl_med_user_master WHERE id = @userId)
    BEGIN
        SELECT ok = CAST(0 AS BIT), error_code = 'NOT_FOUND',
               message = N'User not found';
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

    BEGIN TRY
        BEGIN TRAN;

        UPDATE dbo.tbl_med_user_master
        SET password    = @password,
            updatedby   = CONCAT(N'inf:', @actor),
            updatedDate = GETDATE()
        WHERE id = @userId;

        EXEC dbo.usp_inf_bump_session_version @userId = @userId, @reason = N'password reset';

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
