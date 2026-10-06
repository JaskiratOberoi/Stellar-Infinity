/*
 * lkr0236-walkin-to-b2b-20261006.sql - three LKR0236 orders booked on the
 * walk-in channel by the lab front desk (AJAYLKW, 5 Oct 2026) become client
 * (B2B) orders, on Jas's instruction of 2026-10-06.
 *
 *   bill 35242  KIRAN       Thyroid Profile I
 *   bill 35243  J. K VERMA  Lipid, CRP, Creatinine, HbA1c
 *   bill 35244  SANJU       Vitamin D, Calcium, B12
 *
 * They were client orders in everything but the tag: priced at LKR0236's
 * contract rates and charged to its account at accessioning. What the
 * walk-in channel added was a patient bill with half collected in cash,
 * whose unpaid half held the reports. Tagging the bills b2b makes the
 * report lock read the centre's account (in credit) instead of the bill.
 * The cash receipts stay on record untouched; whether that money is
 * refunded or moved to the account is Jas's call. Re-runnable.
 */
SET NOCOUNT ON;
IF OBJECT_ID('dbo.inf_lkr0236_backup_order_kind_20261006') IS NULL
    SELECT CAST(bill_id AS INT) AS bill_id, kind, SYSUTCDATETIME() AS taken_at
    INTO dbo.inf_lkr0236_backup_order_kind_20261006
    FROM dbo.telo_order_kind WHERE bill_id IN (35242, 35243, 35244);

INSERT INTO dbo.telo_order_kind (bill_id, kind)
SELECT b.id, N'b2b'
FROM dbo.tbl_billing_patient_detail b
WHERE b.id IN (35242, 35243, 35244) AND b.mcc_code = 6088
  AND NOT EXISTS (SELECT 1 FROM dbo.telo_order_kind k WHERE k.bill_id = b.id);

SELECT k.bill_id, k.kind FROM dbo.telo_order_kind k WHERE k.bill_id IN (35242, 35243, 35244);
