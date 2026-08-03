/*
 * 21_usp_inf_admin_set_lis_access.sql
 *
 * THE admin-panel switch: grants or revokes legacy-LIS login for an
 * Infinity-managed account.
 *
 * Sets inf_account.lis_access and re-derives the LIS gate
 *   IsActive = (inf_active AND lis_access)
 * The legacy LIS LoginClass reads IsActive and nothing else, so this single
 * derived bit is exactly what makes an Infinity credential work — or not work —
 * at the LIS.
 *
 * REFUSES two categories, both deliberately:
 *
 *  - Native LIS users (no inf_account row). Their LIS access is theirs to manage
 *    in the LIS; Infinity silently flipping it would be a surprise, and there is
 *    no Infinity intent recorded to re-derive it from.
 *
 *  - Telo-managed users (a telo_account row). Telo derives the SAME IsActive
 *    column from ITS pair of flags. If Infinity also wrote it, whichever admin
 *    panel was used last would win and the other would silently revert — an
 *    account could regain LIS access nobody granted. One account, one managing
 *    system. Migrate the account deliberately if it needs to move.
 *
 * Revoking also bumps the session version, so any LIS-side session assumption
 * cached in an Infinity token is invalidated rather than lingering.
 *
 * Returns { ok, error_code, message }.
 */
CREATE OR ALTER PROCEDURE dbo.usp_inf_admin_set_lis_access
    @userId  INT,
    @enabled BIT,
    @actor   INT
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
               message = N'LIS access is managed by Infinity only for Infinity-created accounts.';
        RETURN;
    END

    IF EXISTS (SELECT 1 FROM dbo.telo_account WHERE user_id = @userId)
    BEGIN
        SELECT ok = CAST(0 AS BIT), error_code = 'CONFLICT',
               message = N'This account is also managed by Telo, which derives the same LIS flag. Change it in one system only.';
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

        UPDATE dbo.inf_account
        SET lis_access = @enabled,
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

        EXEC dbo.usp_inf_bump_session_version @userId = @userId, @reason = N'lis_access changed';

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
