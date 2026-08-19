SET QUOTED_IDENTIFIER ON;
GO
/*
 * 120_client_report_unlock.sql
 *
 * The master switch: release one client's reports regardless of what they owe.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS BEING WRITTEN, AND WHY IT IS THE LIS's OWN BIT
 *
 * A B2B client's reports are held once their wallet drops below the credit
 * limit the lab granted them (tbl_med_mcc_unit_master.creditlimit, stored as a
 * NEGATIVE allowance). tbl_med_mcc_unit_master.PerminentUnlock overrides that
 * outright, and the legacy LIS, Telo and Infinity ALL already read it — 130
 * clients are released by it today.
 *
 * So this writes that same bit rather than an Infinity-private override. A
 * second flag would mean two answers to one question: a client released here
 * would still be refused in Telo and in the LIS, and the lab would be told
 * different things by different screens about the same account. Granting here
 * therefore releases the client EVERYWHERE, and revoking re-locks them
 * everywhere. That is the intended behaviour and it is worth stating plainly,
 * because it is a financial control being changed from a new place.
 *
 * ---------------------------------------------------------------------------
 * WHY A DEDICATED AUDIT TABLE
 *
 * inf_result_audit's vocabulary is a CHECK constraint that has to be dropped
 * and recreated whole to add a value — 109a says so in as many words, and it is
 * last-writer-wins. Releasing a debtor's reports is a money decision and its
 * trail must not depend on winning that race, so it gets its own append-only
 * table. It also records the BALANCE AT THE TIME, which the flag itself cannot:
 * "why was this client unlocked while owing 58 lakh" is the question this table
 * exists to answer.
 * ---------------------------------------------------------------------------
 */

IF OBJECT_ID('dbo.inf_client_unlock_audit', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.inf_client_unlock_audit
    (
        id              BIGINT IDENTITY(1,1) NOT NULL
                        CONSTRAINT PK_inf_client_unlock_audit PRIMARY KEY,
        mcc_code        INT            NOT NULL,   -- tbl_med_mcc_unit_master.id
        client_code     NVARCHAR(100)  NOT NULL,
        -- 1 granted, 0 revoked. Both are recorded: taking a release away is as
        -- consequential as giving one.
        unlocked        BIT            NOT NULL,
        -- The account as it stood when the decision was taken. Kept because the
        -- balance moves constantly and the justification does not travel with it.
        balance_at      INT            NULL,
        credit_limit_at INT            NULL,
        reason          NVARCHAR(400)  NULL,
        actor_user_id   INT            NULL,
        actor_username  NVARCHAR(100)  NULL,
        occurred_at     DATETIMEOFFSET NOT NULL
                        CONSTRAINT DF_inf_client_unlock_audit_at DEFAULT SYSDATETIMEOFFSET()
    );

    CREATE INDEX IX_inf_client_unlock_audit_client
        ON dbo.inf_client_unlock_audit (mcc_code, occurred_at DESC);
END
GO

/*
 * Grant or revoke the master unlock for one client, and record why.
 *
 * Idempotent: setting the flag to what it already is still writes an audit row
 * (someone re-affirmed the decision) but reports changed = 0, so the caller can
 * tell a real change from a no-op.
 *
 * Returns { ok, error_code, message, client_code, client_name, unlocked,
 *           was_unlocked, changed, balance, credit_limit }.
 */
CREATE OR ALTER PROCEDURE dbo.usp_inf_set_client_unlock
    -- Keyed on the mcc id, not the code: the id is what the caller's scope was
    -- checked against, and a code can be renamed under a client.
    @mcc            INT,
    @unlocked       BIT,
    @reason         NVARCHAR(400) = NULL,
    @actor_user_id  INT           = NULL,
    @actor_username NVARCHAR(100) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    IF @mcc IS NULL OR @mcc <= 0
    BEGIN
        SELECT ok = CAST(0 AS BIT), error_code = 'BAD_REQUEST',
               message = N'A client is required.';
        RETURN;
    END

    DECLARE @code NVARCHAR(100), @name NVARCHAR(200), @was BIT;
    SELECT @code = UPPER(LTRIM(RTRIM(u.MCCUnitCode))), @name = u.MCCUnitName,
           @was = ISNULL(u.PerminentUnlock, 0)
    FROM dbo.tbl_med_mcc_unit_master u
    WHERE u.id = @mcc;

    IF @code IS NULL
    BEGIN
        SELECT ok = CAST(0 AS BIT), error_code = 'NOT_FOUND',
               message = N'No such client.';
        RETURN;
    END

    DECLARE @balance INT, @limit INT;
    SELECT @balance = a.currentbalance FROM dbo.tbl_med_mcc_account_master a WHERE a.mcccode = @mcc;
    SELECT @limit = u.creditlimit FROM dbo.tbl_med_mcc_unit_master u WHERE u.id = @mcc;

    BEGIN TRAN;

        -- The one row, by id. Deliberately not by code: two rows could share a
        -- code after a rename and this must never release a client nobody asked
        -- about.
        UPDATE dbo.tbl_med_mcc_unit_master
        SET PerminentUnlock = @unlocked
        WHERE id = @mcc;

        INSERT INTO dbo.inf_client_unlock_audit
            (mcc_code, client_code, unlocked, balance_at, credit_limit_at,
             reason, actor_user_id, actor_username)
        VALUES
            (@mcc, @code, @unlocked, @balance, @limit,
             NULLIF(LTRIM(RTRIM(@reason)), N''), @actor_user_id, @actor_username);

    COMMIT;

    SELECT ok = CAST(1 AS BIT), error_code = CAST(NULL AS VARCHAR(30)),
           message = CAST(NULL AS NVARCHAR(200)),
           client_code = @code, client_name = @name,
           unlocked = @unlocked, was_unlocked = @was,
           changed = CASE WHEN @was = @unlocked THEN CAST(0 AS BIT) ELSE CAST(1 AS BIT) END,
           balance = @balance, credit_limit = @limit;
END
GO
