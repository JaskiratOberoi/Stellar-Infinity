/*
 * patient-3728682-gender-20260927.sql
 *
 * Demographic correction on Jas's instruction (2026-09-27): LAVI, PID
 * 3728682, HR0383 (SIDs 9789110–9789113), was registered as Mr / male and
 * is female — title Ms, gender 2. The patient master is shared with the
 * legacy LIS, so both print the correction; the result rows' frozen
 * reference-range text is left as reported.
 */
SET NOCOUNT ON;
UPDATE dbo.tbl_med_mcc_patient_master
SET initial = N'Ms', gender = 2
WHERE id = 3728682 AND mcc_code = 2910 AND gender = 1;
PRINT CONCAT('rows: ', @@ROWCOUNT);
GO
