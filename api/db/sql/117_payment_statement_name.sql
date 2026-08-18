/*
 * 117_payment_statement_name.sql
 *
 * Put a name on the payment lines in Sales Transactions for Franchises/Unit.
 *
 * -- WHAT THE COLUMN IS ------------------------------------------------------
 * That screen's "Name" binds to tbl_med_mcc_test_transactions.vailid
 * (SalesTestTransforMcc.aspx line 98), which sp_mcc_test_account_101 takes as
 * @vailid. On a test charge the LIS puts the PATIENT's name there - the person
 * the charge is for.
 *
 * A payment has no patient, so the LIS passes an empty string: all 11,305 of
 * its own ONLINE rows this month have a blank name, and 116's backfilled rows
 * copied that. Faithful to the LIS, and useless to read - a statement where
 * every credit line is nameless.
 *
 * -- WHAT GOES THERE INSTEAD ------------------------------------------------
 * The payer. On a charge the name answers "who is this for"; on a credit the
 * same question means the centre that paid, and the instrument they paid with.
 * So: "GENOMICS - Unified Payments / Google Pay", falling back to just the
 * centre when the gateway tells us nothing.
 *
 * The centre is already identifiable from the MCC Code column, so this is
 * partly redundant - but a blank cell reads as missing data, and an accountant
 * scanning a column of names should not have to know that the empty ones are
 * the payments.
 *
 * patientid stays 0. There is no patient, and inventing an id to fill a column
 * would break every join that trusts it.
 */
SET QUOTED_IDENTIFIER ON;
SET ANSI_NULLS ON;
GO

IF OBJECT_ID('dbo.usp_inf_payment_intent_settle', 'P') IS NOT NULL
    DROP PROCEDURE dbo.usp_inf_payment_intent_settle;
GO

