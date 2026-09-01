/* =============================================================================
 * Infinity's own "Processed at" identity per business unit.
 *
 * tbl_med_business_unit_master row 1 — the Delhi HQ lab — carries placeholder
 * data ("QUGEN PATHLABS", address "ADDRESS"), and the legacy LIS never prints
 * from it: its Crystal reports hardcode "Noble Diagnostic , Hari Nagar, New
 * Delhi" (see E:\Listec Genomics MedCis.UI/Reports/ex.rpt). Correcting the
 * shared row is not Infinity's call — unknown LIS screens may read it — so,
 * like inf_test_attachment_override, the display identity lives in an
 * Infinity-only sidecar the LIS never touches.
 *
 * `accreditation` is printed ahead of the Processed-at line, matching the
 * LISTEC portal's footer: "MC-2547 NABL Accredited - Processed at : ...".
 * Only Delhi (BU 1) is NABL accredited today; other units gain a row here
 * if and when they are.
 *
 * Idempotent: the seed only inserts when the row is missing, so a manually
 * edited row survives a re-run.
 * ========================================================================== */

IF OBJECT_ID('dbo.inf_business_unit_footer', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.inf_business_unit_footer (
        business_unit_id INT           NOT NULL PRIMARY KEY,  -- tbl_med_business_unit_master.id
        display_name     NVARCHAR(200) NOT NULL,
        address          NVARCHAR(400) NULL,
        city             NVARCHAR(100) NULL,
        phone            NVARCHAR(50)  NULL,   -- a row replaces the identity outright: NULL = print no phone
        accreditation    NVARCHAR(200) NULL,   -- e.g. 'MC-2547 NABL Accredited'
        updated_at       DATETIME2(0)  NOT NULL CONSTRAINT DF_inf_bu_footer_at DEFAULT SYSDATETIME()
    );
END
GO

IF NOT EXISTS (SELECT 1 FROM dbo.inf_business_unit_footer WHERE business_unit_id = 1)
BEGIN
    INSERT INTO dbo.inf_business_unit_footer
        (business_unit_id, display_name, address, city, phone, accreditation)
    VALUES
        (1, N'Noble Diagnostic', N'Hari Nagar', N'New Delhi', NULL,
         N'MC-2547 NABL Accredited');
END
GO
