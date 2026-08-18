/*
 * 115_payment_transaction_row.sql
 *
 * Make an online payment visible in the LIS, not just in the wallet.
 *
 * -- THE TWO LEDGERS ---------------------------------------------------------
 * A client's money lives in two places, and they are written by different code:
 *
 *   tbl_med_mcc_account_master.currentbalance   the balance itself
 *   tbl_med_mcc_account_detail                  the deposit slips
 *   tbl_med_mcc_test_transactions               the running statement
 *
 * usp_telo_record_mcc_payment writes the first two. It does NOT write the
 * third - nothing about a payment ever did, because on the LIS side that row
 * is written by the CALLER: ccavResponse.aspx.cs line 114 calls
 * sp_mcc_test_account_101 itself, right before saving the account detail.
 *
 * We were not making that call. So an Infinity payment credited the wallet and
 * left no line on the statement - invisible in the LIS's client account and
 * sales ledger screens, which read the third table. Worse, the statement's
 * running closingbalance stopped agreeing with the wallet: the last
 * transaction row for client 286 closed at 20,78,350 while currentbalance had
 * moved to 20,78,361. Eleven rupees of drift, from two test payments. On a
 * real month it would be thousands, and the first person to notice would be an
 * accountant who could not make the statement foot.
 *
 * -- WHAT THIS DOES ---------------------------------------------------------
 * Calls sp_mcc_test_account_101 after a verified credit, with exactly the
 * arguments the LIS passes for its own gateway payments: tname 'ONLINE',
 * no patient, no sub-franchise. Same shape, same reports, wherever the payment
 * was started.
 *
 * The balances come from the credit's OWN result - new_balance, which we now
 * capture - rather than from a re-read. A second SELECT could pick up another
 * transaction's write and record a closing balance that never existed.
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

    -- The ledger note, degrading to exactly the old string when the gateway
    -- tells us nothing, so old rows and new ones stay comparable.
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
             * The statement line. This is what puts the payment on the LIS's
             * client account and sales ledger screens, and what keeps the
             * running closingbalance agreeing with the wallet.
             *
             * Arguments copied from ccavResponse.aspx.cs:114 - tname 'ONLINE',
             * no patient, no sub-franchise - so a payment started in Infinity
             * is indistinguishable from one started in Listec on every report
             * that reads this table.
             *
             * Balances come from the credit's own new_balance, not a re-read:
             * a second SELECT could pick up a concurrent accession's write and
             * record a closing balance that never existed.
             *
             * A bare EXEC is safe here: sp_mcc_test_account_101 is INSERT-only
             * and returns no result set. If that ever changes, this needs the
             * INSERT ... EXEC treatment above - a nested result set reaching
             * the caller is what broke this procedure once already.
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
                 @tname          = N'ONLINE',
                 @vailid         = N'',
                 @patientid      = 0,
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

PRINT 'usp_inf_payment_intent_settle rebuilt: writes the statement row too.';
GO
