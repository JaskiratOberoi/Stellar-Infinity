/*
 * 113_fix_settle_nested_resultset.sql
 *
 * The settle procedure credited the wallet correctly and then handed the
 * caller the WRONG RESULT SET.
 *
 * -- WHAT HAPPENED -----------------------------------------------------------
 * usp_inf_payment_intent_settle calls usp_telo_record_mcc_payment, and that
 * procedure ends in a SELECT. A nested SELECT is not swallowed: it is streamed
 * to the client as a result set of its own, ahead of ours. So the API's reader
 * opened on { ok, error_code, message, new_balance } - the payment procedure's
 * shape - and threw IndexOutOfRangeException looking for mcc_code.
 *
 * The money was never at risk. The exception was raised in the client AFTER
 * the procedure had run to completion and committed, so the wallet was
 * credited and the intent latched; the customer was simply shown a 500 for a
 * payment that had in fact succeeded. Which is its own kind of bad: it invites
 * them to pay again.
 *
 * -- THE FIX ----------------------------------------------------------------
 * INSERT ... EXEC captures the nested result set into a table variable, which
 * consumes it. Ours is then the only one the reader sees.
 *
 * And having captured it, we now READ it. The previous version fired the
 * credit and assumed it worked: if usp_telo_record_mcc_payment had returned
 * ok = 0 - a validation failure, a missing account - the intent would still
 * have been committed as 'success' and the client would have been shown a
 * payment that never reached their balance. Now a failed credit rolls the
 * whole thing back, leaving settled_at NULL so the callback can be retried.
 *
 * -- THE PAYMENT MODE -------------------------------------------------------
 * Also switches the default mode from 2 to 5. The LIS's own CCAvenue rows in
 * tbl_med_mcc_account_detail carry deposittype 5 ("Online"); 2 was a guess
 * made before there was any evidence, and it would have filed these payments
 * under a heading the lab's existing reports do not expect.
 */
SET QUOTED_IDENTIFIER ON;
SET ANSI_NULLS ON;
GO

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
    -- 5 = Online, which is what the LIS files its own CCAvenue payments under.
    @paymentMode    INT = 5
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

    -- Somewhere to put the nested procedure's result set. Declared out here so
    -- it is in scope for the check after the EXEC.
    DECLARE @credit TABLE (
        ok          BIT,
        error_code  VARCHAR(20),
        message     NVARCHAR(200),
        new_balance INT
    );

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
            -- A local, because T-SQL will not accept an expression as a
            -- procedure parameter value - `@amount = CAST(...)` is a syntax
            -- error, not a conversion.
            --
            -- The cast itself is deliberate: the wallet is kept in whole rupees
            -- (currentbalance is an INT) and /checkout only ever mints whole
            -- amounts, so this is exact - but a narrowing on a money value
            -- should be visible in the source rather than left to the engine.
            DECLARE @creditAmount INT = CAST(@expected AS INT);

            -- INSERT ... EXEC, not a bare EXEC. This captures the payment
            -- procedure's own SELECT instead of letting it stream to the
            -- caller as a result set ahead of ours - which is what made the
            -- API read { ok, error_code, message, new_balance } and fail
            -- looking for mcc_code.
            INSERT INTO @credit (ok, error_code, message, new_balance)
            EXEC dbo.usp_telo_record_mcc_payment
                 @userId      = @createdBy,
                 @mcc         = @mcc,
                 @amount      = @creditAmount,  -- OUR figure, never the response
                 @mode        = @paymentMode,
                 @depositDate = NULL,
                 @chequeNo    = @gatewayRef,    -- the CCAvenue tracking id
                 @reason      = N'Online payment (CCAvenue)',
                 @origin      = N'ccav:';

            -- And now we look at it. Firing the credit and assuming it worked
            -- would commit the intent as 'success' while the client's balance
            -- had not moved - the one inconsistency this whole design exists
            -- to prevent.
            IF NOT EXISTS (SELECT 1 FROM @credit WHERE ok = 1)
            BEGIN
                DECLARE @why NVARCHAR(200) = (SELECT TOP 1 message FROM @credit);
                ROLLBACK TRANSACTION;
                SELECT ok = 0, error_code = 'CREDIT_FAILED',
                       message = ISNULL(@why, N'The wallet credit was refused.'),
                       mcc_code = @mcc, amount = @expected, status = NULL;
                RETURN;
            END
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

PRINT 'usp_inf_payment_intent_settle rebuilt: nested result set captured, credit verified.';
GO
