/*
 * 114_payment_instrument.sql
 *
 * Record WHICH instrument an online payment used - card, UPI, net banking,
 * wallet - instead of filing them all as "Online".
 *
 * -- WHY NOT A NEW deposittype ------------------------------------------------
 * The obvious move is to add ids: 8 = Card, 9 = UPI, and so on. It is the wrong
 * one. The LIS renders that column through MccAccountClass.GetPaymentMode,
 * an if/else chain over 1-7 that returns string.Empty for anything else. A
 * payment filed as 8 would appear in the LIS with a BLANK payment mode, on
 * every screen and report that shows it, and nobody looking at it would be
 * able to tell what happened. Infinity does not get to redefine an enum that
 * another live application reads.
 *
 * So deposittype stays 5 ("Online") - which remains true, and keeps the LIS
 * rendering these exactly as it renders its own gateway payments - and the
 * instrument is recorded ALONGSIDE it, in two places:
 *
 *   1. inf_payment_intent, as its own columns. Ours to query and report on
 *      properly.
 *   2. the ledger row's Reason text, which the LIS already displays. That is
 *      what makes the distinction visible to someone working in Listec rather
 *      than in Infinity - "Online payment (CCAvenue) - UPI / Google Pay"
 *      instead of a row that only says Online.
 *
 * -- WHERE THE VALUES COME FROM ----------------------------------------------
 * CCAvenue's response carries payment_mode ("Credit Card", "Net Banking",
 * "Unified Payments", "Wallet", ...) and card_name (the issuer or app: "Visa",
 * "State Bank of India", "Google Pay"). Both are descriptive strings from the
 * gateway, stored as sent. Neither is trusted for anything - they decide no
 * amount and gate no credit - so a surprising value is a labelling problem,
 * never a money one.
 */
SET QUOTED_IDENTIFIER ON;
SET ANSI_NULLS ON;
GO

IF COL_LENGTH('dbo.inf_payment_intent', 'gateway_instrument') IS NULL
BEGIN
    ALTER TABLE dbo.inf_payment_intent
        ADD gateway_instrument VARCHAR(40)  NULL,   -- CCAvenue payment_mode
            gateway_card       VARCHAR(60)  NULL;   -- CCAvenue card_name
    PRINT 'Added gateway_instrument / gateway_card.';
END
ELSE
    PRINT 'Instrument columns already present.';
GO

-- "How did centres actually pay us last quarter?" - the question these columns
-- exist to answer, and the one a report will ask.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_inf_payment_intent_instrument')
    CREATE NONCLUSTERED INDEX IX_inf_payment_intent_instrument
        ON dbo.inf_payment_intent (gateway_instrument, settled_at)
        WHERE settled_at IS NOT NULL;
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
    @paymentMode    INT = 5,
    @instrument     VARCHAR(40) = NULL,   -- "Credit Card", "Unified Payments", ...
    @card           VARCHAR(60) = NULL    -- "Visa", "Google Pay", issuing bank
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE @mcc INT, @expected DECIMAL(18,2), @settled DATETIME2, @createdBy INT;

    SELECT @mcc = mcc_code, @expected = amount, @settled = settled_at, @createdBy = created_by
    FROM dbo.inf_payment_intent
    WHERE order_ref = @orderRef;

    -- Not ours. Someone has posted a response for an order we never minted, or
    -- the reference was mangled in transit.
    IF @mcc IS NULL
    BEGIN
        SELECT ok = 0, error_code = 'UNKNOWN', message = 'No such payment.',
               mcc_code = NULL, amount = NULL, status = NULL;
        RETURN;
    END

    -- Already done. A gateway callback legitimately arrives twice - the
    -- customer refreshes, the gateway retries, a webhook races the redirect -
    -- and the second must be a no-op, not a second credit.
    IF @settled IS NOT NULL
    BEGIN
        SELECT ok = 1, error_code = 'ALREADY',
               message = 'This payment has already been recorded.',
               mcc_code = @mcc, amount = @expected,
               status = (SELECT status FROM dbo.inf_payment_intent WHERE order_ref = @orderRef);
        RETURN;
    END

    -- A success whose amount disagrees with what we asked for credits NOTHING:
    -- we cannot tell whether the gateway took more or less than we believe, and
    -- guessing either way moves real money on a figure we do not trust.
    DECLARE @finalStatus VARCHAR(20) =
        CASE WHEN @gatewayStatus <> 'success' THEN @gatewayStatus
             WHEN @gatewayAmount IS NULL      THEN 'mismatch'
             WHEN @gatewayAmount <> @expected THEN 'mismatch'
             ELSE 'success' END;

    /*
     * The ledger note, which is where the LIS will show the instrument.
     *
     * Built to fit @reason's NVARCHAR(200) with room to spare, and degrading
     * cleanly: with neither value it is exactly the string this wrote before,
     * so old rows and new ones stay comparable.
     */
    DECLARE @reason NVARCHAR(200) = N'Online payment (CCAvenue)';
    IF NULLIF(LTRIM(RTRIM(@instrument)), '') IS NOT NULL
    BEGIN
        SET @reason = @reason + N' - ' + LTRIM(RTRIM(@instrument));
        IF NULLIF(LTRIM(RTRIM(@card)), '') IS NOT NULL
            SET @reason = @reason + N' / ' + LTRIM(RTRIM(@card));
    END
    SET @reason = LEFT(@reason, 200);

    DECLARE @credit TABLE (
        ok          BIT,
        error_code  VARCHAR(20),
        message     NVARCHAR(200),
        new_balance INT
    );

    BEGIN TRY
        BEGIN TRANSACTION;

        -- The latch. `settled_at IS NULL` in the WHERE is what makes two
        -- concurrent callbacks safe: the loser updates zero rows.
        UPDATE dbo.inf_payment_intent
        SET status             = @finalStatus,
            gateway_ref        = NULLIF(@gatewayRef, ''),
            gateway_amount     = @gatewayAmount,
            gateway_message    = @gatewayMessage,
            gateway_instrument = NULLIF(LTRIM(RTRIM(@instrument)), ''),
            gateway_card       = NULLIF(LTRIM(RTRIM(@card)), ''),
            settled_at         = SYSDATETIME()
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

        IF @finalStatus = 'success'
        BEGIN
            -- A local, because T-SQL will not accept an expression as a
            -- procedure parameter value. The cast is deliberate: the wallet is
            -- whole rupees and /checkout only mints whole amounts, so it is
            -- exact - but a narrowing on money should be visible in the source.
            DECLARE @creditAmount INT = CAST(@expected AS INT);

            -- INSERT ... EXEC, not a bare EXEC: this captures the payment
            -- procedure's own SELECT instead of letting it stream to the caller
            -- as a result set ahead of ours.
            INSERT INTO @credit (ok, error_code, message, new_balance)
            EXEC dbo.usp_telo_record_mcc_payment
                 @userId      = @createdBy,
                 @mcc         = @mcc,
                 @amount      = @creditAmount,  -- OUR figure, never the response
                 @mode        = @paymentMode,
                 @depositDate = NULL,
                 @chequeNo    = @gatewayRef,
                 @reason      = @reason,
                 @origin      = N'ccav:';

            -- And we look at it. Firing the credit and assuming it worked would
            -- commit the intent as 'success' while the balance had not moved.
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
        SELECT ok = 0, error_code = 'ERROR', message = ERROR_MESSAGE(),
               mcc_code = @mcc, amount = @expected, status = NULL;
    END CATCH
END
GO

PRINT 'usp_inf_payment_intent_settle rebuilt: instrument recorded.';
GO
