/*
 * nabl-override-9540773-20260909.sql
 *
 * One-off NABL mark for SID 9540773 (Mr SHAKRUDDIN, HCV Quantitative PCR),
 * asked for on 2026-09-09: the handed-over without-letterhead PDF carries the
 * mark, and the patient's copy behind that PDF's QR must agree with it. The
 * lab's own downloads from the portal and the on-screen viewer print the
 * report unmarked, as the catalogue has it — hence qr_only = 1 (script 142).
 * Delete the row to withdraw.
 */
SET NOCOUNT ON;

IF NOT EXISTS (SELECT 1 FROM dbo.inf_report_nabl_override WHERE sid = N'9540773')
BEGIN
    INSERT INTO dbo.inf_report_nabl_override (sid, reason, created_by, qr_only)
    VALUES (N'9540773', N'One-off NABL mark on HCV Quant PCR report, QR copy only (user request 2026-09-09)', N'inf:jas', 1);
    PRINT 'Override added for 9540773 (QR copy only).';
END
ELSE
BEGIN
    UPDATE dbo.inf_report_nabl_override
       SET qr_only = 1,
           reason  = N'One-off NABL mark on HCV Quant PCR report, QR copy only (user request 2026-09-09)'
     WHERE sid = N'9540773';
    PRINT 'Override for 9540773 set to QR copy only.';
END

SELECT sid, reason, created_by, created_at, qr_only FROM dbo.inf_report_nabl_override ORDER BY created_at;
