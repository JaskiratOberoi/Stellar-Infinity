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
 * QR copy — agrees. Idempotent: the table is created once. Rows are added
 * by hand for the case in question and deleted to withdraw it; this script
 * seeds none, so a redeploy can never re-mark a report whose override was
 * withdrawn (the two SIDs above were marked once, on 2026-09-08, for PDFs
 * handed over that day, and then withdrawn the same day at the user's ask —
 * Infinity itself prints them unmarked).
 *
 * qr_only (added 2026-09-09, for SID 9540773): 1 confines the mark to the
 * patient's copy opened from the printed QR — the route that runs the report
 * procedure with @public = 1. The lab's own downloads and the on-screen
 * viewer keep printing the report as the catalogue has it, so the handed-over
 * PDF and the scan agree while nothing else about the SID changes. 0 marks
 * every route, as before.
 */
SET NOCOUNT ON;

IF OBJECT_ID('dbo.inf_report_nabl_override') IS NULL
BEGIN
    CREATE TABLE dbo.inf_report_nabl_override (
        sid        NVARCHAR(100) NOT NULL PRIMARY KEY,
        reason     NVARCHAR(200) NULL,
        created_by NVARCHAR(100) NULL,
        created_at DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME(),
        qr_only    BIT           NOT NULL DEFAULT 0
    );
    PRINT 'Created dbo.inf_report_nabl_override.';
END
ELSE
    PRINT 'dbo.inf_report_nabl_override already present.';
GO

IF COL_LENGTH('dbo.inf_report_nabl_override', 'qr_only') IS NULL
BEGIN
    ALTER TABLE dbo.inf_report_nabl_override ADD qr_only BIT NOT NULL DEFAULT 0;
    PRINT 'Added inf_report_nabl_override.qr_only.';
END
GO
