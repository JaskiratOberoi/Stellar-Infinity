/*
 * 152_client_ledger_shows_charges.sql
 *
 * The client ledger listed payments only. Its source, tbl_med_mcc_account_detail,
 * is where money IN is recorded (and where the old LIS posted bill debits);
 * the charges that actually move a centre's balance today — every test at
 * accessioning, and since 151 every custom line — are posted by
 * sp_mcc_test_account_101 into tbl_med_mcc_test_transactions and never
 * appeared here. So a centre read a balance that fell by ₹386 and a ledger
 * that showed nothing, and could not reconcile the two.
 *
 * Now both feeds are one ledger: account_detail rows as before, plus one
 * debit per test_transactions row — named after the test or extra and the
 * patient, referenced by patient id, attributed to whichever product posted
 * it where that is knowable (a custom line's latch carries the origin; a
 * test charge carries only a user id, which reads as 'lis'). Charge rows
 * carry a NEGATIVE id so they cannot collide with detail ids in the API's
 * keying, and paging orders the union by time then id, as before.
 *
 * Signature unchanged: the API binds @page and @page_size by name.
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

    ;WITH movements AS (
        SELECT
            d.id,
            d.depositedate  AS occurredAt,
            CAST(d.amount AS DECIMAL(18, 2)) AS amount,
            direction = CASE WHEN ISNULL(d.debit_flag, 0) = 1 THEN 'debit' ELSE 'credit' END,
            d.Reason        AS note,
            d.chequeorddnummber AS reference,
            d.addedby,
            origin = CASE WHEN d.addedby LIKE 'ccav:%' THEN 'online'
                          WHEN d.addedby LIKE 'inf:%'  THEN 'infinity'
                          WHEN d.addedby LIKE 'telo:%' THEN 'telo'
                          ELSE 'lis' END,
            d.addeddate     AS postedAt
        FROM dbo.tbl_med_mcc_account_detail d
        WHERE d.mcccode = @mcc
        UNION ALL
        SELECT
            -x.id,
            x.transdate,
            CAST(x.testcharges AS DECIMAL(18, 2)),
            'debit',
            note = LEFT(CONCAT(ISNULL(x.tname, N''), CASE WHEN ISNULL(x.vailid, N'') = N'' THEN N'' ELSE N' · ' + x.vailid END), 200),
            reference = CASE WHEN x.patientid IS NULL THEN NULL ELSE CONCAT(N'PID ', x.patientid) END,
            addedby = ISNULL(l.charged_by, CONCAT(N'user:', x.userid)),
            origin = CASE WHEN l.charged_by LIKE 'inf:%'  THEN 'infinity'
                          WHEN l.charged_by LIKE 'telo:%' THEN 'telo'
                          ELSE 'lis' END,
            x.transdate
        FROM dbo.tbl_med_mcc_test_transactions x
        LEFT JOIN dbo.telo_custom_line_charge l ON l.txn_id = x.id
        WHERE x.mccid = @mcc AND ISNULL(x.testcharges, 0) <> 0
    )
    SELECT m.id, m.occurredAt, m.amount, m.direction, m.note, m.reference, m.addedby, m.origin, m.postedAt,
           COUNT(*) OVER() AS total_count
    FROM movements m
    -- id as the tiebreak: several movements can share a timestamp, and without
    -- it OFFSET paging would repeat one and drop another.
    ORDER BY m.occurredAt DESC, m.id DESC
    OFFSET @offset ROWS FETCH NEXT @size ROWS ONLY;
END
GO

PRINT 'usp_inf_client_ledger: charges from tbl_med_mcc_test_transactions now listed as debits.';
