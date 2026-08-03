/*
 * 97_verify_stats_query.sql
 *
 * READ-ONLY. Executes the exact shape of StatsRepository's dashboard query for
 * an unrestricted scope, and prints the results. Its job is to catch a wrong
 * column name or a bad join against the real legacy schema — the failure mode
 * that only shows up at runtime, on someone's dashboard.
 *
 * Run after changing the stats query. Writes nothing.
 */
SET NOCOUNT ON;

-- Confirm the void-ledger column the query depends on actually exists before
-- relying on it; the whole cash-flow figure silently depends on this name.
IF COL_LENGTH('dbo.telo_receipt_void', 'receipt_id') IS NULL
BEGIN
    DECLARE @cols NVARCHAR(MAX) = N'';
    SELECT @cols = @cols + c.COLUMN_NAME + N' '
    FROM INFORMATION_SCHEMA.COLUMNS c
    WHERE c.TABLE_SCHEMA = 'dbo' AND c.TABLE_NAME = 'telo_receipt_void';
    RAISERROR('telo_receipt_void has no receipt_id column. Actual columns: %s', 16, 1, @cols);
    RETURN;
END
PRINT 'telo_receipt_void.receipt_id present.';

DECLARE @d DATE = CAST(SYSDATETIME() AS DATE);
DECLARE @bills INT, @patients INT, @regs INT;
DECLARE @revenue DECIMAL(18,2), @outstanding DECIMAL(18,2), @discount DECIMAL(18,2);
DECLARE @cash DECIMAL(18,2), @other DECIMAL(18,2), @refunded DECIMAL(18,2);
DECLARE @statuses INT, @trendDays INT;

SELECT
    @bills       = (SELECT COUNT(*)                         FROM dbo.tbl_billing_patient_detail b WHERE CAST(b.bill_date AS DATE) = @d),
    @patients    = (SELECT COUNT(DISTINCT b.patientname)    FROM dbo.tbl_billing_patient_detail b WHERE CAST(b.bill_date AS DATE) = @d),
    @revenue     = (SELECT ISNULL(SUM(b.amount),0)          FROM dbo.tbl_billing_patient_detail b WHERE CAST(b.bill_date AS DATE) = @d),
    @outstanding = (SELECT ISNULL(SUM(b.Balance),0)         FROM dbo.tbl_billing_patient_detail b WHERE CAST(b.bill_date AS DATE) = @d),
    @discount    = (SELECT ISNULL(SUM(b.discount_amount),0) FROM dbo.tbl_billing_patient_detail b WHERE CAST(b.bill_date AS DATE) = @d),
    @regs        = (SELECT COUNT(*)                         FROM dbo.tbl_med_mcc_patient_master p WHERE CAST(p.sample_date AS DATE) = @d);

SELECT @statuses = COUNT(*) FROM (
    SELECT ISNULL(st.status, 'Unknown') AS status
    FROM dbo.tbl_med_mcc_patient_samples s
    JOIN dbo.tbl_med_mcc_patient_master p2 ON p2.id = s.patient_id
    LEFT JOIN dbo.tbl_med_mcc_patient_samples_status_master st ON st.id = s.sample_status
    WHERE CAST(s.addeddate AS DATE) = @d
    GROUP BY st.status
) x;

SELECT @trendDays = COUNT(*) FROM (
    SELECT CAST(b.bill_date AS DATE) AS d
    FROM dbo.tbl_billing_patient_detail b
    WHERE CAST(b.bill_date AS DATE) BETWEEN DATEADD(DAY,-6,@d) AND @d
    GROUP BY CAST(b.bill_date AS DATE)
) y;

SELECT
    @cash     = ISNULL(SUM(CASE WHEN r.receive_status = '1' AND r.pay_mode IS NOT NULL
                                 AND LOWER(r.pay_mode) LIKE '%cash%' THEN r.amount END),0),
    @other    = ISNULL(SUM(CASE WHEN r.receive_status = '1' AND (r.pay_mode IS NULL
                                 OR LOWER(r.pay_mode) NOT LIKE '%cash%') THEN r.amount END),0),
    @refunded = ISNULL(SUM(CASE WHEN r.receive_status = '2' THEN r.amount END),0)
FROM dbo.tbl_billing_patient_amount_receipt r
JOIN dbo.tbl_billing_patient_detail rb ON rb.id = r.bill_id
WHERE CAST(r.recd_date AS DATE) = @d
  AND NOT EXISTS (SELECT 1 FROM dbo.telo_receipt_void v WHERE v.receipt_id = r.id);

PRINT 'Stats query executed for ' + CONVERT(VARCHAR(10), @d, 23) + ' (lab-wide, unscoped):';
PRINT '  bills=' + CAST(@bills AS VARCHAR(20)) + '  patients=' + CAST(@patients AS VARCHAR(20))
    + '  registrations=' + CAST(@regs AS VARCHAR(20));
PRINT '  revenue=' + CAST(@revenue AS VARCHAR(30)) + '  outstanding=' + CAST(@outstanding AS VARCHAR(30))
    + '  discount=' + CAST(@discount AS VARCHAR(30));
PRINT '  cash=' + CAST(@cash AS VARCHAR(30)) + '  other=' + CAST(@other AS VARCHAR(30))
    + '  refunded=' + CAST(@refunded AS VARCHAR(30));
PRINT '  status buckets=' + CAST(@statuses AS VARCHAR(10)) + '  trend days with data=' + CAST(@trendDays AS VARCHAR(10));
GO
