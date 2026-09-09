/*
 * nabl-override-9540773-20260909.sql
 *
 * One-off NABL mark for SID 9540773 (Mr SHAKRUDDIN, HCV Quantitative PCR),
 * asked for on 2026-09-09 "with QR support": unlike the 2026-09-08 pair, this
 * row STAYS, so the QR copy, the viewer and every download of this report
 * print the mark the handed-over PDF carries. Delete the row to withdraw.
 * See 142_inf_report_nabl_override.sql for the table and the reasoning.
 */
SET NOCOUNT ON;

IF NOT EXISTS (SELECT 1 FROM dbo.inf_report_nabl_override WHERE sid = N'9540773')
BEGIN
    INSERT INTO dbo.inf_report_nabl_override (sid, reason, created_by)
    VALUES (N'9540773', N'One-off NABL mark on HCV Quant PCR report, incl. QR copy (user request 2026-09-09)', N'inf:jas');
    PRINT 'Override added for 9540773.';
END
ELSE
    PRINT 'Override for 9540773 already present.';

SELECT sid, reason, created_by, created_at FROM dbo.inf_report_nabl_override ORDER BY created_at;
