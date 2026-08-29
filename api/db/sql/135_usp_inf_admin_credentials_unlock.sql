/*
 * 135_usp_inf_admin_credentials_unlock.sql
 *
 * The account-control surface Infinity needs to stand in for the legacy LIS:
 * reveal a credential, and grant a centre relief from the balance lock
 * (permanent, or a timed "pay tomorrow, send today" window).
 *
 * All of these are admin acts gated at the endpoint by user:manage, and every
 * one keeps the LIS's own guard: a Super Admin target may only be touched by a
 * Super Admin actor. Reads and writes are audited in the endpoint layer
 * (inf_audit_log), so a revealed password leaves a trail naming who saw it.
 */
SET QUOTED_IDENTIFIER ON;
SET ANSI_NULLS ON;
GO

/*
 * Reveal the current password.
 *
 * Possible ONLY because the legacy credential column is plaintext, nvarchar(50)
 * — the same store the LIS's own admin screens read. This exists so a helpdesk
 * can tell a centre their password without forcing a reset that logs everyone
 * out; the reveal itself is audited by the caller.
 */
CREATE OR ALTER PROCEDURE dbo.usp_inf_admin_view_password
    @userId INT,
    @actor  INT
AS
BEGIN
    SET NOCOUNT ON;

    IF NOT EXISTS (SELECT 1 FROM dbo.tbl_med_user_master WHERE id = @userId)
    BEGIN
        SELECT ok = CAST(0 AS BIT), error_code = 'NOT_FOUND',
               message = N'User not found', password = CAST(NULL AS NVARCHAR(50));
        RETURN;
    END

    IF EXISTS (SELECT 1 FROM dbo.tbl_med_user_master WHERE id = @userId AND usertypeid = 1)
       AND NOT EXISTS (SELECT 1 FROM dbo.tbl_med_user_master WHERE id = @actor AND usertypeid = 1)
    BEGIN
        SELECT ok = CAST(0 AS BIT), error_code = 'FORBIDDEN',
               message = N'Only an LIS Super Admin may view this user''s password',
               password = CAST(NULL AS NVARCHAR(50));
        RETURN;
    END

    SELECT ok = CAST(1 AS BIT), error_code = CAST(NULL AS VARCHAR(20)),
           message = CAST(NULL AS NVARCHAR(200)),
           password = password
    FROM dbo.tbl_med_user_master
    WHERE id = @userId;
END
GO

/*
 * Permanent unlock — tbl_med_mcc_unit_master.PerminentUnlock. A centre carrying
 * it is NEVER balance-locked (see ReportLockRepository): its reports release no
 * matter what it owes. Real money implication, so it is audited with old/new by
 * the caller and returns the prior state for that record.
 */
CREATE OR ALTER PROCEDURE dbo.usp_inf_admin_set_permanent_unlock
    @mcc     INT,
    @enabled BIT,
    @actor   INT
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    IF NOT EXISTS (SELECT 1 FROM dbo.tbl_med_mcc_unit_master WHERE id = @mcc)
    BEGIN
        SELECT ok = CAST(0 AS BIT), error_code = 'NOT_FOUND',
               message = N'Unknown collection centre', was = CAST(NULL AS BIT);
        RETURN;
    END

    DECLARE @was BIT = (SELECT CAST(ISNULL(PerminentUnlock, 0) AS BIT)
                        FROM dbo.tbl_med_mcc_unit_master WHERE id = @mcc);

    UPDATE dbo.tbl_med_mcc_unit_master
    SET PerminentUnlock = @enabled
    WHERE id = @mcc;

    SELECT ok = CAST(1 AS BIT), error_code = CAST(NULL AS VARCHAR(20)),
           message = CAST(NULL AS NVARCHAR(200)), was = @was;
END
GO

/*
 * Temporary unlock — one append-only row in tbl_med_mcc_lockunlock, the table
 * ReportLockRepository already honours (expire_unlock > GETDATE() releases the
 * centre until it passes). The LIS's LockUnlock_MCC.aspx writes exactly this.
 * Re-granting adds a row rather than editing one; the newest expiry wins.
 */
CREATE OR ALTER PROCEDURE dbo.usp_inf_admin_grant_temp_unlock
    @mcc   INT,
    @hours INT,
    @actor INT
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    IF NOT EXISTS (SELECT 1 FROM dbo.tbl_med_mcc_unit_master WHERE id = @mcc)
    BEGIN
        SELECT ok = CAST(0 AS BIT), error_code = 'NOT_FOUND',
               message = N'Unknown collection centre', expire_unlock = CAST(NULL AS DATETIME);
        RETURN;
    END
    IF @hours IS NULL OR @hours <= 0 OR @hours > 720
    BEGIN
        SELECT ok = CAST(0 AS BIT), error_code = 'VALIDATION',
               message = N'Hours must be between 1 and 720.', expire_unlock = CAST(NULL AS DATETIME);
        RETURN;
    END

    DECLARE @now DATETIME = GETDATE();
    DECLARE @expire DATETIME = DATEADD(HOUR, @hours, @now);

    INSERT INTO dbo.tbl_med_mcc_lockunlock
        (mcc_code, datetime_unlock, number_of_hours, expire_unlock, addedby, addeddatetime)
    VALUES
        (@mcc, @now, @hours, @expire, CONCAT(N'inf:', @actor), @now);

    SELECT ok = CAST(1 AS BIT), error_code = CAST(NULL AS VARCHAR(20)),
           message = CAST(NULL AS NVARCHAR(200)), expire_unlock = @expire;
END
GO

/*
 * The lock state for a set of centres, so the settings panel can show whether
 * each own centre is permanently unlocked, on a live temporary unlock, or
 * neither — alongside what it owes against its limit. @mccIds is a comma list
 * of unit ids (the caller already holds them from the user's own centres).
 */
CREATE OR ALTER PROCEDURE dbo.usp_inf_admin_centre_lock_state
    @mccIds NVARCHAR(MAX)
AS
BEGIN
    SET NOCOUNT ON;

    SELECT
        mcc_id          = u.id,
        code            = u.MCCUnitCode,
        name            = u.MCCUnitName,
        permanent       = CAST(ISNULL(u.PerminentUnlock, 0) AS BIT),
        credit_limit    = u.creditlimit,
        current_balance = a.currentbalance,
        temp_expire     = (
            SELECT MAX(l.expire_unlock)
            FROM dbo.tbl_med_mcc_lockunlock l
            WHERE l.mcc_code = u.id AND l.expire_unlock > GETDATE())
    FROM dbo.tbl_med_mcc_unit_master u
    LEFT JOIN dbo.tbl_med_mcc_account_master a ON a.mcccode = u.id
    WHERE u.id IN (SELECT TRY_CONVERT(INT, LTRIM(RTRIM(value)))
                   FROM STRING_SPLIT(@mccIds, ',')
                   WHERE TRY_CONVERT(INT, LTRIM(RTRIM(value))) IS NOT NULL);
END
GO
