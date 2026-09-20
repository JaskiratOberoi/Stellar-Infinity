/*
 * 148_inf_smart_report_mini.sql
 *
 * The "mini profiles" the Smart Report is sold with at an INTRODUCTORY price
 * — ₹21 instead of the ₹99 it costs with an HR health package (144).
 *
 * The booklet was built for the HR packages, but a patient who came for one
 * small profile — a liver panel, a blood count, an HbA1c — gets a coherent
 * booklet of just that chapter, and the lab wants to see whether centres will
 * take it at a nominal price. So: sold with the profiles and tests listed
 * here, on B2B orders, at the price in this table. The price is data because
 * the lab expects to raise it on demand; changing it is one UPDATE, and the
 * form and the bill follow.
 *
 * Kinds are the order form's own: 'profile' (tbl_med_test_profile_master.id)
 * or 'test' (tbl_med_test_master.id). CBC and HbA1c are single parameterised
 * tests in the catalogue, not profiles, which is why both kinds are needed.
 *
 * Seeded with the eight the lab named on 2026-09-20: KFT (CP116), LFT
 * (CP107), CBC (HE011), CBC with ESR (CBES1), HbA1c (BI127), Iron Profile
 * (GP12), Vitamin Profile (CP143) and Anemia Profile (CP102). The Anemia
 * Profile is inactive in the catalogue and so cannot be ordered today; it is
 * listed so that it is covered the day the lab reactivates it — nothing here
 * touches the catalogue itself.
 *
 * Read by CustomTestRepository (third result set) and checked again at
 * placement. An order carrying one of the HR packages is priced by 144
 * (₹99) even when a mini profile is also present. Idempotent.
 */
SET NOCOUNT ON;

IF OBJECT_ID('dbo.inf_smart_report_mini') IS NULL
BEGIN
    CREATE TABLE dbo.inf_smart_report_mini (
        kind         NVARCHAR(10)  NOT NULL,   -- 'profile' | 'test'
        catalogue_id INT           NOT NULL,
        code         NVARCHAR(50)  NULL,
        name         NVARCHAR(200) NULL,
        mrp          INT           NOT NULL CONSTRAINT DF_inf_smart_report_mini_mrp DEFAULT (21),
        created_by   NVARCHAR(100) NULL,
        created_at   DATETIME2     NOT NULL CONSTRAINT DF_inf_smart_report_mini_created DEFAULT (SYSUTCDATETIME()),
        CONSTRAINT PK_inf_smart_report_mini PRIMARY KEY (kind, catalogue_id),
        CONSTRAINT CK_inf_smart_report_mini_kind CHECK (kind IN (N'profile', N'test'))
    );
    PRINT 'Created dbo.inf_smart_report_mini.';
END
GO

INSERT INTO dbo.inf_smart_report_mini (kind, catalogue_id, code, name, mrp, created_by)
SELECT N'profile', p.id, LTRIM(RTRIM(p.Profile_Code)), LTRIM(RTRIM(p.Profile_Name)), 21, N'inf:jas'
FROM dbo.tbl_med_test_profile_master p
WHERE p.id IN (16, 8, 82, 25, 50, 3)
  AND NOT EXISTS (SELECT 1 FROM dbo.inf_smart_report_mini m WHERE m.kind = N'profile' AND m.catalogue_id = p.id);
PRINT CONCAT('Seeded ', @@ROWCOUNT, ' profile(s).');

INSERT INTO dbo.inf_smart_report_mini (kind, catalogue_id, code, name, mrp, created_by)
SELECT N'test', t.id, LTRIM(RTRIM(t.TestCode)), LTRIM(RTRIM(t.Testname)), 21, N'inf:jas'
FROM dbo.tbl_med_test_master t
WHERE t.id IN (233, 291)
  AND NOT EXISTS (SELECT 1 FROM dbo.inf_smart_report_mini m WHERE m.kind = N'test' AND m.catalogue_id = t.id);
PRINT CONCAT('Seeded ', @@ROWCOUNT, ' test(s).');

SELECT kind, catalogue_id, code, name, mrp FROM dbo.inf_smart_report_mini ORDER BY kind, catalogue_id;
GO
