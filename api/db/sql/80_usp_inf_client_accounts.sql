/* QUOTED_IDENTIFIER is baked in at creation time; see script 70. */
SET QUOTED_IDENTIFIER ON;
GO
/*
 * 80_usp_inf_client_accounts.sql
 *
 * Phase 4: what each client owes, and the movements behind it.
 *
 * ── WHICH WAY IS UP ────────────────────────────────────────────────────────
 * tbl_med_mcc_account_master.currentbalance is the client's running account.
 * dbo.usp_telo_post_ledger DEBITS it when an order is placed (debit_flag = 1)
 * and dbo.usp_telo_record_mcc_payment CREDITS it when they pay (debit_flag = 0).
 *
 * So a NEGATIVE currentbalance means the client owes the lab, and a positive
 * one means they are in credit. That is the opposite of the intuitive reading,
 * which is exactly why every column here is named for what it means rather than
 * passed through raw — `owed` is positive when money is due, and the sign
 * flip happens once, here, instead of in three screens.
 *
 * Read-only.
 */
CREATE OR ALTER PROCEDURE dbo.usp_inf_client_accounts
    @client_codes dbo.ClientCodeList READONLY,
    @search       NVARCHAR(100) = NULL,
    -- 'owing' hides the clients who are square, which on 3,594 accounts is
    -- most of the screen.
    @only_owing   BIT           = 0,
    @page         INT           = 1,
    @page_size    INT           = 100
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

    DECLARE @codeCount INT = (SELECT COUNT(*) FROM @client_codes);

    ;WITH acct AS (
        SELECT
            u.id            AS mccId,
            u.MCCUnitCode   AS clientCode,
            u.MCCUnitName   AS clientName,
            isActive        = CAST(CASE WHEN ISNULL(u.IsActive, 0) = 1 THEN 1 ELSE 0 END AS BIT),
            balance         = ISNULL(a.currentbalance, 0),
            totalDeposited  = ISNULL(a.totaldeposited, 0),
            lastUpdatedAt   = a.lastupdateddate
        FROM dbo.tbl_med_mcc_unit_master u
        LEFT JOIN dbo.tbl_med_mcc_account_master a ON a.mcccode = u.id
        WHERE u.MCCUnitCode IS NOT NULL AND LTRIM(RTRIM(u.MCCUnitCode)) <> ''
          AND (@codeCount = 0
               OR EXISTS (SELECT 1 FROM @client_codes c WHERE c.code = u.MCCUnitCode))
          AND (@search IS NULL OR LTRIM(RTRIM(@search)) = ''
               OR u.MCCUnitCode LIKE '%' + @search + '%'
               OR u.MCCUnitName LIKE '%' + @search + '%')
    )
    SELECT
        mccId, clientCode, clientName, isActive, totalDeposited, lastUpdatedAt,
        -- Raw, for anyone reconciling against the LIS.
        balance,
        -- And the same number the way a person reads it: positive = they owe us.
        owed = -balance,
        COUNT(*) OVER() AS total_count
    FROM acct
    WHERE @only_owing = 0 OR balance < 0
    -- Biggest debt first: the list exists to be worked down.
    ORDER BY balance, clientCode
    OFFSET @offset ROWS FETCH NEXT @size ROWS ONLY;
END
GO

/*
 * The movements behind one client's balance.
 *
 * tbl_med_mcc_account_detail is append-only in practice — every order debits
 * and every payment credits — so this is the audit trail for the number above.
 */
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
        -- debit_flag = 1 is an order consuming credit; 0 is a payment in.
        direction = CASE WHEN ISNULL(d.debit_flag, 0) = 1 THEN 'debit' ELSE 'credit' END,
        d.Reason        AS note,
        d.chequeorddnummber AS reference,
        d.addedby,
        -- Which system posted it, so a mixed ledger is readable during the
        -- period both platforms are live.
        -- 'ccav:' is an ONLINE payment the client made themselves through the
        -- portal. It read as 'lis' before, which is the fallback for anything
        -- unrecognised — so every gateway payment looked like a clerk had
        -- keyed it into Listec.
        --
        -- Note what this cannot fix: Telo does not stamp its payments at all.
        -- usp_telo_record_mcc_payment takes an @origin, but Telo passes none,
        -- so its rows carry a bare username and are genuinely indistinguishable
        -- from Listec's. There are zero 'telo:%' rows in the table. Until Telo
        -- passes @origin = 'telo:', payments made there will keep reading as
        -- 'lis', and no change on this side can tell them apart.
        origin = CASE WHEN d.addedby LIKE 'inf:%'  THEN 'infinity'
                      WHEN d.addedby LIKE 'ccav:%' THEN 'online'
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
