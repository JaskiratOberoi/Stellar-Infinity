SET QUOTED_IDENTIFIER ON;
GO
/*
 * zztest01-thyroid-figure-fixtures-20260927.sql - six Thyroid Profile I
 * orders on the throwaway centre ZZTEST01 (mcc 6094), for reviewing the
 * "Reading this thyroid profile" figure the standard report now prints under
 * the profile.
 *
 *   ZZTHY01  Meenakshi Pillai  F 40  everything in range          -> Normal thyroid function
 *   ZZTHY02  Rakesh Sharma     M 47  TSH raised, T4 and T3 in range -> Mildly underactive (subclinical)
 *   ZZTHY03  Ayesha Khan       F 34  TSH suppressed, T4 and T3 high  -> Overactive (hyperthyroidism)
 *   ZZTHY04  Kamla Devi        F 56  TSH very high, T4 and T3 low    -> Underactive (primary hypothyroidism)
 *   ZZTHY05  Harbhajan Singh   M 61  TSH suppressed, T4 in range, T3 high -> T3 toxicosis
 *   ZZTHY06  Deepak Verma      M 38  TSH in range, T4 and T3 low     -> Low T4 with a normal TSH
 *
 * The result rows are cloned, structure only, from one real released
 * Thyroid Profile I tube (codes, names, units, the catalogue's frozen
 * reference text, profile links); the values are set here. No real
 * patient's reading is reproduced; the names are invented; the SIDs and the
 * centre mark them as fixtures. Written directly (no bill, bill_id-less),
 * status 7 and auth = 1 so the report treats them as released. Re-runnable.
 * Remove with zztest01-thyroid-figure-fixtures-cleanup-20260927.sql.
 */
SET NOCOUNT ON;
SET XACT_ABORT ON;
BEGIN TRAN;
DECLARE @mcc INT = 6094;
DECLARE @by  NVARCHAR(50) = N'inf:jas';
DECLARE @tmpl NVARCHAR(50) = N'21515308';
DECLARE @drawn DATETIME = DATEADD(MINUTE, 15, DATEADD(HOUR, 8, CONVERT(DATETIME, CONVERT(DATE, DATEADD(DAY, -1, GETDATE())))));
DECLARE @regd  DATETIME = DATEADD(HOUR, 2, @drawn);
DECLARE @done  DATETIME = DATEADD(HOUR, 8, @drawn);

/* ---- clear the previous run ------------------------------------------- */
DECLARE @old TABLE (pid INT);
INSERT INTO @old (pid)
SELECT DISTINCT s.patient_id FROM dbo.tbl_med_mcc_patient_samples s JOIN dbo.tbl_med_mcc_patient_master p ON p.id = s.patient_id
WHERE p.mcc_code = @mcc AND s.vailid LIKE N'ZZTHY0[0-9]';
DELETE FROM dbo.tbl_med_mcc_patient_test_result WHERE vailid LIKE N'ZZTHY0[0-9]';
DELETE FROM dbo.tbl_med_mcc_patient_samples     WHERE vailid LIKE N'ZZTHY0[0-9]';
DELETE FROM dbo.tbl_med_mcc_patient_tests       WHERE patient_id IN (SELECT pid FROM @old);
DELETE FROM dbo.tbl_med_mcc_patient_master      WHERE id IN (SELECT pid FROM @old);

/* ---- the patients and their readings ----------------------------------- */
DECLARE @spec TABLE (n TINYINT, sid NVARCHAR(50), initial NVARCHAR(10), name NVARCHAR(100), age INT, gender INT,
                     t3 NVARCHAR(20), t4 NVARCHAR(20), tsh NVARCHAR(20), t3Ab BIT, t4Ab BIT, tshAb BIT);
INSERT INTO @spec VALUES
    (1, N'ZZTHY01', N'Mrs', N'Meenakshi Pillai', 40, 2, N'1.21', N'7.9',  N'2.41',  0, 0, 0),
    (2, N'ZZTHY02', N'Mr',  N'Rakesh Sharma',    47, 1, N'1.05', N'6.1',  N'8.62',  0, 0, 1),
    (3, N'ZZTHY03', N'Mrs', N'Ayesha Khan',      34, 2, N'2.64', N'15.4', N'0.08',  1, 1, 1),
    (4, N'ZZTHY04', N'Mrs', N'Kamla Devi',       56, 2, N'0.48', N'2.1',  N'42.70', 1, 1, 1),
    (5, N'ZZTHY05', N'Mr',  N'Harbhajan Singh',  61, 1, N'2.35', N'9.8',  N'0.12',  1, 0, 1),
    (6, N'ZZTHY06', N'Mr',  N'Deepak Verma',     38, 1, N'0.55', N'2.9',  N'1.90',  1, 1, 0);

