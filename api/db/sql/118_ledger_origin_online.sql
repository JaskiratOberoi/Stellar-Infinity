/*
 * 118_ledger_origin_online.sql
 *
 * Stop labelling our own gateway payments as LIS.
 *
 * The ledger derives "posted by" from the addedby prefix, and the CASE knew
 * two: 'inf:%' and 'telo:%'. Everything else fell through to 'lis', which was
 * a fair default when those were the only two systems writing.
 *
 * Then the CCAvenue integration started stamping 'ccav:', deliberately - a
 * payment the CUSTOMER made through the gateway is not the same event as an
 * operator recording one in Infinity, and the prefix is what keeps them apart
 * in the data. The ledger just had no name for it, so every online payment
 * this system took was attributed to Listec on the one screen a centre reads
 * to check its own account.
 *
 * 'online' rather than 'infinity' on purpose. Infinity minted the intent, but
 * nobody here posted anything: the centre paid, and the honest answer to "who
 * posted this" is the gateway. Folding it into 'infinity' would lose the one
 * distinction the separate prefix exists to preserve.
 *
 * Everything else is byte-identical to 80_usp_inf_client_accounts.sql. The
 * signature especially: the API binds @page and @page_size by name, and a
 * rename here would break the ledger rather than relabel it.
 */
SET QUOTED_IDENTIFIER ON;
SET ANSI_NULLS ON;
GO

CREATE OR ALTER PROCEDURE dbo.usp_inf_client_ledger
    @mcc       INT,
    @page      INT = 1,
    @page_size INT = 100
AS
BEGIN
    SET NOCOUNT ON;
    SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;

    DECLARE @pageSafe INT = CASE WHEN @page < 1 THEN 1 ELSE @page END;
    DECLARE @size INT =
        CASE WHEN @page_size < 1 THEN 100
             WHEN @page_size > 1000 THEN 1000
             ELSE @page_size END;
    DECLARE @offset INT = (@pageSafe - 1) * @size;

    SELECT
        d.id,
        d.depositedate  AS occurredAt,
        d.amount,
        direction = CASE WHEN ISNULL(d.debit_flag, 0) = 1 THEN 'debit' ELSE 'credit' END,
        d.Reason        AS note,
        d.chequeorddnummber AS reference,
        d.addedby,
        -- Which system posted it, so a mixed ledger is readable during the
        -- period both platforms are live.
        --
        -- 'ccav:' is its own value rather than folded into 'infinity': the
        -- customer paid through the gateway, which is a different event from
        -- an operator recording a payment in Infinity.
        origin = CASE WHEN d.addedby LIKE 'ccav:%' THEN 'online'
                      WHEN d.addedby LIKE 'inf:%'  THEN 'infinity'
                      WHEN d.addedby LIKE 'telo:%' THEN 'telo'
                      ELSE 'lis' END,
        d.addeddate     AS postedAt,
        COUNT(*) OVER() AS total_count
    FROM dbo.tbl_med_mcc_account_detail d
    WHERE d.mcccode = @mcc
    -- id as the tiebreak: several movements can share a timestamp, and without
    -- it OFFSET paging would repeat one and drop another.
    ORDER BY d.depositedate DESC, d.id DESC
    OFFSET @offset ROWS FETCH NEXT @size ROWS ONLY;
END
GO

PRINT 'usp_inf_client_ledger: ccav: now reads as online.';
GO
