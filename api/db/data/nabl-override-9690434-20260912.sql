/*
 * nabl-override-9690434-20260912.sql
 *
 * One-off NABL mark for SID 9690434 (Mr NAUSHAD, HCV Quantitative PCR,
 * centre UPMB1000), asked for on 2026-09-12 with QR support: the handed-over
 * PDFs carry the mark, and the patient's copy behind their QR must agree.
 * qr_only = 1, as for 9540773 on 2026-09-09: the lab's own downloads and the
 * viewer print the report unmarked, as the catalogue has it. Delete the row
 * to withdraw. See 142_inf_report_nabl_override.sql.
 */
SET NOCOUNT ON;

IF NOT EXISTS (SELECT 1 FROM dbo.inf_report_nabl_override WHERE sid = N'9690434')
BEGIN
    INSERT INTO dbo.inf_report_nabl_override (sid, reason, created_by, qr_only)
    VALUES (N'9690434', N'One-off NABL mark on HCV Quant PCR report, QR copy only (user request 2026-09-12)', N'inf:jas', 1);
    PRINT 'Override added for 9690434 (QR copy only).';
END
ELSE
BEGIN
    UPDATE dbo.inf_report_nabl_override SET qr_only = 1 WHERE sid = N'9690434';
    PRINT 'Override for 9690434 already present; set to QR copy only.';
END

SELECT sid, reason, created_by, created_at, qr_only FROM dbo.inf_report_nabl_override ORDER BY created_at;
