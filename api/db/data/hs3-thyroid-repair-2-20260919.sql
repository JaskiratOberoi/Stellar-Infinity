SET QUOTED_IDENTIFIER ON;
GO
/*
 * hs3-thyroid-repair-2-20260919.sql — the same repair as
 * hs3-thyroid-repair-20260919.sql for the three further unprinted orders the
 * full scan found: every Infinity booking of a package containing Thyroid
 * Profile II between 2026-09-11 and the fix on 2026-09-19 lost the profile;
 * these three serum tubes are still on the bench (Registered or Partially
 * Authorised), so the profile can be added and worked as normal.
 *
 *   9338348  PID 3698086  PB0004  HS3ADV  serum at Partially Authorised (6)
 *   9185754  PID 3699869  JK0094  JKHS4   serum at Registered (2)
 *   9185757  PID 3699916  JK0094  JKHS4   serum at Registered (2)
 *
 * The tube strings were written by the old procedure (codes in alphabetical
 * order, no package tag), so rather than rewrite them wholesale the profile
 * is spliced in right after the Liver Function Test (CP107) in all three
 * positional CSVs, keeping everything else exactly as booked. Result rows
 * are inserted in the accession procedure's shape (Profile header + a Test
 * row per member with the patient's own range, unit and machine default,
 * auth = 0); the tube status is left where the bench has it; report_type
 * follows the accession rule for a thyroid profile; a "Tests Added" activity
 * row records why. Guarded and idempotent.
 */
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @who NVARCHAR(50) = N'Jas';
DECLARE @userId INT = 6593;
DECLARE @profileId INT = 12;     -- Thyroid Profile II (CP111)
DECLARE @after NVARCHAR(20) = N'CP107';

DECLARE @tubes TABLE (vailid NVARCHAR(50) PRIMARY KEY);
INSERT INTO @tubes VALUES (N'9338348'), (N'9185754'), (N'9185757');

DECLARE @work TABLE (vailid NVARCHAR(50) PRIMARY KEY, patient_id INT, age INT, age_type INT, gender INT, modifieddate DATETIME,
                     codes NVARCHAR(MAX), types NVARCHAR(MAX), names NVARCHAR(MAX));
INSERT INTO @work
SELECT s.vailid, s.patient_id, p.age, p.age_type, p.gender, s.modifieddate, s.testcodes, s.testtypes, s.testnames
FROM dbo.tbl_med_mcc_patient_samples s
JOIN dbo.tbl_med_mcc_patient_master p ON p.id = s.patient_id
JOIN @tubes t ON t.vailid = s.vailid
WHERE ',' + s.testcodes + ',' NOT LIKE '%,CP111,%'
  AND ',' + s.testcodes + ',' LIKE '%,' + @after + ',%'
  AND NOT EXISTS (SELECT 1 FROM dbo.tbl_med_mcc_patient_test_result r
                  WHERE r.vailid = s.vailid AND r.profile_id = @profileId);

IF NOT EXISTS (SELECT 1 FROM @work)
BEGIN
    SELECT repaired = 0, note = N'Nothing to repair — the tubes already carry Thyroid Profile II (or lack CP107)';
    RETURN;
END

/* Splice the profile in after CP107 in each positional CSV. k = ordinal of
   CP107; the insertion point in types/names is just after the k-th comma. */
DECLARE @v NVARCHAR(50), @codes NVARCHAR(MAX), @types NVARCHAR(MAX), @names NVARCHAR(MAX), @k INT, @i INT, @pos INT;
DECLARE cur CURSOR LOCAL FAST_FORWARD FOR SELECT vailid, codes, types, names FROM @work;
OPEN cur; FETCH NEXT FROM cur INTO @v, @codes, @types, @names;
WHILE @@FETCH_STATUS = 0
BEGIN
    SET @pos = CHARINDEX(',' + @after + ',', ',' + @codes + ',');          -- 1-based in the padded string
    SET @k = LEN(LEFT(',' + @codes + ',', @pos)) - LEN(REPLACE(LEFT(',' + @codes + ',', @pos), ',', ''));  -- commas before CP107 = its ordinal

    SET @codes = STUFF(@codes, @pos - 1 + LEN(@after) + 1, 0, N',CP111');  -- after "CP107"

    SET @i = 0; SET @pos = 0;
    WHILE @i < @k BEGIN SET @pos = CHARINDEX(',', @types, @pos + 1); SET @i += 1; END
    SET @types = STUFF(@types, @pos, 0, N',mp');

    SET @i = 0; SET @pos = 0;
    WHILE @i < @k BEGIN SET @pos = CHARINDEX(',', @names, @pos + 1); SET @i += 1; END
    SET @names = STUFF(@names, @pos, 0, N',Thyroid Profile II');

    UPDATE @work SET codes = @codes, types = @types, names = @names WHERE vailid = @v;
    FETCH NEXT FROM cur INTO @v, @codes, @types, @names;
END
CLOSE cur; DEALLOCATE cur;

/* every CSV must still be positionally aligned */
IF EXISTS (SELECT 1 FROM @work
           WHERE LEN(codes) - LEN(REPLACE(codes, ',', '')) <> LEN(types) - LEN(REPLACE(types, ',', ''))
              OR LEN(codes) - LEN(REPLACE(codes, ',', '')) <> LEN(names) - LEN(REPLACE(names, ',', '')))
BEGIN
    SELECT vailid, codes, types, names FROM @work;
    THROW 50000, N'CSV splice misaligned — nothing written', 1;
END

BEGIN TRAN;

UPDATE s
SET s.testcodes = w.codes, s.testtypes = w.types, s.testnames = w.names,
    s.report_type = 1,
    s.modifiedby = @who,
    s.modifieddate = GETDATE()
FROM dbo.tbl_med_mcc_patient_samples s
JOIN @work w ON w.vailid = s.vailid;

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

INSERT INTO dbo.TBL_MED_USER_ACTIVITY_LOG (USERID, PID, SAMPLEID, FUNCTION_PERFORMED, FUNCTION_DATE, IPADDRESS, OTEHR_INFO)
SELECT @userId, CAST(w.patient_id AS NVARCHAR(50)), w.vailid, N'Tests Added', GETDATE(), N'',
       N'Thyroid Profile II (package member missed at booking)'
FROM @work w;

COMMIT;

SELECT s.vailid, s.sample_status, s.report_type, s.testcodes, s.testtypes,
       thyroid_rows = (SELECT COUNT(*) FROM dbo.tbl_med_mcc_patient_test_result r WHERE r.vailid = s.vailid AND r.profile_id = @profileId),
       total_rows = (SELECT COUNT(*) FROM dbo.tbl_med_mcc_patient_test_result r WHERE r.vailid = s.vailid)
FROM dbo.tbl_med_mcc_patient_samples s JOIN @work w ON w.vailid = s.vailid;
GO
