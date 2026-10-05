/*
 * mdcare-rerate-bills-20261005b.sql - second batch of the MDCARE re-rate of
 * 2026-10-05 (see mdcare-rerate-bills-20261005.sql for the method, which is
 * identical): the seven items of mdcare-rates-20261005b.sql, on every
 * MDCARE bill dated on/after 1 September 2026 that carries one at the old
 * price - invoice line, order line, header; a settled bill takes the delta
 * as collected (receipt dated the bill); the account ledger rows at the old
 * price re-rated and the running balance shifted after them. Nothing before
 * 1 September. Backups: inf_mdcare_rerate_backup_20261005b_*.
 */
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @mcc INT = 5797;
DECLARE @from DATETIME = '2026-09-01';
DECLARE @by NVARCHAR(50) = N'inf:6593';
DECLARE @now DATETIME = GETDATE();

DECLARE @items TABLE (code NVARCHAR(20) PRIMARY KEY, tname NVARCHAR(100), old_price INT, new_price INT);
INSERT INTO @items VALUES
    (N'BI068', N'CEA - Carcino embryonic antigen (Serum)',                      770, 1100),
    (N'CP114', N'Thyroid Profile I',                                             500,  550),
    (N'GP12',  N'IRON PROFILE',                                                  500,  550),
    (N'GTT3N', N'Glucose Tolerance Test GTT 75 gms Glucose  3 Samples NEW',     250,  275),
    (N'BI090', N'CREATININE - 24 HR URINE',                                      165,  330),
    (N'BI046', N'Bilirubin (Total Direct & Indirect )',                          220,  330),
    (N'GP10',  N'TORCH IgM',                                                    1000, 1100);

/* ---- the lines to move -------------------------------------------------- */
DECLARE @lines TABLE (line_id INT PRIMARY KEY, bill_id INT, patient_id INT, code NVARCHAR(20), delta INT);
INSERT INTO @lines (line_id, bill_id, patient_id, code, delta)
SELECT d.id, b.id, b.medid, i.code, i.new_price - i.old_price
FROM dbo.tbl_billing_patient_detail b
JOIN dbo.tbl_billing_patient_test_detail d ON d.billid = b.id
JOIN @items i ON i.code = LTRIM(RTRIM(d.testcode)) AND d.testamount = i.old_price
WHERE b.mcc_code = @mcc AND b.bill_date >= @from;

DECLARE @bills TABLE (bill_id INT PRIMARY KEY, delta INT, was_settled BIT);
INSERT INTO @bills (bill_id, delta, was_settled)
SELECT l.bill_id, SUM(l.delta), CASE WHEN b.Balance = 0 THEN 1 ELSE 0 END
FROM @lines l JOIN dbo.tbl_billing_patient_detail b ON b.id = l.bill_id
GROUP BY l.bill_id, b.Balance;

/* ---- the ledger rows to move ------------------------------------------- */
DECLARE @tx TABLE (tx_id INT PRIMARY KEY, delta INT);
INSERT INTO @tx (tx_id, delta)
SELECT t.id, i.new_price - i.old_price
FROM dbo.tbl_med_mcc_test_transactions t
JOIN @items i ON i.tname = t.tname AND t.testcharges = i.old_price
WHERE t.mccid = @mcc AND t.transdate >= @from;

DECLARE @nLines INT = (SELECT COUNT(*) FROM @lines), @nBills INT = (SELECT COUNT(*) FROM @bills),
        @nTx INT = (SELECT COUNT(*) FROM @tx), @txDelta INT = ISNULL((SELECT SUM(delta) FROM @tx), 0),
        @firstTx INT = (SELECT MIN(tx_id) FROM @tx);

IF @nLines = 0 AND @nTx = 0
BEGIN
    SELECT N'Nothing at the old price - already applied.' AS note;
    RETURN;
END

/* The account's running balance must agree with the ledger's last closing
   before it is shifted, or the shift would be applied to a figure the ledger
   does not explain. */
DECLARE @acct INT = (SELECT currentbalance FROM dbo.tbl_med_mcc_account_master WHERE mcccode = @mcc);
DECLARE @lastClosing INT = (SELECT TOP 1 closingbalance FROM dbo.tbl_med_mcc_test_transactions WHERE mccid = @mcc ORDER BY id DESC);
IF @nTx > 0 AND @acct <> @lastClosing
    THROW 50000, 'Account balance and ledger closing disagree; stop.', 1;

