/*
 * smart-report-historical-charge-20260924.sql
 *
 * Charges the two Smart Report lines from before script 151 (2026-09-21)
 * whose orders were received and reported, on Jas's instruction of
 * 2026-09-24: Shivani, UP1003, bill 26090001 of 2026-09-06 (₹99), and
 * Raman Deep, UP1020, bill 26090001 of 2026-09-09 (₹99). Through the same
 * usp_telo_charge_custom_lines the accession path uses, as the ordering
 * user, latched so it cannot repeat. Only these two patients: the third
 * pre-151 Smart Report (HR0032, bill 32085) has no sample and no test on
 * its patient and is not charged; the 108 MDCARE external lines stay as
 * Jas parked them.
 */
SET NOCOUNT ON;
SET XACT_ABORT ON;
DECLARE @n INT, @amt INT, @total INT = 0, @lines INT = 0;
DECLARE @p TABLE (patient_id INT, user_id INT);
INSERT INTO @p (patient_id, user_id)
SELECT c.patient_id, ISNULL(TRY_CONVERT(INT, SUBSTRING(c.created_by, CHARINDEX(':', c.created_by) + 1, 20)), 6593)
FROM dbo.telo_custom_test_order c
WHERE c.id IN (106, 119)
  AND NOT EXISTS (SELECT 1 FROM dbo.telo_custom_line_charge l WHERE l.bill_id = c.bill_id AND l.custom_test_id = c.custom_test_id);
DECLARE @pid INT, @uid INT;
DECLARE cur CURSOR LOCAL FAST_FORWARD FOR SELECT patient_id, user_id FROM @p;
OPEN cur; FETCH NEXT FROM cur INTO @pid, @uid;
WHILE @@FETCH_STATUS = 0
BEGIN
    BEGIN TRANSACTION;
    SET @n = 0; SET @amt = 0;
    EXEC dbo.usp_telo_charge_custom_lines @userId = @uid, @patientId = @pid, @origin = N'inf:',
         @charged = @n OUTPUT, @charge_total = @amt OUTPUT;
    COMMIT TRANSACTION;
    SET @lines = @lines + ISNULL(@n, 0); SET @total = @total + ISNULL(@amt, 0);
    FETCH NEXT FROM cur INTO @pid, @uid;
END
CLOSE cur; DEALLOCATE cur;
PRINT CONCAT('charged lines: ', @lines, ', rupees: ', @total);
