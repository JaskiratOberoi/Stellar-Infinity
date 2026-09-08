/*
 * 142_inf_report_nabl_override.sql
 *
 * A per-report NABL override: the SIDs listed here print the accreditation
 * mark on every test row and the medallion in the sign-off band, whatever
 * the catalogue says about the test.
 *
 * Why a table and not a catalogue edit: the request was for TWO reports,
 * once — HCV Quantitative PCR for 9692094 and 9692060 — and the test itself
 * is not accredited. Setting Nabl_Logo on the test would mark every HCV
 * report the lab has ever issued and every one to come; a one-time
 * decision needs a one-time record, with who asked and why.
 *
 * Read by usp_inf_report_by_sid (script 77), so every route that draws a
 * report — the download, the patient bundle, the on-screen viewer and the
 * QR copy — agrees. Idempotent: the table is created once, the seed rows
 * are inserted only while absent. To withdraw an override, delete its row.
 */
SET NOCOUNT ON;

IF OBJECT_ID('dbo.inf_report_nabl_override') IS NULL
BEGIN
    CREATE TABLE dbo.inf_report_nabl_override (
        sid        NVARCHAR(100) NOT NULL PRIMARY KEY,
        reason     NVARCHAR(200) NULL,
        created_by NVARCHAR(100) NULL,
        created_at DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME()
    );
    PRINT 'Created dbo.inf_report_nabl_override.';
END
ELSE
    PRINT 'dbo.inf_report_nabl_override already present.';
GO

INSERT INTO dbo.inf_report_nabl_override (sid, reason, created_by)
SELECT v.sid, N'One-time NABL mark on HCV Quantitative PCR, requested 2026-09-08', N'inf:6593'
FROM (VALUES (N'9692094'), (N'9692060')) v(sid)
WHERE NOT EXISTS (SELECT 1 FROM dbo.inf_report_nabl_override o WHERE o.sid = v.sid);
PRINT CONCAT('Override rows inserted: ', @@ROWCOUNT);
GO
