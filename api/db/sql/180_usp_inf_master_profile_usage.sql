/* QUOTED_IDENTIFIER is baked in at creation time; see script 70. */
SET QUOTED_IDENTIFIER ON;
GO
/*
 * 180 — who orders a package. The "Used by" panel in the Master profile
 * editor (Jas, 2026-10-07): the legacy portal has no screen that takes a
 * package and lists the client codes ordering it — only per-client sales
 * pages to scan by eye. Every order line records the package id and the
 * patient's centre, so this is one read.
 *
 *   @id     the package (tbl_med_test_master_profile_master.id)
 *   @since  count order lines on/after this date; NULL = all time
 */
CREATE OR ALTER PROCEDURE dbo.usp_inf_master_profile_usage
    @id    INT,
    @since DATETIME = NULL
AS
BEGIN
    SET NOCOUNT ON;
    SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;

    SELECT client_code   = u.MCCUnitCode,
           client_name   = u.MCCUnitName,
           orders        = COUNT(*),
           first_ordered = MIN(t.addeddate),
           last_ordered  = MAX(t.addeddate)
    FROM dbo.tbl_med_mcc_patient_tests t
    JOIN dbo.tbl_med_mcc_patient_master p ON p.id = t.patient_id
    JOIN dbo.tbl_med_mcc_unit_master u ON u.id = p.mcc_code
    WHERE t.test_type = N'Master' AND t.test_id = @id
      AND (@since IS NULL OR t.addeddate >= @since)
    GROUP BY u.MCCUnitCode, u.MCCUnitName
    ORDER BY COUNT(*) DESC, MAX(t.addeddate) DESC;
END
GO
