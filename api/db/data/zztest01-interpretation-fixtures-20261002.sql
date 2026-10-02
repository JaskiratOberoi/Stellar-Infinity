SET QUOTED_IDENTIFIER ON;
GO
/*
 * zztest01-interpretation-fixtures-20261002.sql - four single-test orders on
 * the throwaway centre ZZTEST01 (mcc 6094), for approving the draft
 * interpretation texts for serum Creatinine and serum Calcium
 * (test-interpretation-drafts-20261002.sql).
 *
 *   ZZINT01  Priya Nair        F 32  Creatinine 0.78 mg/dL  in range
 *   ZZINT02  Mohan Lal         M 58  Creatinine 1.92 mg/dL  high
 *   ZZINT03  Sunil Mehta       M 45  Calcium 9.3 mg/dL      in range
 *   ZZINT04  Farida Begum      F 51  Calcium 7.6 mg/dL      low
 *
 * Rows are cloned, structure only, from one real released tube of each
 * test (codes, names, units, the catalogue's frozen reference text); the
 * values are set here. No real patient's reading is reproduced; the names
 * are invented. Status 7 and auth = 1 so the report treats them as
 * released. Re-runnable. Remove with
 * zztest01-interpretation-fixtures-cleanup-20261002.sql.
 */
SET NOCOUNT ON;
SET XACT_ABORT ON;
BEGIN TRAN;
DECLARE @mcc INT = 6094;
DECLARE @by  NVARCHAR(50) = N'inf:jas';
DECLARE @drawn DATETIME = DATEADD(MINUTE, 30, DATEADD(HOUR, 8, CONVERT(DATETIME, CONVERT(DATE, GETDATE()))));
DECLARE @regd  DATETIME = DATEADD(HOUR, 2, @drawn);
DECLARE @done  DATETIME = DATEADD(HOUR, 6, @drawn);

/* ---- clear the previous run ------------------------------------------- */
DECLARE @old TABLE (pid INT);
INSERT INTO @old (pid)
SELECT DISTINCT s.patient_id FROM dbo.tbl_med_mcc_patient_samples s JOIN dbo.tbl_med_mcc_patient_master p ON p.id = s.patient_id
WHERE p.mcc_code = @mcc AND s.vailid LIKE N'ZZINT0[0-9]';
DELETE FROM dbo.tbl_med_mcc_patient_test_result WHERE vailid LIKE N'ZZINT0[0-9]';
DELETE FROM dbo.tbl_med_mcc_patient_samples     WHERE vailid LIKE N'ZZINT0[0-9]';
DELETE FROM dbo.tbl_med_mcc_patient_tests       WHERE patient_id IN (SELECT pid FROM @old);
DELETE FROM dbo.tbl_med_mcc_patient_master      WHERE id IN (SELECT pid FROM @old);

/* ---- the patients: template tube, test id, value ----------------------- */
DECLARE @spec TABLE (n TINYINT, sid NVARCHAR(50), initial NVARCHAR(10), name NVARCHAR(100), age INT, gender INT,
                     tmpl NVARCHAR(50), test_id INT, test_code NVARCHAR(20), value NVARCHAR(20), abnormal BIT);
INSERT INTO @spec VALUES
    (1, N'ZZINT01', N'Ms', N'Priya Nair',   32, 2, N'9690682', 114, N'BI089', N'0.78', 0),
    (2, N'ZZINT02', N'Mr', N'Mohan Lal',    58, 1, N'9690682', 114, N'BI089', N'1.92', 1),
    (3, N'ZZINT03', N'Mr', N'Sunil Mehta',  45, 1, N'9647442',  96, N'BI064', N'9.3',  0),
    (4, N'ZZINT04', N'Ms', N'Farida Begum', 51, 2, N'9647442',  96, N'BI064', N'7.6',  1);

IF (SELECT COUNT(*) FROM dbo.tbl_med_mcc_patient_samples WHERE vailid IN (N'9690682', N'9647442')) <> 2
    THROW 50000, 'A template tube is missing; stop.', 1;

