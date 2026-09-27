/*
 * smart-report-add-pid-3728683-20260927.sql
 *
 * Adds the Smart Report to a patient registered through the legacy LIS —
 * MS KHUSHI, PID 3728683, SIDs 9789114–9789117, client HR0383 CLINICAL
 * LABORTAORY (unit 2910) — on Jas's instruction (2026-09-27). The order is
 * the ROHTAK HR203A health package, which the booklet is sold with, so this
 * is the PACKAGE tier: "Smart Report", ₹99 list, ₹49 on the introductory
 * offer in force (inf_smart_report_offer, till Diwali 2026).
 *
 * Done the way an order would do it, not by hand: the shared order procedure
 * is called for the EXISTING patient with no tests and one custom line, which
 * is a custom-only order. It writes the bill header and the bill line the
 * LIS prints, the telo_custom_test_order row the booklet routes key on, the
 * B2B order tag, and — because a custom-only order has nothing to accession —
 * charges the centre's account at once through usp_telo_charge_custom_lines,
 * with the latch that stops it charging twice.
 *
 * @apply = 0 runs everything and rolls it back, printing what would be
 * written. @apply = 1 commits.
 */
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @apply BIT = 0;   -- applied 2026-09-27; left at 0 so a re-run only dry-runs (and the guard refuses a second line)

DECLARE @userId INT = 6593;        -- Jas
DECLARE @mcc INT = 2910;           -- HR0383
DECLARE @pid INT = 3728683;
DECLARE @price INT = 49;

IF NOT EXISTS (SELECT 1 FROM dbo.tbl_med_mcc_patient_master WHERE id = @pid AND mcc_code = @mcc)
BEGIN
    RAISERROR('Patient/centre mismatch.', 16, 1);
    RETURN;
END
IF NOT EXISTS (SELECT 1 FROM dbo.tbl_med_mcc_patient_tests t JOIN dbo.inf_smart_report_package k ON k.master_profile_id = t.test_id
               WHERE t.patient_id = @pid AND t.test_type = 'Master')
BEGIN
    RAISERROR('The order carries no supported package — not the package tier.', 16, 1);
    RETURN;
END

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
IF EXISTS (SELECT 1 FROM dbo.telo_custom_test_order WHERE patient_id = @pid AND code IN (N'SMART-RPT', N'SMART-MINI', N'SMART-MULT'))
BEGIN
    RAISERROR('This patient already has a Smart Report line.', 16, 1);
    RETURN;
END

DECLARE @balBefore DECIMAL(18,2) = (SELECT currentbalance FROM dbo.tbl_med_mcc_account_master WHERE mcccode = @mcc);
DECLARE @msg NVARCHAR(400);

BEGIN TRANSACTION;

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
PRINT CONCAT('HR0383 balance: ', @balBefore, ' -> ', @balAfter);
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
