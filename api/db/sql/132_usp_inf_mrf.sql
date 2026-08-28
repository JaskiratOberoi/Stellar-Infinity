/*
 * 132_usp_inf_mrf.sql — the Material Request Form, written into the LIS's own
 * inventory tables.
 *
 * MRF is ALIVE in the LIS — 218 requests this year, 740 open right now — and
 * the lab processes them there: approval sets order_status 2 and fills
 * approved_qty, dispatch sets 3 with issued qty/date and a docket. So
 * Infinity does NOT get its own request store; a request raised here lands in
 * tbl_inventory_client_request_master / _form exactly as the legacy page
 * writes it (status 1 OPEN, one line per item, rate frozen from the
 * catalogue at request time), and the lab's existing workflow picks it up
 * with no idea which platform typed it. Same doctrine as orders.
 *
 * Item validation is the catalogue itself: an item id that is not an active
 * vendor-1 product does not exist for this form, whatever the caller sends.
 * The rate is read HERE, not accepted from the caller — a client does not
 * price its own consumables.
 */
SET QUOTED_IDENTIFIER ON;
SET ANSI_NULLS ON;
GO

CREATE OR ALTER PROCEDURE dbo.usp_inf_mrf_create
    @mcc       INT,
    @userId    INT,
    /* JSON: [{"itemId":32,"qty":5}, …] */
    @itemsJson NVARCHAR(MAX)
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE @items TABLE (item_id INT NOT NULL, qty INT NOT NULL);
    INSERT INTO @items (item_id, qty)
    SELECT j.itemId, j.qty
    FROM OPENJSON(@itemsJson) WITH (itemId INT '$.itemId', qty INT '$.qty') j
    WHERE j.itemId IS NOT NULL AND j.qty IS NOT NULL AND j.qty > 0;

    IF NOT EXISTS (SELECT 1 FROM @items)
    BEGIN
        SELECT ok = CAST(0 AS BIT), error_code = 'EMPTY',
               message = N'A material request needs at least one item.', id = CAST(NULL AS INT);
        RETURN;
    END

    -- Every item must be a live catalogue product; naming the first bad id
    -- beats a silent partial request.
    DECLARE @badItem INT = (
        SELECT TOP 1 i.item_id FROM @items i
        WHERE NOT EXISTS (
            SELECT 1 FROM dbo.tbl_inventory_vendor_product_master p
            WHERE p.id = i.item_id AND p.vendor_code = 1 AND ISNULL(p.isactive, 1) = 1));
    IF @badItem IS NOT NULL
    BEGIN
        SELECT ok = CAST(0 AS BIT), error_code = 'BAD_ITEM',
               message = CONCAT(N'Item ', @badItem, N' is not in the catalogue.'), id = CAST(NULL AS INT);
        RETURN;
    END

    BEGIN TRAN;

    DECLARE @now DATETIME = GETDATE();
    INSERT INTO dbo.tbl_inventory_client_request_master (pcc_id, order_date, order_status)
    VALUES (@mcc, @now, 1);
    DECLARE @reqId INT = SCOPE_IDENTITY();

    INSERT INTO dbo.tbl_inventory_client_request_form
        (request_id, pcc_code, item_code, order_qty, item_rate, order_date, status)
    SELECT @reqId, @mcc, i.item_id, i.qty,
           -- Frozen at request time, as the legacy form does. The catalogue
           -- price is a MONEY-ish decimal and the legacy column is INT; the
           -- legacy page rounds the same way by assignment.
           CONVERT(INT, ROUND(ISNULL(p.price, 0), 0)),
           @now, 1
    FROM @items i
    JOIN dbo.tbl_inventory_vendor_product_master p ON p.id = i.item_id;

    COMMIT;

    SELECT ok = CAST(1 AS BIT), error_code = CAST(NULL AS VARCHAR(20)),
           message = CAST(NULL AS NVARCHAR(200)), id = @reqId;
END
GO

/*
 * Cancel — the one state change a CLIENT may make, and only on its own OPEN
 * request. The legacy page lets a client edit/delete while open; a cancelled
 * status (4) beats a hard delete because the lab's own screens already list
 * CANCELLED, and a request that vanishes tells the storekeeper nothing.
 */
CREATE OR ALTER PROCEDURE dbo.usp_inf_mrf_cancel
    @mcc    INT,
    @userId INT,
    @id     INT
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE @status INT = (
        SELECT order_status FROM dbo.tbl_inventory_client_request_master
        WHERE id = @id AND pcc_id = @mcc);

    IF @status IS NULL
    BEGIN
        SELECT ok = CAST(0 AS BIT), error_code = 'NOT_FOUND',
               message = N'No such request for this centre.';
        RETURN;
    END
    IF @status <> 1
    BEGIN
        SELECT ok = CAST(0 AS BIT), error_code = 'NOT_OPEN',
               message = N'Only an open request can be cancelled — this one has already been '
                       + CASE @status WHEN 2 THEN N'approved.' WHEN 3 THEN N'dispatched.' ELSE N'cancelled.' END;
        RETURN;
    END

    BEGIN TRAN;
    UPDATE dbo.tbl_inventory_client_request_master SET order_status = 4 WHERE id = @id;
    UPDATE dbo.tbl_inventory_client_request_form   SET status = 4 WHERE request_id = @id;
    COMMIT;

    SELECT ok = CAST(1 AS BIT), error_code = CAST(NULL AS VARCHAR(20)), message = CAST(NULL AS NVARCHAR(200));
END
GO