/* ---- backups ------------------------------------------------------------ */
IF OBJECT_ID('dbo.inf_mdcare_rerate_backup_20261005b_lines') IS NULL
BEGIN
    SELECT CAST(d.id AS INT) AS id, d.billid, d.mcccode, d.testcode, d.testname, d.testamount, d.testtype, d.ref_amount, @now AS taken_at
    INTO dbo.inf_mdcare_rerate_backup_20261005b_lines
    FROM dbo.tbl_billing_patient_test_detail d JOIN @lines l ON l.line_id = d.id;

    SELECT CAST(t.id AS INT) AS id, t.patient_id, t.test_id, t.test_code, t.test_name, t.test_rate, t.updatedby, t.updateddate, @now AS taken_at
    INTO dbo.inf_mdcare_rerate_backup_20261005b_orders
    FROM dbo.tbl_med_mcc_patient_tests t
    WHERE EXISTS (SELECT 1 FROM @lines l JOIN @items i ON i.code = l.code
                  WHERE l.patient_id = t.patient_id AND LTRIM(RTRIM(t.test_code)) = i.code AND t.test_rate = i.old_price);

    SELECT CAST(b.id AS INT) AS id, b.bill_number, b.bill_date, b.amount, b.discount_amount, b.amount_paid, b.Balance,
           b.payment_type, b.updatedby, b.updateddate, @now AS taken_at
    INTO dbo.inf_mdcare_rerate_backup_20261005b_bills
    FROM dbo.tbl_billing_patient_detail b JOIN @bills x ON x.bill_id = b.id;

    SELECT CAST(t.id AS INT) AS id, t.mccid, t.transdate, t.currentbalance, t.testcharges, t.closingbalance, t.tname, t.vailid, t.patientid, @now AS taken_at
    INTO dbo.inf_mdcare_rerate_backup_20261005b_ledger
    FROM dbo.tbl_med_mcc_test_transactions t
    WHERE t.mccid = @mcc AND @firstTx IS NOT NULL AND t.id >= @firstTx;

    SELECT CAST(a.id AS INT) AS id, a.mcccode, a.totaldeposited, a.currentbalance, a.lastupdatedby, a.lastupdateddate, @now AS taken_at
    INTO dbo.inf_mdcare_rerate_backup_20261005b_account
    FROM dbo.tbl_med_mcc_account_master a WHERE a.mcccode = @mcc;
END

BEGIN TRAN;

/* 1. invoice lines */
UPDATE d SET d.testamount = d.testamount + l.delta
FROM dbo.tbl_billing_patient_test_detail d JOIN @lines l ON l.line_id = d.id;

/* 2. order lines (the patient's booked tests) */
UPDATE t SET t.test_rate = i.new_price, t.updatedby = @by, t.updateddate = @now
FROM dbo.tbl_med_mcc_patient_tests t
JOIN @items i ON i.code = LTRIM(RTRIM(t.test_code)) AND t.test_rate = i.old_price
WHERE EXISTS (SELECT 1 FROM @lines l WHERE l.patient_id = t.patient_id AND l.code = i.code);
DECLARE @nOrders INT = @@ROWCOUNT;

/* 4. settled bills: the delta is collected, receipt dated the bill */
INSERT INTO dbo.tbl_billing_patient_amount_receipt (bill_id, recd_date, amount, receivedby, receive_status, pay_mode, card_number)
SELECT b.id, b.bill_date, x.delta, @by, '1', ISNULL(NULLIF(LTRIM(RTRIM(b.payment_type)), ''), 'Cash'), NULL
FROM @bills x JOIN dbo.tbl_billing_patient_detail b ON b.id = x.bill_id
WHERE x.was_settled = 1;
DECLARE @nReceipts INT = @@ROWCOUNT;

/* 3. bill headers */
UPDATE b SET
    b.amount      = b.amount + x.delta,
    b.amount_paid = b.amount_paid + CASE WHEN x.was_settled = 1 THEN x.delta ELSE 0 END,
    b.Balance     = (b.amount + x.delta) - ISNULL(b.discount_amount, 0) - (b.amount_paid + CASE WHEN x.was_settled = 1 THEN x.delta ELSE 0 END),
    b.updatedby   = @by,
    b.updateddate = @now
FROM dbo.tbl_billing_patient_detail b JOIN @bills x ON x.bill_id = b.id;

/* 5. the ledger: the charged rows, then every row from the first of them on,
      shifted by the deltas at or before it. */
IF @nTx > 0
BEGIN
    UPDATE t SET
        t.testcharges    = t.testcharges + ISNULL(x.delta, 0),
        t.currentbalance = t.currentbalance - ISNULL(s.before_me, 0),
        t.closingbalance = t.closingbalance - ISNULL(s.before_me, 0) - ISNULL(x.delta, 0)
    FROM dbo.tbl_med_mcc_test_transactions t
    LEFT JOIN @tx x ON x.tx_id = t.id
    OUTER APPLY (SELECT SUM(delta) AS before_me FROM @tx WHERE tx_id < t.id) s
    WHERE t.mccid = @mcc AND t.id >= @firstTx;

    UPDATE dbo.tbl_med_mcc_account_master
    SET currentbalance = currentbalance - @txDelta, lastupdatedby = @by, lastupdateddate = @now
    WHERE mcccode = @mcc;
END

COMMIT;

SELECT @nLines AS invoice_lines, @nOrders AS order_lines, @nBills AS bills, @nReceipts AS receipts_added,
       (SELECT SUM(delta) FROM @lines) AS bill_delta, @nTx AS ledger_rows, @txDelta AS ledger_delta,
       (SELECT currentbalance FROM dbo.tbl_med_mcc_account_master WHERE mcccode = @mcc) AS account_now,
       (SELECT TOP 1 closingbalance FROM dbo.tbl_med_mcc_test_transactions WHERE mccid = @mcc ORDER BY id DESC) AS ledger_closing_now;
