/*
 * 95_verify_worksheet_sp.sql
 *
 * READ-ONLY. Validates the LIS worksheet procedures Infinity calls directly
 * (rather than via Telo's Listec HTTP bridge), and proves the TVP variant
 * actually executes. Writes nothing.
 *
 * The TVP variant is the one that matters: report scope is a SET of client
 * codes, and the single-code procedure would force one execution per code —
 * Telo fans out exactly that way, which does not survive an admin with
 * thousands of codes.
 */
SET NOCOUNT ON;

PRINT 'usp_listec_worksheet_report_by_codes parameters:';
DECLARE @p NVARCHAR(MAX) = N'';
SELECT @p = @p + '  ' + p.name + ' ' + t.name
                + CASE WHEN p.is_readonly = 1 THEN ' READONLY (TVP)' ELSE '' END + CHAR(10)
FROM sys.parameters p
JOIN sys.types t ON t.user_type_id = p.user_type_id
WHERE p.object_id = OBJECT_ID('dbo.usp_listec_worksheet_report_by_codes')
ORDER BY p.parameter_id;
PRINT @p;

-- Execute it for real against a couple of live client codes, so a wrong
-- parameter name or TVP shape fails here rather than in the API.
DECLARE @codes dbo.ClientCodeList;
INSERT INTO @codes (code)
SELECT TOP (2) u.MCCUnitCode
FROM dbo.tbl_med_mcc_unit_master u
WHERE u.MCCUnitCode IS NOT NULL AND LTRIM(RTRIM(u.MCCUnitCode)) <> ''
ORDER BY u.id;

DECLARE @sample NVARCHAR(200) = (SELECT STRING_AGG(code, ', ') FROM @codes);
PRINT 'Executing for codes: ' + ISNULL(@sample, '(none)');

CREATE TABLE #ws (
    client_code NVARCHAR(50), business_unit NVARCHAR(50), pid INT,
    patient_name NVARCHAR(200), sex VARCHAR(6), age INT, age_unit VARCHAR(8),
    sid NVARCHAR(50), sample_drawn DATETIME, regd_at DATETIME, last_modified_at DATETIME,
    status_code INT, status NVARCHAR(50), test_names_csv VARCHAR(1000),
    order_number VARCHAR(100), bill_number VARCHAR(50), sample_comments VARCHAR(500),
    clinical_history VARCHAR(500), tat DATETIME, results_json NVARCHAR(MAX)
);

INSERT INTO #ws
EXEC dbo.usp_listec_worksheet_report_by_codes
     @from_date = '2026-07-01',
     @to_date   = '2026-08-03',
     @client_codes = @codes,
     @page = 1,
     @page_size = 5;

DECLARE @rows INT = (SELECT COUNT(*) FROM #ws);
PRINT 'Executed OK. rows returned = ' + CAST(@rows AS VARCHAR(10));

IF @rows > 0
BEGIN
    DECLARE @s NVARCHAR(200), @st NVARCHAR(50), @json INT;
    SELECT TOP 1 @s = sid, @st = status, @json = LEN(ISNULL(results_json, '')) FROM #ws;
    PRINT '  sample row: sid=' + ISNULL(@s,'null') + ' status=' + ISNULL(@st,'null')
        + ' results_json length=' + CAST(ISNULL(@json,0) AS VARCHAR(20));
END

DROP TABLE #ws;
GO
