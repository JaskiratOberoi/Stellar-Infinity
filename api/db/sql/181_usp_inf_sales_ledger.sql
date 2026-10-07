/* QUOTED_IDENTIFIER is baked in at creation time; see script 70. */
SET QUOTED_IDENTIFIER ON;
GO
/*
 * 181_usp_inf_sales_ledger.sql — the company-wide sales ledger and its
 * dashboard (Jas, 2026-10-07).
 *
 * A SALE LINE is what the LIS and the per-client Sales page call one: an
 * amount-checked test row (tbl_med_mcc_patient_tests.amount_checked = 1)
 * dated by its updateddate — the day the lab received and charged the tube
 * — at the rate the centre was charged (test_rate); plus the charged custom
 * lines (the Smart Report and the external items), dated by the ledger row
 * that charged them. The lab's Lab-sales figure on the dashboard is the sum
 * of exactly these, so the ledger adds up to it. A package order is ONE
 * line of kind Master at the package rate; its members are not lines.
 *
 * Both procedures take the same filters and build the same temp table of
 * lines, then page it (ledger) or group it (summary).
 *
 *   @from, @to   dates, inclusive; capped at 366 days
 *   @client      client code or name, contains
 *   @bu          business unit id of the CENTRE (tbl_med_mcc_unit_master.BusinessUnitCode)
 *   @kind        Master | Profile | Test | Extra, or NULL for all
 *   @search      item code or name, patient name, or PID, contains
 *   @source      lis | infinity | telo (where the patient was registered), or NULL
 */
CREATE OR ALTER PROCEDURE dbo.usp_inf_sales_ledger
    @from      DATE,
    @to        DATE,
    @client    NVARCHAR(100) = NULL,
    @bu        INT = NULL,
    @kind      NVARCHAR(10) = NULL,
    @search    NVARCHAR(100) = NULL,
    @source    NVARCHAR(10) = NULL,
    @page      INT = 1,
    @page_size INT = 100
AS
BEGIN
    SET NOCOUNT ON;
    SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;
    IF @to < @from SET @to = @from;
    IF DATEDIFF(DAY, @from, @to) > 366 SET @from = DATEADD(DAY, -366, @to);
    IF @page < 1 SET @page = 1;
    IF @page_size < 1 OR @page_size > 1000 SET @page_size = 100;
    DECLARE @c NVARCHAR(100) = NULLIF(LTRIM(RTRIM(@client)), N'');
    DECLARE @q NVARCHAR(100) = NULLIF(LTRIM(RTRIM(@search)), N'');
    DECLARE @k NVARCHAR(10) = NULLIF(LTRIM(RTRIM(@kind)), N'');
    DECLARE @s NVARCHAR(10) = NULLIF(LOWER(LTRIM(RTRIM(@source))), N'');
    DECLARE @until DATETIME = DATEADD(DAY, 1, @to);

    SELECT * INTO #lines FROM (
        SELECT sold_at = t.updateddate, line_id = t.id, kind = t.test_type, item_id = t.test_id,
               code = LTRIM(RTRIM(t.test_code)), name = t.test_name, amount = CAST(ISNULL(t.test_rate, 0) AS DECIMAL(18, 2)),
               pid = p.id, patient = p.name, client_code = u.MCCUnitCode, client_name = u.MCCUnitName,
               bu_id = u.BusinessUnitCode,
               source = CASE WHEN p.addedby LIKE N'inf:%' THEN N'infinity' WHEN p.addedby LIKE N'telo:%' THEN N'telo' ELSE N'lis' END,
               charged_by = t.updatedby
        FROM dbo.tbl_med_mcc_patient_tests t
        JOIN dbo.tbl_med_mcc_patient_master p ON p.id = t.patient_id
        JOIN dbo.tbl_med_mcc_unit_master u ON u.id = p.mcc_code
        WHERE t.amount_checked = 1 AND t.updateddate >= @from AND t.updateddate < @until
          AND (@k IS NULL OR (@k <> N'Extra' AND t.test_type = @k))
        UNION ALL
        SELECT x.transdate, c.id, N'Extra', c.custom_test_id,
               c.code, c.name, CAST(c.unit_amount * c.qty AS DECIMAL(18, 2)),
               p.id, p.name, u.MCCUnitCode, u.MCCUnitName, u.BusinessUnitCode,
               CASE WHEN p.addedby LIKE N'inf:%' THEN N'infinity' WHEN p.addedby LIKE N'telo:%' THEN N'telo' ELSE N'lis' END,
               l.charged_by
        FROM dbo.telo_custom_test_order c
        JOIN dbo.telo_custom_line_charge l ON l.bill_id = c.bill_id AND l.custom_test_id = c.custom_test_id
        JOIN dbo.tbl_med_mcc_test_transactions x ON x.id = l.txn_id
        JOIN dbo.tbl_med_mcc_patient_master p ON p.id = c.patient_id
        JOIN dbo.tbl_med_mcc_unit_master u ON u.id = p.mcc_code
        WHERE x.transdate >= @from AND x.transdate < @until
          AND (@k IS NULL OR @k = N'Extra')
    ) z
    WHERE (@c IS NULL OR z.client_code LIKE N'%' + @c + N'%' OR z.client_name LIKE N'%' + @c + N'%')
      AND (@bu IS NULL OR z.bu_id = @bu)
      AND (@s IS NULL OR z.source = @s)
      AND (@q IS NULL OR z.code LIKE N'%' + @q + N'%' OR z.name LIKE N'%' + @q + N'%'
           OR z.patient LIKE N'%' + @q + N'%' OR CAST(z.pid AS NVARCHAR(20)) = @q);

    -- 1. the page, newest first
    SELECT l.sold_at, l.line_id, l.kind, l.item_id, l.code, l.name, l.amount,
           mrp = CASE l.kind
                   WHEN N'Test'    THEN (SELECT m.MRP FROM dbo.tbl_med_test_master m WHERE m.id = l.item_id)
                   WHEN N'Profile' THEN (SELECT m.MRP FROM dbo.tbl_med_test_profile_master m WHERE m.id = l.item_id)
                   WHEN N'Master'  THEN (SELECT m.MRP FROM dbo.tbl_med_test_master_profile_master m WHERE m.id = l.item_id)
                   ELSE NULL END,
           l.pid, l.patient, l.client_code, l.client_name, l.bu_id,
           bu_code = (SELECT b.BusinessUnitCode FROM dbo.tbl_med_business_unit_master b WHERE b.id = l.bu_id),
           sid = (SELECT TOP 1 s.vailid FROM dbo.tbl_med_mcc_patient_samples s WHERE s.patient_id = l.pid ORDER BY s.id),
           l.source, l.charged_by
    FROM #lines l
    ORDER BY l.sold_at DESC, l.line_id DESC
    OFFSET (@page - 1) * @page_size ROWS FETCH NEXT @page_size ROWS ONLY;

    -- 2. the whole filter's totals
    SELECT lines = COUNT(*), amount = ISNULL(SUM(amount), 0),
           clients = COUNT(DISTINCT client_code), patients = COUNT(DISTINCT pid)
    FROM #lines;

    DROP TABLE #lines;
