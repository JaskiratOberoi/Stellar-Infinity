/*
 * patient-3728682-female-ranges-20260927.sql
 *
 * Follows patient-3728682-gender-20260927.sql: LAVI (PID 3728682, HR0383,
 * SIDs 9789110–9789113) was reported as male and is female. The result rows
 * carry the reference-range text frozen at reporting time, so the eight
 * analytes whose female band is clinically different are re-derived here —
 * the text as the LIS itself stores it for a woman of this age (copied from
 * recent female reports for the four tests; the catalogue's female band, in
 * the row's own style, for the four CBC/ESR parameters) — and the abnormal
 * flag re-judged against the new band. Every other row's band is the same
 * for either sex (only its spelling differs in the catalogue) and is left as
 * reported. The audit trail records the sex correction and the one flag
 * that changed. Guarded on the old text, so a re-run changes nothing.
 *
 *   Hemoglobin      13.9   13.5 - 17.5  -> 12.0 - 15.0   in range
 *   RBC Count       5.38   4.5 - 5.5    -> 3.8 - 4.8     now HIGH
 *   Hematocrit      42.4   40 - 50      -> 36 - 46       in range
 *   ESR             6      0 - 10       -> 0 - 12        in range
 *   GGT             24.5   < 55         -> < 38          in range
 *   Iron            87.9   65-175       -> 50-170        in range
 *   Creatinine      0.41   0.40 - 1.35  -> 0.40 - 1.04   in range
 *   Uric acid       5.1    3.5-7.2      -> 2.6-6.0       in range
 */
SET NOCOUNT ON;
SET XACT_ABORT ON;
BEGIN TRAN;

DECLARE @pid INT = 3728682;
DECLARE @fix TABLE (id BIGINT, old_range NVARCHAR(200), new_range NVARCHAR(200), new_ab BIT);
INSERT INTO @fix VALUES
    (74235461, N'13.5 - 17.5', N'12.0 - 15.0', 0),
    (74235462, N'4.5 - 5.5',   N'3.8 - 4.8',   1),
    (74235464, N'40 - 50',     N'36 - 46',     0),
    (74235483, N'0 - 10',      N'0 - 12',      0),
    (74237223, N'< 55',        N'< 38',        0),
    (74237231, N'65-175',      N'50-170',      0),
    (74237236, N'0.40 - 1.35', N'0.40 - 1.04', 0),
    (74237238, N'3.5-7.2',     N'2.6-6.0',     0);

DECLARE @changed TABLE (id BIGINT, vailid NVARCHAR(50), testcode NVARCHAR(50), old_ab BIT, new_ab BIT);
UPDATE r
SET r.testnormal_range = f.new_range,
    r.abnormal = f.new_ab,
    r.updateddate = GETDATE(),
    r.updatedby = N'inf:jas'
OUTPUT inserted.id, inserted.vailid, inserted.testcode, deleted.abnormal, inserted.abnormal INTO @changed
FROM dbo.tbl_med_mcc_patient_test_result r
JOIN @fix f ON f.id = r.id
WHERE r.patientid = @pid
  AND LTRIM(RTRIM(REPLACE(REPLACE(r.testnormal_range, CHAR(13), ''), CHAR(10), ''))) = f.old_range;

DECLARE @n INT = (SELECT COUNT(*) FROM @changed);
PRINT CONCAT('rows re-derived: ', @n);

IF @n > 0
BEGIN
    -- The sex correction, once, on the visit's first row; the flag that
    -- changed, on its own row.
    INSERT INTO dbo.inf_result_audit
        (result_id, vailid, patient_id, test_code, action, field, old_value, new_value, reason,
         actor_user_id, actor_username, actor_ip, actor_user_agent, source, instrument_id, origin)
    SELECT TOP 1 c.id, c.vailid, @pid, c.testcode, 'patient_edit', 'sex', N'male', N'female',
           CONCAT(N'Registered as male, is female; reference ranges on ', @n, N' results re-derived for a woman of 23 (script patient-3728682-female-ranges-20260927).'),
           6593, N'Jas', NULL, NULL, 'api', NULL, N'inf:2910'
    FROM @changed c ORDER BY c.id;

    INSERT INTO dbo.inf_result_audit
        (result_id, vailid, patient_id, test_code, action, field, old_value, new_value, reason,
         actor_user_id, actor_username, actor_ip, actor_user_agent, source, instrument_id, origin)
    SELECT c.id, c.vailid, @pid, c.testcode, 'derive', 'abnormal',
           CONVERT(NVARCHAR(1), c.old_ab), CONVERT(NVARCHAR(1), c.new_ab),
           N'Re-judged against the female reference band after the sex correction.',
           6593, N'Jas', NULL, NULL, 'api', NULL, N'inf:2910'
    FROM @changed c WHERE c.old_ab <> c.new_ab;
END

COMMIT;

SELECT r.id, r.vailid, LEFT(r.testname, 28) AS tn, r.value, r.testnormal_range, r.abnormal
FROM dbo.tbl_med_mcc_patient_test_result r JOIN @fix f ON f.id = r.id ORDER BY r.id;
GO
