/*
 * 110_usp_inf_admin_set_capability_grant.sql
 *
 * Grant or revoke ONE per-user capability. Today that means walk-in ordering
 * for a client account (order:b2c); the whitelist lives on the table's CHECK
 * constraint (109), not here, so this procedure cannot widen it.
 *
 * Bumps the session version, exactly as usp_inf_admin_set_role does and for a
 * sharper reason: capabilities are baked into the issued token, so a REVOKE
 * that did not bump would leave the capability live until the token expired —
 * up to eight hours of a centre still pricing walk-ins after the lab withdrew
 * permission. Bumping costs the user a re-login and is the honest behaviour.
 *
 * Audited into inf_result_audit, which is append-only: who granted what to
 * whom is exactly the kind of fact that must not be editable later.
 *
 * Returns { ok, error_code, message }.
 */
SET QUOTED_IDENTIFIER ON;
SET ANSI_NULLS ON;
GO

CREATE OR ALTER PROCEDURE dbo.usp_inf_admin_set_capability_grant
    @userId     INT,
    @capability VARCHAR(40),
    @granted    BIT,
    @actor      INT
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    IF NOT EXISTS (SELECT 1 FROM dbo.tbl_med_user_master WHERE id = @userId)
    BEGIN
        SELECT ok = CAST(0 AS BIT), error_code = 'NOT_FOUND', message = N'User not found';
        RETURN;
    END

    /* Named explicitly rather than deferred to the CHECK: a constraint
       violation would surface as a 500 with a SQL message, and the caller
       deserves to be told which capability is grantable. */
    IF @capability NOT IN ('order:b2c')
    BEGIN
        SELECT ok = CAST(0 AS BIT), error_code = 'VALIDATION',
               message = N'That capability cannot be granted to an individual user.';
        RETURN;
    END

    /* The actor must hold user:manage in practice — the endpoint enforces the
       capability — but a Super Admin target stays Super-Admin-only here too,
       matching SP 23. Without this, an ordinary admin could alter a Super
       Admin's grants. */
    IF EXISTS (SELECT 1 FROM dbo.tbl_med_user_master
               WHERE id = @userId AND usertypeid = 1)
       AND NOT EXISTS (SELECT 1 FROM dbo.tbl_med_user_master
                       WHERE id = @actor AND usertypeid = 1)
    BEGIN
        SELECT ok = CAST(0 AS BIT), error_code = 'FORBIDDEN',
               message = N'Only an LIS Super Admin may modify this user';
        RETURN;
    END

    DECLARE @actorName NVARCHAR(50) =
        (SELECT Username FROM dbo.tbl_med_user_master WHERE id = @actor);
    DECLARE @targetName NVARCHAR(50) =
        (SELECT Username FROM dbo.tbl_med_user_master WHERE id = @userId);
    DECLARE @had BIT =
        CASE WHEN EXISTS (SELECT 1 FROM dbo.inf_user_capability_grant
                          WHERE user_id = @userId AND capability = @capability)
             THEN 1 ELSE 0 END;

    /* Nothing to do, and say so rather than bumping the session version and
       logging someone out for a no-op. */
    IF @had = @granted
    BEGIN
        SELECT ok = CAST(1 AS BIT), error_code = CAST(NULL AS VARCHAR(20)),
               message = N'No change';
        RETURN;
    END

    BEGIN TRY
        BEGIN TRAN;

        IF @granted = 1
            INSERT INTO dbo.inf_user_capability_grant (user_id, capability, granted_by)
            VALUES (@userId, @capability, @actor);
        ELSE
            DELETE FROM dbo.inf_user_capability_grant
            WHERE user_id = @userId AND capability = @capability;

        /* Capabilities live in the token; a change must not wait for expiry.
           Through the shared helper rather than a hand-rolled MERGE, so this
           bump behaves identically to a role change and there is one place
           that knows the table shape. */
        EXEC dbo.usp_inf_bump_session_version
             @userId = @userId, @reason = N'walk-in grant changed';

        INSERT INTO dbo.inf_result_audit
            (vailid, action, field, old_value, new_value, reason,
             actor_user_id, actor_username, source, origin)
        VALUES
            (NULL, 'grant', 'capability',
             CASE WHEN @had = 1 THEN @capability ELSE NULL END,
             CASE WHEN @granted = 1 THEN @capability ELSE NULL END,
             CONCAT(CASE WHEN @granted = 1 THEN N'granted ' ELSE N'revoked ' END,
                    @capability, N' for ', ISNULL(@targetName, N'?'),
                    N' (user ', CONVERT(NVARCHAR(20), @userId), N')'),
             @actor, @actorName, 'ui',
             'inf:' + CONVERT(VARCHAR(20), @actor));

        COMMIT;

        SELECT ok = CAST(1 AS BIT), error_code = CAST(NULL AS VARCHAR(20)),
               message = CASE WHEN @granted = 1
                              THEN N'Walk-in ordering enabled. The user must sign in again.'
                              ELSE N'Walk-in ordering removed. The user must sign in again.' END;
    END TRY
    BEGIN CATCH
        IF XACT_STATE() <> 0 ROLLBACK;
        THROW;
    END CATCH
END
GO
