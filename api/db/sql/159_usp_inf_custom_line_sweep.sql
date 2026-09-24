SET QUOTED_IDENTIFIER ON;
GO
/*
 * 159_usp_inf_custom_line_sweep.sql
 *
 * The charge for a custom line (the Smart Report) is posted to the centre's
 * account when the order's first sample is registered — by
 * usp_telo_accession_samples (④b, Infinity and Telo) — or at placement for
 * a custom-only order. The legacy LIS's own Register button knows nothing
 * of custom lines: an order booked in Infinity with a Smart Report and
 * received at the bench through the LIS was charged for its tests and never
 * for the booklet. Two such lines (UP1005, JK0239) were found on 2026-09-24
 * with their tests charged and the extra not.
 *
 * This sweep closes that gap without touching the LIS: every patient with an
 * unlatched custom line whose sample the lab has received is charged now,
 * through the same usp_telo_charge_custom_lines the accession path uses —
 * same account rule, same ledger row, same latch — as the user who placed
 * the order. Each patient is its own transaction so one failure cannot hold
 * the rest. Lines from before 2026-09-21 (script 151) are left alone by
 * default: those 111 historical lines are a decision Jas has parked, not an
 * oversight. Infinity's API runs this every ten minutes (CustomLineSweep).
 */
CREATE OR ALTER PROCEDURE dbo.usp_inf_custom_line_sweep
    @since        DATE = '2026-09-21',
    @charged      INT  = 0 OUTPUT,
    @charge_total INT  = 0 OUTPUT,
    @patients     INT  = 0 OUTPUT
AS
BEGIN
    SET NOCOUNT ON;
    SET @charged = 0; SET @charge_total = 0; SET @patients = 0;

    DECLARE @due TABLE (patient_id INT PRIMARY KEY, user_id INT NOT NULL);
    INSERT INTO @due (patient_id, user_id)
    SELECT c.patient_id,
           -- The order's own user, from the 'inf:1234' / 'telo:1234' marker;
           -- a demo or otherwise unnumbered marker falls back to Jas.
           MAX(CASE WHEN c.created_by LIKE '%:[0-9]%' AND c.created_by NOT LIKE '%:[0-9]%[^0-9]%'
                    THEN TRY_CONVERT(INT, SUBSTRING(c.created_by, CHARINDEX(':', c.created_by) + 1, 20)) END)
    FROM dbo.telo_custom_test_order c
    WHERE c.bill_id > 0
      AND c.unit_amount * c.qty > 0
      AND c.created_at >= @since
      AND NOT EXISTS (SELECT 1 FROM dbo.telo_custom_line_charge l
                      WHERE l.bill_id = c.bill_id AND l.custom_test_id = c.custom_test_id)
      AND EXISTS (SELECT 1 FROM dbo.tbl_med_mcc_patient_samples s
                  WHERE s.patient_id = c.patient_id AND s.sample_status > 1)
    GROUP BY c.patient_id;

    UPDATE @due SET user_id = 6593 WHERE user_id IS NULL OR user_id <= 0;

    DECLARE @pid INT, @uid INT, @n INT, @amt INT;
    DECLARE cur CURSOR LOCAL FAST_FORWARD FOR SELECT patient_id, user_id FROM @due;
    OPEN cur;
    FETCH NEXT FROM cur INTO @pid, @uid;
    WHILE @@FETCH_STATUS = 0
    BEGIN
        BEGIN TRY
            BEGIN TRANSACTION;
            SET @n = 0; SET @amt = 0;
            EXEC dbo.usp_telo_charge_custom_lines
                 @userId = @uid, @patientId = @pid, @origin = N'inf:',
                 @charged = @n OUTPUT, @charge_total = @amt OUTPUT;
            COMMIT TRANSACTION;
            SET @charged = @charged + ISNULL(@n, 0);
            SET @charge_total = @charge_total + ISNULL(@amt, 0);
            IF ISNULL(@n, 0) > 0 SET @patients = @patients + 1;
        END TRY
        BEGIN CATCH
            IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
            -- Logged for the operator; the next patient still gets charged.
            PRINT CONCAT('custom-line sweep: patient ', @pid, ' failed: ', ERROR_MESSAGE());
        END CATCH
        FETCH NEXT FROM cur INTO @pid, @uid;
    END
    CLOSE cur; DEALLOCATE cur;
END
GO
