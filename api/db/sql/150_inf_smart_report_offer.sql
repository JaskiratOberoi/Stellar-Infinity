/*
 * 150_inf_smart_report_offer.sql
 *
 * The Smart Report's introductory offers, DATED, one row per tier:
 *
 *   package  ₹99 list (telo_custom_test)      → ₹49 until Diwali 2026
 *   mini     ₹21 list (inf_smart_report_mini) → ₹11 until Diwali 2026
 *
 * Diwali 2026 is Sunday 8 November; the offer holds through that day and is
 * gone on the 9th. The lab's instruction (2026-09-21): both prices revert
 * to list "as soon as we pass by Diwali 2026" — so the date is data and the
 * code asks it, rather than anyone remembering to switch anything off. The
 * order form shows the list price struck through and the offer price with
 * an "Introductory offer" badge while a row is in date, and the plain list
 * price the morning after. Extending an offer is an UPDATE of offer_until;
 * ending it early is deleting the row or dating it yesterday.
 *
 * This table OWNS offers from here on. inf_smart_report_mini.offer_mrp (149)
 * is left as it is for the code already deployed, and is ignored by code
 * from this script onward; it is cleared once every stack reads from here.
 *
 * Idempotent.
 */
SET NOCOUNT ON;

IF OBJECT_ID('dbo.inf_smart_report_offer') IS NULL
BEGIN
    CREATE TABLE dbo.inf_smart_report_offer (
        tier        NVARCHAR(10)  NOT NULL PRIMARY KEY,   -- 'package' | 'mini'
        offer_mrp   INT           NOT NULL,
        offer_until DATE          NOT NULL,               -- last day the offer applies
        note        NVARCHAR(100) NULL,                   -- shown to the operator: "till Diwali 2026"
        created_by  NVARCHAR(100) NULL,
        created_at  DATETIME2     NOT NULL CONSTRAINT DF_inf_smart_report_offer_created DEFAULT (SYSUTCDATETIME()),
        CONSTRAINT CK_inf_smart_report_offer_tier CHECK (tier IN (N'package', N'mini'))
    );
    PRINT 'Created dbo.inf_smart_report_offer.';
END
GO

MERGE dbo.inf_smart_report_offer AS t
USING (VALUES
    (N'package', 49, CAST('2026-11-08' AS DATE), N'till Diwali 2026'),
    (N'mini',    11, CAST('2026-11-08' AS DATE), N'till Diwali 2026')
) AS s (tier, offer_mrp, offer_until, note)
ON t.tier = s.tier
WHEN MATCHED THEN UPDATE SET offer_mrp = s.offer_mrp, offer_until = s.offer_until, note = s.note
WHEN NOT MATCHED THEN INSERT (tier, offer_mrp, offer_until, note, created_by) VALUES (s.tier, s.offer_mrp, s.offer_until, s.note, N'inf:jas');
PRINT CONCAT('Offers written: ', @@ROWCOUNT);

SELECT tier, offer_mrp, offer_until, note FROM dbo.inf_smart_report_offer ORDER BY tier;
GO
