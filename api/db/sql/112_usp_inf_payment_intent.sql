/*
 * 112_usp_inf_payment_intent.sql
 *
 * Minting and settling an online payment intent.
 *
 * -- THE SHAPE THIS REPLACES ------------------------------------------------
 * razor_update.asmx credits a wallet from three strings the CALLER supplies,
 * with no verification that a payment occurred, and every one of ~3,300 client
 * logins can reach it. The fix is not a stricter callback. It is that the
 * amount is decided HERE, server-side, before the customer leaves for the
 * gateway; the response is then compared against what we already believed.
 *
 * A response claiming a different amount is a FAILED payment, not a smaller
 * one. A response for an order we never minted is not a payment at all.
 *
 * -- WHY THE CREDIT IS INSIDE THIS PROCEDURE --------------------------------
 * The obvious split - latch the intent here, credit the wallet from the API -
 * has a window: if the credit fails after the latch is set, the intent reads
 * as settled and the money has vanished. The latch and the credit are
 * therefore one transaction. Either the wallet moves and the intent records
 * it, or neither happened and the callback can be retried.
 */
SET QUOTED_IDENTIFIER ON;
SET ANSI_NULLS ON;
GO

-- ------------------------------------------------------------------ mint ---
IF OBJECT_ID('dbo.usp_inf_payment_intent_create', 'P') IS NOT NULL
    DROP PROCEDURE dbo.usp_inf_payment_intent_create;
GO

CREATE PROCEDURE dbo.usp_inf_payment_intent_create
    @userId    INT,
    @mcc       INT,
    @amount    DECIMAL(18,2),
    @orderRef  VARCHAR(40)
AS
BEGIN
    SET NOCOUNT ON;

    IF @amount IS NULL OR @amount <= 0
    BEGIN
        SELECT ok = 0, error_code = 'AMOUNT', message = 'A payment must be greater than zero.';
        RETURN;
    END

    -- The client must exist. Minting an intent against a stray code would give
    -- a callback something to settle against an account that is not there.
    IF NOT EXISTS (SELECT 1 FROM dbo.tbl_med_mcc_unit_master WHERE mcccode = @mcc)
    BEGIN
        SELECT ok = 0, error_code = 'NO_CLIENT', message = 'Unknown client code.';
        RETURN;
    END

    BEGIN TRY
        INSERT dbo.inf_payment_intent (order_ref, mcc_code, amount, created_by)
        VALUES (@orderRef, @mcc, @amount, @userId);

        SELECT ok = 1, error_code = NULL, message = NULL,
               order_ref = @orderRef, amount = @amount;
    END TRY
    BEGIN CATCH
        -- UQ_inf_payment_intent_ref. The reference is minted from a GUID, so a
        -- collision means a retry of the same request, not two payments.
        IF ERROR_NUMBER() IN (2601, 2627)
            SELECT ok = 0, error_code = 'DUPLICATE', message = 'That payment reference already exists.';
        ELSE
            SELECT ok = 0, error_code = 'ERROR', message = ERROR_MESSAGE();
    END CATCH
END
GO

-- ---------------------------------------------------------------- settle ---
IF OBJECT_ID('dbo.usp_inf_payment_intent_settle', 'P') IS NOT NULL
    DROP PROCEDURE dbo.usp_inf_payment_intent_settle;
GO

CREATE PROCEDURE dbo.usp_inf_payment_intent_settle
    @orderRef       VARCHAR(40),
    -- What the GATEWAY said. Named apart from the intent columns so nothing
    -- below can confuse the claim with the record.
    @gatewayRef     VARCHAR(60),
    @gatewayStatus  VARCHAR(20),      -- success | failed | aborted
    @gatewayAmount  DECIMAL(18,2),
    @gatewayMessage NVARCHAR(400),
    @paymentMode    INT = 2
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE @mcc INT, @expected DECIMAL(18,2), @settled DATETIME2, @createdBy INT;

    SELECT @mcc = mcc_code, @expected = amount, @settled = settled_at, @createdBy = created_by
    FROM dbo.inf_payment_intent
    WHERE order_ref = @orderRef;

    -- Not ours. Someone has posted a response for an order we never minted, or
    -- the reference was mangled in transit. Either way there is nothing to
    -- credit, and we say so rather than inventing an account.
    IF @mcc IS NULL
    BEGIN
        SELECT ok = 0, error_code = 'UNKNOWN', message = 'No such payment.',
               mcc_code = NULL, amount = NULL, status = NULL;
        RETURN;
    END

    -- Already done. A gateway callback legitimately arrives twice - the
    -- customer refreshes the return page, the gateway retries, a webhook races
    -- the redirect - and the second must be a no-op, not a second credit.
    IF @settled IS NOT NULL
    BEGIN
        SELECT ok = 1, error_code = 'ALREADY',
               message = 'This payment has already been recorded.',
               mcc_code = @mcc, amount = @expected,
               status = (SELECT status FROM dbo.inf_payment_intent WHERE order_ref = @orderRef);
        RETURN;
    END

    -- The amount check. A success whose amount disagrees with what we asked
    -- for is recorded as 'mismatch' and credits NOTHING: we cannot tell whether
    -- the gateway took more or less than we believe, and guessing either way
    -- moves real money on a figure we do not trust.
    DECLARE @finalStatus VARCHAR(20) =
        CASE WHEN @gatewayStatus <> 'success' THEN @gatewayStatus
             WHEN @gatewayAmount IS NULL      THEN 'mismatch'
             WHEN @gatewayAmount <> @expected THEN 'mismatch'
             ELSE 'success' END;

    BEGIN TRY
        BEGIN TRANSACTION;

        -- The latch. `settled_at IS NULL` in the WHERE is what makes two
        -- concurrent callbacks safe: the loser updates zero rows and takes the
        -- ALREADY path below.
        UPDATE dbo.inf_payment_intent
        SET status          = @finalStatus,
            gateway_ref     = NULLIF(@gatewayRef, ''),
            gateway_amount  = @gatewayAmount,
            gateway_message = @gatewayMessage,
            settled_at      = SYSDATETIME()
        WHERE order_ref = @orderRef
          AND settled_at IS NULL;

        IF @@ROWCOUNT = 0
        BEGIN
            COMMIT TRANSACTION;
            SELECT ok = 1, error_code = 'ALREADY',
                   message = 'This payment has already been recorded.',
                   mcc_code = @mcc, amount = @expected, status = 'success';
            RETURN;
        END

        -- The wallet moves only for a verified success, and only here, inside
        -- the same transaction as the latch.
        IF @finalStatus = 'success'
        BEGIN
            EXEC dbo.usp_telo_record_mcc_payment
                 @userId      = @createdBy,
                 @mcc         = @mcc,
                 @amount      = @expected,      -- OUR figure, never the response
                 @mode        = @paymentMode,
                 @depositDate = NULL,
                 @chequeNo    = @gatewayRef,    -- the CCAvenue tracking id
                 @reason      = N'Online payment (CCAvenue)',
                 @origin      = N'ccav:';
        END

        COMMIT TRANSACTION;

        SELECT ok = 1, error_code = NULL, message = NULL,
               mcc_code = @mcc, amount = @expected, status = @finalStatus;
    END TRY
    BEGIN CATCH
        IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
        -- Nothing latched, so the gateway retry - or an operator replaying the
        -- callback - can still settle this.
        SELECT ok = 0, error_code = 'ERROR', message = ERROR_MESSAGE(),
               mcc_code = @mcc, amount = @expected, status = NULL;
    END CATCH
END
GO

PRINT 'usp_inf_payment_intent_create / _settle ready.';
GO
