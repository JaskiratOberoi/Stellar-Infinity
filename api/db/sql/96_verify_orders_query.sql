/*
 * 96_verify_orders_query.sql
 *
 * READ-ONLY. Executes the exact shape of OrdersRepository's list, header, line,
 * receipt and sample queries against the live schema, so a wrong column or a
 * bad join fails here rather than on an operator's screen. Writes nothing.
 */
SET NOCOUNT ON;

DECLARE @bid INT, @n INT;

-- ---- list -----------------------------------------------------------------
SELECT TOP (5) @bid = b.id
FROM dbo.tbl_billing_patient_detail b
LEFT JOIN dbo.tbl_med_mcc_unit_master u ON u.id = b.mcc_code
ORDER BY b.id DESC;

IF @bid IS NULL
BEGIN
    PRINT 'No bills found — cannot validate the detail queries.';
    RETURN;
END
PRINT 'List query OK. Newest bill id = ' + CAST(@bid AS VARCHAR(20));

-- ---- header ---------------------------------------------------------------
DECLARE @patient INT, @name NVARCHAR(200), @client NVARCHAR(50), @by NVARCHAR(200);

SELECT
    @patient = TRY_CONVERT(INT, b.medid),
    @name    = b.patientname,
    @client  = u.MCCUnitCode,
    @by      = NULLIF(LTRIM(RTRIM(CONCAT(uu.firstname, ' ', uu.lastname))), '')
FROM dbo.tbl_billing_patient_detail b
LEFT JOIN dbo.tbl_med_mcc_unit_master u ON u.id = b.mcc_code
LEFT JOIN dbo.tbl_med_mcc_doctors  d ON d.id = b.ref_doctor
LEFT JOIN dbo.tbl_med_mcc_customer c ON c.id = b.ref_customer
LEFT JOIN dbo.tbl_med_mcc_patient_master p ON p.id = TRY_CONVERT(INT, b.medid)
LEFT JOIN dbo.tbl_med_user_master uu
       ON (b.addedby LIKE 'telo:%' OR b.addedby LIKE 'inf:%')
      AND uu.id = TRY_CONVERT(INT, SUBSTRING(b.addedby, CHARINDEX(':', b.addedby) + 1, 20))
WHERE b.id = @bid;

PRINT 'Header query OK. patient=' + ISNULL(CAST(@patient AS VARCHAR(20)), 'null')
    + '  client=' + ISNULL(@client, 'null')
    + '  registeredBy=' + ISNULL(@by, 'null');

-- ---- lines ----------------------------------------------------------------
SELECT @n = COUNT(*)
FROM dbo.tbl_billing_patient_test_detail d
LEFT JOIN dbo.telo_test_cancellation tc ON tc.line_id = d.id
WHERE d.billid = @bid;
PRINT 'Lines query OK. rows=' + CAST(@n AS VARCHAR(10));

-- ---- receipts -------------------------------------------------------------
SELECT @n = COUNT(*)
FROM dbo.tbl_billing_patient_amount_receipt r
LEFT JOIN dbo.telo_receipt_void v ON v.receipt_id = r.id
WHERE r.bill_id = @bid;
PRINT 'Receipts query OK. rows=' + CAST(@n AS VARCHAR(10));

-- ---- samples --------------------------------------------------------------
IF @patient IS NOT NULL
BEGIN
    SELECT @n = COUNT(*)
    FROM dbo.tbl_med_mcc_patient_samples s
    LEFT JOIN dbo.tbl_med_sample_master sm ON sm.id = s.sampleid
    LEFT JOIN dbo.tbl_med_mcc_patient_samples_status_master st ON st.id = s.sample_status
    WHERE s.patient_id = @patient;
    PRINT 'Samples query OK. rows=' + CAST(@n AS VARCHAR(10));
END
ELSE
    PRINT 'Samples query skipped (bill has no patient id in medid — a native LIS bill).';
GO
