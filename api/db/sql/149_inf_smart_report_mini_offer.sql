/*
 * 149_inf_smart_report_mini_offer.sql
 *
 * The mini tier gets an introductory price BELOW its own list price. 148
 * set the mini price at ₹21; the lab's decision (2026-09-20) is that ₹21 is
 * what the booklet costs with a mini profile, and ₹11 is the introductory
 * offer shown against it — the form strikes ₹21 and bills ₹11 while the
 * offer is on. Ending the offer is setting offer_mrp to NULL: the row's mrp
 * then bills, and the chip loses its badge. Raising either is an UPDATE.
 *
 * Idempotent.
 */
SET NOCOUNT ON;

IF COL_LENGTH('dbo.inf_smart_report_mini', 'offer_mrp') IS NULL
BEGIN
    ALTER TABLE dbo.inf_smart_report_mini ADD offer_mrp INT NULL;
    PRINT 'Added inf_smart_report_mini.offer_mrp.';
END
GO

UPDATE dbo.inf_smart_report_mini SET offer_mrp = 11 WHERE offer_mrp IS NULL;
PRINT CONCAT('Introductory offer set on ', @@ROWCOUNT, ' row(s).');

SELECT kind, catalogue_id, code, name, mrp, offer_mrp FROM dbo.inf_smart_report_mini ORDER BY kind, catalogue_id;
GO