DECLARE @p TABLE (n TINYINT, pid INT);
DECLARE @n TINYINT = 1, @pid INT;
WHILE @n <= 6
BEGIN
    INSERT INTO dbo.tbl_med_mcc_patient_master
        (mcc_code, initial, name, age, age_type, gender, sample_date, sample_time, ref_doctor_other, mobile_number, addedby, addeddate)
    SELECT @mcc, initial, name, age, 1, gender, @drawn, @drawn, 'Self', CONCAT('900000020', n), @by, @regd
    FROM @spec WHERE n = @n;
    SET @pid = SCOPE_IDENTITY();
    INSERT INTO @p VALUES (@n, @pid);
    SET @n += 1;
END

/* The order line, copied from the template order's own Thyroid Profile I line. */
INSERT INTO dbo.tbl_med_mcc_patient_tests (patient_id, test_id, test_code, test_name, test_rate, test_type, addedby, addeddate)
SELECT p.pid, x.test_id, x.test_code, x.test_name, x.test_rate, x.test_type, @by, @regd
FROM @p p
CROSS APPLY (SELECT TOP 1 t.test_id, t.test_code, t.test_name, t.test_rate, t.test_type
             FROM dbo.tbl_med_mcc_patient_samples s JOIN dbo.tbl_med_mcc_patient_tests t ON t.patient_id = s.patient_id
             WHERE s.vailid = @tmpl AND LTRIM(RTRIM(t.test_code)) = N'CP114' ORDER BY t.id) x;

/* ---- the tube ---------------------------------------------------------- */
INSERT INTO dbo.tbl_med_mcc_patient_samples
    (patient_id, sampleid, testcodes, testnames, testtypes, vailid, sample_status, addedby, addeddate, modifiedby, modifieddate,
     lastmodified_date, report_type, department_id, business_unit_id, authorised_by, signature_id)
SELECT p.pid, s.sampleid, s.testcodes, s.testnames, s.testtypes, sp.sid, 7, @by, @regd, @by, @regd, @done,
       s.report_type, s.department_id, s.business_unit_id, s.authorised_by, s.signature_id
FROM @spec sp JOIN @p p ON p.n = sp.n CROSS JOIN dbo.tbl_med_mcc_patient_samples s
WHERE s.vailid = @tmpl;

/* ---- the rows: structure from the template, values from @spec ---------- */
INSERT INTO dbo.tbl_med_mcc_patient_test_result
    (patientid, vailid, testid, value, testtype, auth, attachment, hasparameters, normal_range, testcode, testname,
     testnormal_range, testunit, comments, addedby, addeddate, updatedby, updateddate, paramid, profile_id, abnormal,
     mobile_number, master_profile_id, level_id)
SELECT p.pid, sp.sid, r.testid,
       CASE WHEN r.testtype <> 'Test' THEN r.value
            WHEN r.testid = 164 THEN sp.t3 WHEN r.testid = 165 THEN sp.t4 WHEN r.testid = 170 THEN sp.tsh ELSE r.value END,
       r.testtype, 1, 0, r.hasparameters, r.normal_range, r.testcode, r.testname,
       r.testnormal_range, r.testunit, NULL, @by, @regd, @by, @done, r.paramid, r.profile_id,
       CASE WHEN r.testtype <> 'Test' THEN 0
            WHEN r.testid = 164 THEN sp.t3Ab WHEN r.testid = 165 THEN sp.t4Ab WHEN r.testid = 170 THEN sp.tshAb ELSE 0 END,
       NULL, r.master_profile_id, r.level_id
FROM @spec sp JOIN @p p ON p.n = sp.n
JOIN dbo.tbl_med_mcc_patient_test_result r ON r.vailid = @tmpl
ORDER BY sp.n, r.id;

COMMIT;

SELECT sp.sid, p.pid, sp.name,
       rows_ = (SELECT COUNT(*) FROM dbo.tbl_med_mcc_patient_test_result r WHERE r.vailid = sp.sid),
       tsh = (SELECT value FROM dbo.tbl_med_mcc_patient_test_result r WHERE r.vailid = sp.sid AND r.testid = 170 AND r.testtype = 'Test')
FROM @spec sp JOIN @p p ON p.n = sp.n ORDER BY sp.n;
GO