END
GO

CREATE OR ALTER PROCEDURE dbo.usp_inf_sales_summary
    @from      DATE,
    @to        DATE,
    @client    NVARCHAR(100) = NULL,
    @bu        INT = NULL,
    @kind      NVARCHAR(10) = NULL,
    @search    NVARCHAR(100) = NULL,
    @source    NVARCHAR(10) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;
    IF @to < @from SET @to = @from;
    IF DATEDIFF(DAY, @from, @to) > 366 SET @from = DATEADD(DAY, -366, @to);
    DECLARE @c NVARCHAR(100) = NULLIF(LTRIM(RTRIM(@client)), N'');
    DECLARE @q NVARCHAR(100) = NULLIF(LTRIM(RTRIM(@search)), N'');
    DECLARE @k NVARCHAR(10) = NULLIF(LTRIM(RTRIM(@kind)), N'');
    DECLARE @s NVARCHAR(10) = NULLIF(LOWER(LTRIM(RTRIM(@source))), N'');
    DECLARE @until DATETIME = DATEADD(DAY, 1, @to);

    SELECT * INTO #lines FROM (
        SELECT sold_at = t.updateddate, kind = t.test_type, item_id = t.test_id,
               code = LTRIM(RTRIM(t.test_code)), name = t.test_name, amount = CAST(ISNULL(t.test_rate, 0) AS DECIMAL(18, 2)),
               pid = p.id, patient = p.name, client_code = u.MCCUnitCode, client_name = u.MCCUnitName,
               bu_id = u.BusinessUnitCode,
               source = CASE WHEN p.addedby LIKE N'inf:%' THEN N'infinity' WHEN p.addedby LIKE N'telo:%' THEN N'telo' ELSE N'lis' END
        FROM dbo.tbl_med_mcc_patient_tests t
        JOIN dbo.tbl_med_mcc_patient_master p ON p.id = t.patient_id
        JOIN dbo.tbl_med_mcc_unit_master u ON u.id = p.mcc_code
        WHERE t.amount_checked = 1 AND t.updateddate >= @from AND t.updateddate < @until
          AND (@k IS NULL OR (@k <> N'Extra' AND t.test_type = @k))
        UNION ALL
        SELECT x.transdate, N'Extra', c.custom_test_id,
               c.code, c.name, CAST(c.unit_amount * c.qty AS DECIMAL(18, 2)),
               p.id, p.name, u.MCCUnitCode, u.MCCUnitName, u.BusinessUnitCode,
               CASE WHEN p.addedby LIKE N'inf:%' THEN N'infinity' WHEN p.addedby LIKE N'telo:%' THEN N'telo' ELSE N'lis' END
        FROM dbo.telo_custom_test_order c
        JOIN dbo.telo_custom_line_charge l ON l.bill_id = c.bill_id AND l.custom_test_id = c.custom_test_id
        JOIN dbo.tbl_med_mcc_test_transactions x ON x.id = l.txn_id
        JOIN dbo.tbl_med_mcc_patient_master p ON p.id = c.patient_id
        JOIN dbo.tbl_med_mcc_unit_master u ON u.id = p.mcc_code
        WHERE x.transdate >= @from AND x.transdate < @until
          AND (@k IS NULL OR @k = N'Extra')
    ) z
    WHERE (@c IS NULL OR z.client_code LIKE N'%' + @c + N'%' OR z.client_name LIKE N'%' + @c + N'%')
      AND (@bu IS NULL OR z.bu_id = @bu)
      AND (@s IS NULL OR z.source = @s)
      AND (@q IS NULL OR z.code LIKE N'%' + @q + N'%' OR z.name LIKE N'%' + @q + N'%'
           OR z.patient LIKE N'%' + @q + N'%' OR CAST(z.pid AS NVARCHAR(20)) = @q);

    -- 1. totals
    SELECT lines = COUNT(*), amount = ISNULL(SUM(amount), 0),
           clients = COUNT(DISTINCT client_code), patients = COUNT(DISTINCT pid),
           days = DATEDIFF(DAY, @from, @to) + 1
    FROM #lines;

    -- 2. by day (every day in the range, zero where nothing sold)
    ;WITH d AS (
        SELECT CAST(@from AS DATE) AS day
        UNION ALL SELECT DATEADD(DAY, 1, day) FROM d WHERE day < @to
    )
    SELECT d.day, lines = COUNT(l.pid), amount = ISNULL(SUM(l.amount), 0), patients = COUNT(DISTINCT l.pid)
    FROM d LEFT JOIN #lines l ON CAST(l.sold_at AS DATE) = d.day
    GROUP BY d.day ORDER BY d.day
    OPTION (MAXRECURSION 400);

    -- 3. by business unit (of the centre)
    SELECT bu_id = l.bu_id, bu_code = b.BusinessUnitCode, bu_name = b.BusinessUnitName,
           lines = COUNT(*), amount = SUM(l.amount), clients = COUNT(DISTINCT l.client_code)
    FROM #lines l LEFT JOIN dbo.tbl_med_business_unit_master b ON b.id = l.bu_id
    GROUP BY l.bu_id, b.BusinessUnitCode, b.BusinessUnitName
    ORDER BY SUM(l.amount) DESC;

    -- 4. by client, top 40
    SELECT TOP 40 client_code, client_name, lines = COUNT(*), amount = SUM(amount), patients = COUNT(DISTINCT pid)
    FROM #lines GROUP BY client_code, client_name ORDER BY SUM(amount) DESC;

    -- 5. by kind
    SELECT kind, lines = COUNT(*), amount = SUM(amount)
    FROM #lines GROUP BY kind ORDER BY SUM(amount) DESC;

    -- 6. by item, top 40
    SELECT TOP 40 kind, code, name = MAX(name), lines = COUNT(*), amount = SUM(amount),
           min_rate = MIN(amount), max_rate = MAX(amount), clients = COUNT(DISTINCT client_code)
    FROM #lines GROUP BY kind, code ORDER BY SUM(amount) DESC;

    -- 7. by source
    SELECT source, lines = COUNT(*), amount = SUM(amount)
    FROM #lines GROUP BY source ORDER BY SUM(amount) DESC;

    -- 8. item × client × rate — which client sold which item at what rate,
    --    top 300 by amount; the "customised" cut Jas asked for, meant with
    --    the kind filter on Master.
    SELECT TOP 300 kind, code, name = MAX(name), client_code, client_name = MAX(client_name),
           rate = amount, lines = COUNT(*), amount = SUM(amount)
    FROM #lines GROUP BY kind, code, client_code, amount ORDER BY SUM(amount) DESC, client_code;

    DROP TABLE #lines;
END
GO
