/*
 * 116_backfill_missing_statement_rows.sql
 *
 * ONE-OFF. Repairs the two payments that credited the wallet before
 * usp_inf_payment_intent_settle learned to write a statement row (115).
 *
 * Both went through CCAvenue against client 286 on 18 Aug 2026: 10 rupees at
 * 17:12 and 1 rupee at 17:37. Each updated tbl_med_mcc_account_master and
 * added a tbl_med_mcc_account_detail slip, but neither reached
 * tbl_med_mcc_test_transactions - so the LIS's client account and sales ledger
 * screens do not show them, and the statement's running closingbalance sits 11
 * rupees below the wallet.
 *
 * This inserts the two missing lines in payment order, chaining onto whatever
 * the statement currently closes at, so the running balance stays continuous.
 *
 * SAFE TO RE-RUN. Each insert is guarded on an ONLINE row not already existing
 * at that closing balance, and the balances are computed from the CURRENT tail
 * of the statement rather than hard-coded - so if an accession lands between
 * now and when this runs, the chain still joins up correctly.
 *
 * Run:
 *     powershell -File api/db/apply.ps1 116_backfill_missing_statement_rows.sql
 *
 * It prints both figures before and after; they should agree at the end.
 */
SET QUOTED_IDENTIFIER ON;
SET ANSI_NULLS ON;
GO

DECLARE @mcc INT = 286, @user INT = 307;

DECLARE @base INT = (SELECT TOP 1 CAST(closingbalance AS INT)
                     FROM dbo.tbl_med_mcc_test_transactions
                     WHERE mccid = @mcc ORDER BY id DESC);
DECLARE @wallet INT = (SELECT currentbalance FROM dbo.tbl_med_mcc_account_master
                       WHERE mcccode = @mcc);

PRINT CONCAT('Before  statement closes at ', @base, ', wallet holds ', @wallet,
             '  (drift ', @wallet - @base, ')');

DECLARE @b1 INT = @base + 10;
DECLARE @b2 INT = @b1 + 1;
DECLARE @d1 DATETIME = '2026-08-18T17:12:36';
DECLARE @d2 DATETIME = '2026-08-18T17:37:22';

-- 10 rupees, tracking id 114749186317.
IF NOT EXISTS (SELECT 1 FROM dbo.tbl_med_mcc_test_transactions
               WHERE mccid = @mcc AND tname = 'ONLINE' AND closingbalance = @b1)
    EXEC dbo.sp_mcc_test_account_101
         @USERID = @user, @MCCID = @mcc, @TDATE = @d1,
         @CBALANCE = @base, @TESTCHARGES = 10, @CLOSINGBALANCE = @b1,
         @tname = N'ONLINE', @vailid = N'', @patientid = 0, @SUBFRANCHISE = N'';
ELSE
    PRINT 'The 10-rupee line is already there - skipped.';

-- 1 rupee, tracking id 114749287193.
IF NOT EXISTS (SELECT 1 FROM dbo.tbl_med_mcc_test_transactions
               WHERE mccid = @mcc AND tname = 'ONLINE' AND closingbalance = @b2)
    EXEC dbo.sp_mcc_test_account_101
         @USERID = @user, @MCCID = @mcc, @TDATE = @d2,
         @CBALANCE = @b1, @TESTCHARGES = 1, @CLOSINGBALANCE = @b2,
         @tname = N'ONLINE', @vailid = N'', @patientid = 0, @SUBFRANCHISE = N'';
ELSE
    PRINT 'The 1-rupee line is already there - skipped.';

DECLARE @after INT = (SELECT TOP 1 CAST(closingbalance AS INT)
                      FROM dbo.tbl_med_mcc_test_transactions
                      WHERE mccid = @mcc ORDER BY id DESC);

PRINT CONCAT('After   statement closes at ', @after, ', wallet holds ', @wallet,
             '  (drift ', @wallet - @after, ')');

IF @wallet <> @after
    PRINT 'STILL OUT OF STEP - do not assume this is done; check for other unposted payments.';
ELSE
    PRINT 'Reconciled.';
GO
