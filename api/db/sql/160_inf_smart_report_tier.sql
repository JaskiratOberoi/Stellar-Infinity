/*
 * 160_inf_smart_report_tier.sql
 *
 * The Smart Report's three price tiers, named and priced in one place, as
 * Jas set them on 2026-09-24:
 *
 *   mini     ₹21 list / ₹11 offer   ONE supported single test on the order
 *   multi    ₹49 list / ₹25 offer   TWO OR MORE supported single tests,
 *                                   however many more are added
 *   package  ₹99 list / ₹49 offer   a supported profile (LFT, KFT, CBC with
 *                                   ESR, iron, vitamins, anemia) or an HR
 *                                   health package on the order
 *
 * Each tier bills as its own line so the legacy LIS bill and the client
 * ledger name what was bought: SMART-MINI "Smart Report - Mini", SMART-MULT
 * "Smart Report - Multi", SMART-RPT "Smart Report". Which tier an order
 * earns is decided at placement (CustomTest.BilledAs) from the cart: a
 * package or a supported profile wins over any count of single tests.
 *
 * The supported items stay in inf_smart_report_mini (148, 158): 'profile'
 * rows now price at the PACKAGE tier and their own mrp column is no longer
 * read; 'test' rows count towards mini or multi. The offers stay in
 * inf_smart_report_offer (150) with a third row for multi. Idempotent.
 */
SET NOCOUNT ON;
IF OBJECT_ID('dbo.inf_smart_report_tier') IS NULL
BEGIN
    CREATE TABLE dbo.inf_smart_report_tier (
        tier       NVARCHAR(10)  NOT NULL CONSTRAINT PK_inf_smart_report_tier PRIMARY KEY,
        code       NVARCHAR(10)  NOT NULL,   -- the bill line's test code (LEFT 10 is what the bill table matches)
        name       NVARCHAR(200) NOT NULL,
        list_mrp   INT           NOT NULL,
        created_at DATETIME2     NOT NULL CONSTRAINT DF_inf_smart_report_tier_created DEFAULT (SYSUTCDATETIME()),
        CONSTRAINT CK_inf_smart_report_tier CHECK (tier IN (N'mini', N'multi', N'package'))
    );
    PRINT 'Created dbo.inf_smart_report_tier.';
END
GO
MERGE dbo.inf_smart_report_tier AS t
USING (VALUES (N'mini',    N'SMART-MINI', N'Smart Report - Mini',  21),
              (N'multi',   N'SMART-MULT', N'Smart Report - Multi', 49),
              (N'package', N'SMART-RPT',  N'Smart Report',         99)) AS s (tier, code, name, list_mrp)
ON t.tier = s.tier
WHEN MATCHED THEN UPDATE SET code = s.code, name = s.name, list_mrp = s.list_mrp
WHEN NOT MATCHED THEN INSERT (tier, code, name, list_mrp) VALUES (s.tier, s.code, s.name, s.list_mrp);

-- The offer table (150) allowed two tiers; it now allows the third.
IF EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_inf_smart_report_offer_tier')
    ALTER TABLE dbo.inf_smart_report_offer DROP CONSTRAINT CK_inf_smart_report_offer_tier;
ALTER TABLE dbo.inf_smart_report_offer WITH CHECK ADD CONSTRAINT CK_inf_smart_report_offer_tier
    CHECK (tier IN (N'mini', N'multi', N'package'));
GO
MERGE dbo.inf_smart_report_offer AS o
USING (VALUES (N'multi', 25, CAST('2026-11-08' AS DATE), N'till Diwali 2026', N'inf:jas')) AS s (tier, offer_mrp, offer_until, note, created_by)
ON o.tier = s.tier
WHEN MATCHED THEN UPDATE SET offer_mrp = s.offer_mrp, offer_until = s.offer_until, note = s.note
WHEN NOT MATCHED THEN INSERT (tier, offer_mrp, offer_until, note, created_by) VALUES (s.tier, s.offer_mrp, s.offer_until, s.note, s.created_by);
GO
SELECT t.tier, t.code, t.name, t.list_mrp, o.offer_mrp, CONVERT(varchar(10), o.offer_until, 23) AS offer_until
FROM dbo.inf_smart_report_tier t LEFT JOIN dbo.inf_smart_report_offer o ON o.tier = t.tier ORDER BY t.list_mrp;
GO