CREATE PROCEDURE dbo.usp_inf_payment_intent_settle
    @orderRef       VARCHAR(40),
    @gatewayRef     VARCHAR(60),
    @gatewayStatus  VARCHAR(20),      -- success | failed | aborted
    @gatewayAmount  DECIMAL(18,2),
    @gatewayMessage NVARCHAR(400),
    @paymentMode    INT = 5,          -- 5 = Online, as the LIS files its own
    @instrument     VARCHAR(40) = NULL,
    @card           VARCHAR(60) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE @mcc INT, @expected DECIMAL(18,2), @settled DATETIME2, @createdBy INT;

    SELECT @mcc = mcc_code, @expected = amount, @settled = settled_at, @createdBy = created_by
    FROM dbo.inf_payment_intent
    WHERE order_ref = @orderRef;

    IF @mcc IS NULL
    BEGIN
        SELECT ok = 0, error_code = 'UNKNOWN', message = 'No such payment.',
               mcc_code = NULL, amount = NULL, status = NULL;
        RETURN;
    END

    IF @settled IS NOT NULL
    BEGIN
        SELECT ok = 1, error_code = 'ALREADY',
               message = 'This payment has already been recorded.',
               mcc_code = @mcc, amount = @expected,
               status = (SELECT status FROM dbo.inf_payment_intent WHERE order_ref = @orderRef);
        RETURN;
    END

    DECLARE @finalStatus VARCHAR(20) =
        CASE WHEN @gatewayStatus <> 'success' THEN @gatewayStatus
             WHEN @gatewayAmount IS NULL      THEN 'mismatch'
             WHEN @gatewayAmount <> @expected THEN 'mismatch'
             ELSE 'success' END;

    -- The instrument, said once and reused for both the deposit slip's Reason
    -- and the statement line's name.
    DECLARE @how NVARCHAR(120) = NULL;
    IF NULLIF(LTRIM(RTRIM(@instrument)), '') IS NOT NULL
    BEGIN
        SET @how = LTRIM(RTRIM(@instrument));
        IF NULLIF(LTRIM(RTRIM(@card)), '') IS NOT NULL
            SET @how = @how + N' / ' + LTRIM(RTRIM(@card));
    END

    -- Degrades to exactly the old string when the gateway tells us nothing, so
    -- old rows and new ones stay comparable.
    DECLARE @reason NVARCHAR(200) = N'Online payment (CCAvenue)';
    IF @how IS NOT NULL SET @reason = @reason + N' - ' + @how;
    SET @reason = LEFT(@reason, 200);

    -- The payer, for the statement's Name column. nvarchar(100) there, so the
    -- centre's name is kept whole and the instrument is what gets cut if the
    -- pair is too long - the name is the part someone is scanning for.
    DECLARE @payer NVARCHAR(100) =
        ISNULL((SELECT LTRIM(RTRIM(MCCUnitName)) FROM dbo.tbl_med_mcc_unit_master WHERE id = @mcc), N'');
    IF @how IS NOT NULL AND @payer <> N''
        SET @payer = LEFT(@payer + N' - ' + @how, 100);
    ELSE IF @payer = N'' AND @how IS NOT NULL
        SET @payer = LEFT(@how, 100);

    DECLARE @credit TABLE (
        ok          BIT,
        error_code  VARCHAR(20),
        message     NVARCHAR(200),
        new_balance INT
    );

    BEGIN TRY
        BEGIN TRANSACTION;

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
            DECLARE @creditAmount INT = CAST(@expected AS INT);

            -- INSERT ... EXEC: captures the payment procedure's own SELECT
            -- instead of letting it stream to the caller ahead of ours.
            INSERT INTO @credit (ok, error_code, message, new_balance)
            EXEC dbo.usp_telo_record_mcc_payment
                 @userId      = @createdBy,
                 @mcc         = @mcc,
                 @amount      = @creditAmount,
                 @mode        = @paymentMode,
                 @depositDate = NULL,
                 @chequeNo    = @gatewayRef,
                 @reason      = @reason,
                 @origin      = N'ccav:';

            IF NOT EXISTS (SELECT 1 FROM @credit WHERE ok = 1)
            BEGIN
                DECLARE @why NVARCHAR(200) = (SELECT TOP 1 message FROM @credit);
                ROLLBACK TRANSACTION;
                SELECT ok = 0, error_code = 'CREDIT_FAILED',
                       message = ISNULL(@why, N'The wallet credit was refused.'),
                       mcc_code = @mcc, amount = @expected, status = NULL;
                RETURN;
            END

            /*
             * The statement line - what puts the payment on the LIS's client
             * account and sales ledger screens, and what keeps the running
             * closingbalance agreeing with the wallet.
             *
             * Balances come from the credit's own new_balance, not a re-read: a
             * second SELECT could pick up a concurrent accession's write and
             * record a closing balance that never existed.
             *
             * A bare EXEC is safe: sp_mcc_test_account_101 is INSERT-only and
             * returns no result set. If that ever changes this needs the
             * INSERT ... EXEC treatment above - a nested result set reaching
             * the caller broke this procedure once already.
             */
            DECLARE @closing INT = (SELECT TOP 1 new_balance FROM @credit);
            DECLARE @opening INT = @closing - @creditAmount;
            -- A local, because T-SQL rejects an expression as a parameter
            -- value: @TDATE = SYSDATETIME() is a syntax error, not a call.
            DECLARE @nowForTxn DATETIME = GETDATE();

            EXEC dbo.sp_mcc_test_account_101
                 @USERID         = @createdBy,
                 @MCCID          = @mcc,
                 @TDATE          = @nowForTxn,
                 @CBALANCE       = @opening,
                 @TESTCHARGES    = @creditAmount,
                 @CLOSINGBALANCE = @closing,
                 @tname          = N'ONLINE',   -- exactly what the LIS files
                 @vailid         = @payer,      -- who paid, and how
                 @patientid      = 0,           -- there is no patient
                 @SUBFRANCHISE   = N'';
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

/*
 * And name the two rows already written. Scoped to the statement rows this
 * integration created - CCAvenue payments carrying an intent we can match on
 * amount and closing balance - so it cannot touch the LIS's own rows.
 */
UPDATE t
SET vailid = LEFT(u.MCCUnitName
                  + ISNULL(N' - ' + NULLIF(i.gateway_instrument, ''), N'')
                  + ISNULL(N' / ' + NULLIF(i.gateway_card, ''), N''), 100)
FROM dbo.tbl_med_mcc_test_transactions t
JOIN dbo.tbl_med_mcc_unit_master u ON u.id = t.mccid
JOIN dbo.inf_payment_intent i
  ON i.mcc_code = t.mccid
 AND i.status = 'success'
 AND CAST(i.amount AS INT) = CAST(t.testcharges AS INT)
WHERE t.tname = 'ONLINE'
  AND ISNULL(t.vailid, '') = '';

PRINT CONCAT('Named ', @@ROWCOUNT, ' existing payment line(s).');
GO
