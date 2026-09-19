SET QUOTED_IDENTIFIER ON;
GO
/*
 * hs3-thyroid-repair-20260919.sql — puts Thyroid Profile II back on the two
 * HEALTH SCREEN 3 serum tubes that Infinity booked without it and that have
 * NOT been printed: 9338332 (PID 3694799) and 9338334 (PID 3694804), both
 * PB0055, both authorised on their other tests.
 *
 * Why it was missing: the shared order procedures filtered a package's
 * child profiles on IsActive, and Thyroid Profile II is flagged inactive
 * though it is a member of HEALTH SCREEN 3. Fixed in 146; this repairs the
 * two orders the fix came too late for and that can still be completed.
 *
 * What it does per tube, in the LIS's own shape:
 *   1. Rewrites the tube's testcodes/testtypes/testnames to the string a
 *      legacy HS3 booking carries (profiles first, package tag on the last
 *      profile), which now includes CP111.
 *   2. Inserts the result skeleton for the profile the way
 *      usp_telo_accession_samples builds one: a 'Profile' header row and a
 *      'Test' row per member (FT3, FT4, TSH — none is parameterised), with
 *      the patient's own normal range, unit and machine default, auth = 0.
 *   3. Moves the tube from Authorised (7) to Partially Authorised (6): the
 *      forty-two existing results are signed, the three new ones are not.
 *   4. Writes a "Tests Added" activity row so the LIS trail says why.
 *
 * Guarded: a tube that already carries CP111 or any of the three results is
 * left alone. Idempotent.
 */
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @who NVARCHAR(50) = N'Jas';
DECLARE @userId INT = 6593;
DECLARE @profileId INT = 12;     -- Thyroid Profile II (CP111)

DECLARE @tubes TABLE (vailid NVARCHAR(50) PRIMARY KEY);
INSERT INTO @tubes VALUES (N'9338332'), (N'9338334');

DECLARE @work TABLE (vailid NVARCHAR(50) PRIMARY KEY, patient_id INT, age INT, age_type INT, gender INT, modifieddate DATETIME);
INSERT INTO @work
SELECT s.vailid, s.patient_id, p.age, p.age_type, p.gender, s.modifieddate
FROM dbo.tbl_med_mcc_patient_samples s
JOIN dbo.tbl_med_mcc_patient_master p ON p.id = s.patient_id
JOIN @tubes t ON t.vailid = s.vailid
WHERE s.testcodes NOT LIKE '%CP111%'
  AND NOT EXISTS (SELECT 1 FROM dbo.tbl_med_mcc_patient_test_result r
                  WHERE r.vailid = s.vailid AND r.profile_id = @profileId);

IF NOT EXISTS (SELECT 1 FROM @work)
BEGIN
    SELECT repaired = 0, note = N'Nothing to repair — both tubes already carry Thyroid Profile II';
    RETURN;
END

BEGIN TRAN;

/* 1 ── the tube's CSVs, as a legacy HS3 booking writes them */
UPDATE s
SET s.testcodes = N'CP106,CP107,CP111,CP116,BI005,BI063,BI137,BI138,BI214,BI215,BI235',
    s.testtypes = N'mp,mp,mp,mp,mt,mt,mt,mt,mt,mt,mt',
    s.testnames = N'LIPID PROFILE,Liver Function Test,Thyroid Profile II,Kidney Function Test with Electrolytes&nbsp;<i><b>[HEALTH SCREEN 3]</b></i>,VITAMIN D,Calcium - ionized,Iron,Iron Binding Capacity - Total (TIBC), T3 (Tri Iodothyronine ) , T4 (Thyroxine ),Vitamin B12  -Serum',
    s.sample_status = 6,
    s.report_type = 1,     -- accession rule: a tube carrying Thyroid Profile I/II reports as type 1
    s.modifiedby = @who,
    s.modifieddate = GETDATE()
FROM dbo.tbl_med_mcc_patient_samples s
JOIN @work w ON w.vailid = s.vailid;

/* 2 ── the profile's result skeleton: header row, then one 'Test' row per member */
INSERT INTO dbo.tbl_med_mcc_patient_test_result
    (patientid, vailid, testid, paramid, testcode, testname, testtype,
     testnormal_range, testunit, auth, attachment, profile_id, addeddate, updateddate, mobile_number)
SELECT w.patient_id, w.vailid,
       (SELECT TOP 1 pp2.testid FROM dbo.tbl_med_test_profile_param pp2 WHERE pp2.profileid = @profileId ORDER BY pp2.id),
       NULL, NULL, pfm.Profile_Name, 'Profile', NULL, NULL, 1, NULL, @profileId, GETDATE(), NULL, NULL
FROM @work w
CROSS JOIN dbo.tbl_med_test_profile_master pfm
WHERE pfm.id = @profileId;

INSERT INTO dbo.tbl_med_mcc_patient_test_result
    (patientid, vailid, testid, paramid, testcode, testname, testtype,
     testnormal_range, testunit, auth, attachment, profile_id, addeddate, updateddate, mobile_number)
SELECT w.patient_id, w.vailid, tm.id, NULL, tm.TestCode, tm.ReportTestname, 'Test',
       dbo.ufn_telo_test_normal_range(tm.id, w.age, w.age_type, w.gender),
       dbo.ufn_telo_test_unit(tm.id),
       0, tm.Has_graph, @profileId, GETDATE(),
       DATEADD(HOUR, CASE WHEN tm.TAT > 0 THEN tm.TAT ELSE 5 END, w.modifieddate),
       dbo.ufn_telo_sample_value(tm.id, NULL)
FROM @work w
JOIN dbo.tbl_med_test_profile_param pp ON pp.profileid = @profileId
JOIN dbo.tbl_med_test_master tm ON tm.id = pp.testid
WHERE ISNULL(tm.Has_Parameters, 0) = 0
ORDER BY w.vailid, pp.id;

/* 4 ── the LIS trail */
INSERT INTO dbo.TBL_MED_USER_ACTIVITY_LOG (USERID, PID, SAMPLEID, FUNCTION_PERFORMED, FUNCTION_DATE, IPADDRESS, OTEHR_INFO)
SELECT @userId, CAST(w.patient_id AS NVARCHAR(50)), w.vailid, N'Tests Added', GETDATE(), N'',
       N'Thyroid Profile II (HS3 member missed at booking)'
FROM @work w;

COMMIT;

SELECT s.vailid, s.sample_status, s.testcodes,
       thyroid_rows = (SELECT COUNT(*) FROM dbo.tbl_med_mcc_patient_test_result r WHERE r.vailid = s.vailid AND r.profile_id = @profileId),
       total_rows = (SELECT COUNT(*) FROM dbo.tbl_med_mcc_patient_test_result r WHERE r.vailid = s.vailid)
FROM dbo.tbl_med_mcc_patient_samples s JOIN @work w ON w.vailid = s.vailid;
GO
