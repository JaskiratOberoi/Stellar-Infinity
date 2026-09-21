SET QUOTED_IDENTIFIER ON;
GO
/*
 * custom-line-charge-backfill-20260921.sql — charge the custom lines that were
 * billed before 151 and never reached a centre's account.
 *
 * As found on 2026-09-21 (every billed custom line, none ever charged):
 *   UP1003  Smart Report        1 line     ₹99
 *   HR0032  Smart Report        1 line     ₹99
 *   UP1020  Smart Report        1 line     ₹99
 *   MDCARE  Glucose - External  99 lines   ₹19,020   (Telo, since 3 July)
 *   MDCARE  VBG - External      9 lines    ₹11,800   (Telo, since 28 July)
 *
 * Posts each line through usp_telo_charge_custom_lines — the same rows,
 * balance update and latch a new order gets — dated today, under the user
 * running this. The centre's balance moves by the total; its statement
 * shows one row per line named after the extra and the patient.
 *
 * SAFETY: @apply = 0 (the default) only LISTS what would be charged. Set
 * @apply = 1 to post. @clients narrows the run to named client codes
 * (comma-separated); empty means every centre with uncharged lines. Lines
 * already latched are skipped, so the script can be re-run.
 */
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @apply   BIT = 0;            -- 1 to post
DECLARE @clients NVARCHAR(400) = N''; -- e.g. N'UP1003,HR0032,UP1020'
DECLARE @userId  INT = 6593;         -- Jas
DECLARE @origin  NVARCHAR(20) = N'inf:';

DECLARE @todo TABLE (seq INT IDENTITY(1,1) PRIMARY KEY, patient_id INT, client NVARCHAR(50), lines INT, amount INT);
INSERT INTO @todo (patient_id, client, lines, amount)
SELECT c.patient_id, u.MCCUnitCode, COUNT(*), SUM(c.unit_amount * c.qty)
FROM dbo.telo_custom_test_order c
JOIN dbo.tbl_med_mcc_patient_master pm ON pm.id = c.patient_id
LEFT JOIN dbo.tbl_med_mcc_unit_master u ON u.id = pm.mcc_code
WHERE c.bill_id > 0 AND c.unit_amount * c.qty > 0
  AND NOT EXISTS (SELECT 1 FROM dbo.telo_custom_line_charge l WHERE l.bill_id = c.bill_id AND l.custom_test_id = c.custom_test_id)
  AND (LTRIM(RTRIM(@clients)) = N'' OR u.MCCUnitCode IN (SELECT LTRIM(RTRIM(value)) FROM STRING_SPLIT(@clients, ',')))
GROUP BY c.patient_id, u.MCCUnitCode
ORDER BY u.MCCUnitCode, c.patient_id;

SELECT mode = CASE WHEN @apply = 1 THEN 'POSTING' ELSE 'DRY RUN' END, client, patients = COUNT(*), lines = SUM(lines), amount = SUM(amount)
FROM @todo GROUP BY client ORDER BY client;

IF @apply = 0 RETURN;

BEGIN TRAN;
DECLARE @i INT = 1, @n INT = (SELECT COUNT(*) FROM @todo), @pid INT, @c INT, @t INT, @sumC INT = 0, @sumT INT = 0;
WHILE @i <= @n
BEGIN
    SELECT @pid = patient_id FROM @todo WHERE seq = @i;
    EXEC dbo.usp_telo_charge_custom_lines @userId = @userId, @patientId = @pid, @origin = @origin,
         @charged = @c OUTPUT, @charge_total = @t OUTPUT;
    SET @sumC += ISNULL(@c, 0); SET @sumT += ISNULL(@t, 0);
    SET @i += 1;
END
COMMIT;

SELECT posted_lines = @sumC, posted_amount = @sumT;
SELECT l.mccid, u.MCCUnitCode AS client, COUNT(*) AS lines, SUM(l.amount) AS amount, MIN(l.charged_at) AS first_at, MAX(l.charged_at) AS last_at
FROM dbo.telo_custom_line_charge l LEFT JOIN dbo.tbl_med_mcc_unit_master u ON u.id = l.mccid
WHERE l.charged_at >= DATEADD(MINUTE, -5, GETDATE()) GROUP BY l.mccid, u.MCCUnitCode ORDER BY u.MCCUnitCode;
GO
