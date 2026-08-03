/*
 * 64_usp_inf_admin_update_profile.sql
 *
 * Edits the display fields on an account: name and email.
 *
 * Unlike the password and active/LIS-access procedures, this is allowed for
 * accounts Infinity does not own. Correcting a misspelt name or a stale email
 * changes nobody's access, and refusing it would leave admins unable to fix
 * obvious data errors on the ~4,000 native LIS accounts that make up most of
 * the directory. Nothing here can alter what a user can reach.
 *
 * The username is deliberately NOT editable. It is the login, it is referenced
 * by the addedby/'inf:<id>' marker convention only indirectly, and renaming it
 * would silently break the person's ability to sign in.
 *
 * Returns { ok, error_code, message }.
 */
CREATE OR ALTER PROCEDURE dbo.usp_inf_admin_update_profile
    @userId    INT,
    @firstName NVARCHAR(100),
    @lastName  NVARCHAR(100) = NULL,
    @email     NVARCHAR(100) = NULL,
    @actor     INT
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    IF NOT EXISTS (SELECT 1 FROM dbo.tbl_med_user_master WHERE id = @userId)
    BEGIN
        SELECT ok = CAST(0 AS BIT), error_code = 'NOT_FOUND', message = N'User not found';
        RETURN;
    END

    IF @firstName IS NULL OR LTRIM(RTRIM(@firstName)) = N''
    BEGIN
        SELECT ok = CAST(0 AS BIT), error_code = 'VALIDATION', message = N'A first name is required';
        RETURN;
    END

    IF EXISTS (SELECT 1 FROM dbo.tbl_med_user_master WHERE id = @userId AND usertypeid = 1)
       AND NOT EXISTS (SELECT 1 FROM dbo.tbl_med_user_master WHERE id = @actor AND usertypeid = 1)
    BEGIN
        SELECT ok = CAST(0 AS BIT), error_code = 'FORBIDDEN',
               message = N'Only an LIS Super Admin may modify this user';
        RETURN;
    END

    BEGIN TRY
        UPDATE dbo.tbl_med_user_master
        SET firstname   = LEFT(LTRIM(RTRIM(@firstName)), 100),
            lastname    = LEFT(ISNULL(LTRIM(RTRIM(@lastName)), N''), 100),
            Email       = LEFT(ISNULL(LTRIM(RTRIM(@email)), N''), 100),
            updatedby   = CONCAT(N'inf:', @actor),
            updatedDate = GETDATE()
        WHERE id = @userId;

        SELECT ok = CAST(1 AS BIT), error_code = CAST(NULL AS VARCHAR(20)),
               message = CAST(NULL AS NVARCHAR(200));
    END TRY
    BEGIN CATCH
        SELECT ok = CAST(0 AS BIT), error_code = 'INTERNAL', message = LEFT(ERROR_MESSAGE(), 200);
    END CATCH
END
GO