DECLARE @p TABLE (n TINYINT, pid INT);
DECLARE @n TINYINT = 1, @pid INT;
WHILE @n <= 4
BEGIN
    INSERT INTO dbo.tbl_med_mcc_patient_master
        (mcc_code, initial, name, age, age_type, gender, sample_date, sample_time, ref_doctor_other, mobile_number, addedby, addeddate)
    SELECT @mcc, initial, name, age, 1, gender, @drawn, @drawn, 'Self', CONCAT('900000030', n), @by, @regd
    FROM @spec WHERE n = @n;
    SET @pid = SCOPE_IDENTITY();
    INSERT INTO @p VALUES (@n, @pid);
    SET @n += 1;
END

/* The order line, copied from the template order's own line for the test. */
INSERT INTO dbo.tbl_med_mcc_patient_tests (patient_id, test_id, test_code, test_name, test_rate, test_type, addedby, addeddate)
SELECT p.pid, x.test_id, x.test_code, x.test_name, x.test_rate, x.test_type, @by, @regd
FROM @spec sp JOIN @p p ON p.n = sp.n
CROSS APPLY (SELECT TOP 1 t.test_id, t.test_code, t.test_name, t.test_rate, t.test_type
             FROM dbo.tbl_med_mcc_patient_samples s JOIN dbo.tbl_med_mcc_patient_tests t ON t.patient_id = s.patient_id
             WHERE s.vailid = sp.tmpl AND LTRIM(RTRIM(t.test_code)) = sp.test_code ORDER BY t.id) x;

/* ---- the tube ---------------------------------------------------------- */
INSERT INTO dbo.tbl_med_mcc_patient_samples
    (patient_id, sampleid, testcodes, testnames, testtypes, vailid, sample_status, addedby, addeddate, modifiedby, modifieddate,
     lastmodified_date, report_type, department_id, business_unit_id, authorised_by, signature_id)
SELECT p.pid, s.sampleid, s.testcodes, s.testnames, s.testtypes, sp.sid, 7, @by, @regd, @by, @regd, @done,
       s.report_type, s.department_id, s.business_unit_id, s.authorised_by, s.signature_id
FROM @spec sp JOIN @p p ON p.n = sp.n JOIN dbo.tbl_med_mcc_patient_samples s ON s.vailid = sp.tmpl;

/* ---- the rows: structure from the template, value from @spec ----------- */
INSERT INTO dbo.tbl_med_mcc_patient_test_result
    (patientid, vailid, testid, value, testtype, auth, attachment, hasparameters, normal_range, testcode, testname,
     testnormal_range, testunit, comments, addedby, addeddate, updatedby, updateddate, paramid, profile_id, abnormal,
     mobile_number, master_profile_id, level_id)
SELECT p.pid, sp.sid, r.testid,
       CASE WHEN r.testtype = 'Test' AND r.testid = sp.test_id THEN sp.value ELSE r.value END,
       r.testtype, 1, 0, r.hasparameters, r.normal_range, r.testcode, r.testname,
       r.testnormal_range, r.testunit, NULL, @by, @regd, @by, @done, r.paramid, r.profile_id,
       CASE WHEN r.testtype = 'Test' AND r.testid = sp.test_id THEN sp.abnormal ELSE 0 END,
       NULL, r.master_profile_id, r.level_id
FROM @spec sp JOIN @p p ON p.n = sp.n
JOIN dbo.tbl_med_mcc_patient_test_result r ON r.vailid = sp.tmpl
ORDER BY sp.n, r.id;

COMMIT;

SELECT sp.sid, p.pid, sp.name, sp.test_code, sp.value,
       rows_ = (SELECT COUNT(*) FROM dbo.tbl_med_mcc_patient_test_result r WHERE r.vailid = sp.sid)
FROM @spec sp JOIN @p p ON p.n = sp.n ORDER BY sp.n;
GO
