/*
 * smart-report-add-pid-3712160-20260923.sql
 *
 * Adds the Smart Report to a patient registered through the legacy LIS —
 * AJAZ KARIEM KHAN, PID 3712160, client JK0213 (unit 3002), Health Screen 2
 * — and charges the client ₹49 for it, on Jas's instruction (2026-09-23).
 *
 * Done the way an order would do it, not by hand: the shared order procedure
 * is called for the EXISTING patient with no tests and one custom line, which
 * is a custom-only order. It writes the bill header and the bill line the
 * LIS prints, the telo_custom_test_order row the booklet routes key on, the
 * B2B order tag, and — because a custom-only order has nothing to accession —
 * charges the centre's account at once through usp_telo_charge_custom_lines,
 * with the latch that stops it charging twice. ₹49 is the package-tier
 * introductory price in force (inf_smart_report_offer, till Diwali 2026).
 *
 * @apply = 0 runs everything and rolls it back, printing what would be
 * written. @apply = 1 commits.
 */
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @apply BIT = 0;   -- applied 2026-09-23; left at 0 so a re-run only dry-runs

DECLARE @userId INT = 6593;        -- Jas
DECLARE @mcc INT = 3002;           -- JK0213
DECLARE @pid INT = 3712160;
DECLARE @price INT = 49;

DECLARE @sids dbo.TeloSampleSid;
DECLARE @items dbo.TeloTestList;
DECLARE @pay dbo.TeloPayment;
DECLARE @custom dbo.TeloCustomLine;
INSERT INTO @custom (customTestId, code, name, unitAmount, qty, requiresMrd)
SELECT id, N'SMART-RPT', N'Smart Report', @price, 1, 0
FROM dbo.telo_custom_test WHERE code = N'SMART-RPT' AND is_active = 1;

IF NOT EXISTS (SELECT 1 FROM @custom)
BEGIN
    RAISERROR('SMART-RPT custom test not found.', 16, 1);
    RETURN;
END
IF EXISTS (SELECT 1 FROM dbo.telo_custom_test_order WHERE patient_id = @pid AND code IN (N'SMART-RPT', N'SMART-MINI'))
BEGIN
    RAISERROR('This patient already has a Smart Report line.', 16, 1);
    RETURN;
END

DECLARE @balBefore DECIMAL(18,2) = (SELECT currentbalance FROM dbo.tbl_med_mcc_account_master WHERE mcccode = @mcc);
DECLARE @msg NVARCHAR(400);

BEGIN TRANSACTION;

DECLARE @r TABLE (ok BIT, error_code VARCHAR(20), message NVARCHAR(400),
                  patient_id INT, bill_id INT, bill_number INT, total INT, sample_count INT);
-- The procedure returns two result sets; only the first is a row we need, and
-- INSERT ... EXEC cannot take two. It is captured from the tables instead.
EXEC dbo.usp_telo_create_order
     @userId = @userId, @mcc = @mcc, @sids = @sids, @patientId = @pid,
     @items = @items, @payments = @pay, @customLines = @custom,
     @billAtMrp = 1, @origin = N'inf:';

DECLARE @billId INT = (SELECT MAX(bill_id) FROM dbo.telo_custom_test_order WHERE patient_id = @pid AND code = N'SMART-RPT');
IF @billId IS NULL
BEGIN
    ROLLBACK TRANSACTION;
    RAISERROR('The order procedure wrote no Smart Report line — see its result set for the reason.', 16, 1);
    RETURN;
END

SELECT @msg = CONCAT('bill ', b.bill_number, ' (id ', b.id, ') amount ', b.amount, ' balance ', b.Balance,
                     ' | lines: ', (SELECT COUNT(*) FROM dbo.tbl_billing_patient_test_detail d WHERE d.billid = b.id),
                     ' | custom line: ', (SELECT TOP 1 CONCAT(code, ' ', unit_amount, 'x', qty) FROM dbo.telo_custom_test_order WHERE bill_id = b.id),
                     ' | kind: ', ISNULL((SELECT TOP 1 kind FROM dbo.telo_order_kind WHERE bill_id = b.id), 'none'),
                     ' | charged: ', ISNULL((SELECT TOP 1 CONCAT(amount, ' txn ', txn_id) FROM dbo.telo_custom_line_charge WHERE bill_id = b.id), 'NOT CHARGED'))
FROM dbo.tbl_billing_patient_detail b WHERE b.id = @billId;
PRINT @msg;

DECLARE @balAfter DECIMAL(18,2) = (SELECT currentbalance FROM dbo.tbl_med_mcc_account_master WHERE mcccode = @mcc);
PRINT CONCAT('JK0213 balance: ', @balBefore, ' -> ', @balAfter);
DECLARE @ledger NVARCHAR(200);
SELECT TOP 1 @ledger = CONCAT(tname, ' ', testcharges, ' on ', CONVERT(varchar(19), transdate, 120))
FROM dbo.tbl_med_mcc_test_transactions WHERE patientid = @pid AND tname LIKE N'Smart Report%' ORDER BY id DESC;
PRINT CONCAT('ledger: ', ISNULL(@ledger, 'no ledger row'));

IF @apply = 1
BEGIN
    COMMIT TRANSACTION;
    PRINT 'COMMITTED';
END
ELSE
BEGIN
    ROLLBACK TRANSACTION;
    PRINT 'DRY RUN — rolled back';
END
