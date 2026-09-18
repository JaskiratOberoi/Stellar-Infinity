SET QUOTED_IDENTIFIER ON;
GO
/*
 * zztest01-accession-fixture-20260918.sql — two Sample Sent tubes on the
 * throwaway centre ZZTEST01 (mcc 6094), for exercising the accessioning desk:
 * one to register, one to reject. Written the way the legacy LIS writes a
 * client registration (addedby the client code, no result rows yet, status 1),
 * so the queue shows them under the LIS origin.
 *
 * Re-runnable: clears its own previous rows first (results included, so a
 * registered tube can be reset to Sample Sent and registered again).
 */
SET NOCOUNT ON;
SET XACT_ABORT ON;

BEGIN TRAN;

DECLARE @mcc INT = 6094;

DECLARE @old TABLE (pid INT);
INSERT INTO @old (pid)
SELECT id FROM dbo.tbl_med_mcc_patient_master WHERE mcc_code = @mcc AND name IN (N'ZZ TEST ACCESSION REGISTER', N'ZZ TEST ACCESSION REJECT');

DELETE FROM dbo.tbl_med_mcc_patient_test_result WHERE vailid IN (N'ZZACC01', N'ZZACC02');
DELETE FROM dbo.tbl_med_mcc_patient_samples     WHERE vailid IN (N'ZZACC01', N'ZZACC02');
DELETE FROM dbo.tbl_med_mcc_patient_tests       WHERE patient_id IN (SELECT pid FROM @old);
DELETE FROM dbo.tbl_med_mcc_patient_master      WHERE id IN (SELECT pid FROM @old);

INSERT INTO dbo.tbl_med_mcc_patient_master (name, mcc_code, gender, age, age_type, sample_time, addedby, Status, addeddate)
VALUES (N'ZZ TEST ACCESSION REGISTER', @mcc, 1, 35, 1, GETDATE(), N'ZZTEST01', 1, DATEADD(DAY, -3, GETDATE()));
DECLARE @p1 INT = SCOPE_IDENTITY();

INSERT INTO dbo.tbl_med_mcc_patient_master (name, mcc_code, gender, age, age_type, sample_time, addedby, Status, addeddate)
VALUES (N'ZZ TEST ACCESSION REJECT', @mcc, 2, 29, 1, GETDATE(), N'ZZTEST01', 1, DATEADD(DAY, -3, GETDATE()));
DECLARE @p2 INT = SCOPE_IDENTITY();

-- The booked tests: the CSV pair on the sample is what Register expands.
INSERT INTO dbo.tbl_med_mcc_patient_tests (patient_id, test_id, test_code, test_name, test_type, test_rate, addedby, addeddate)
VALUES (@p1, 291, N'BI127', N'Glycated Hemoglobin (HBA1c)', N'Test', 0, N'ZZTEST01', GETDATE()),
       (@p1, 170, N'BI221', N'TSH : Thyroid Stimulating Hormone', N'Test', 0, N'ZZTEST01', GETDATE()),
       (@p2, 34,  N'CP004', N'Complete Urine Examination', N'Test', 0, N'ZZTEST01', GETDATE());

INSERT INTO dbo.tbl_med_mcc_patient_samples
    (vailid, patient_id, sampleid, sample_status, testcodes, testnames, testtypes, addedby, addeddate, business_unit_id)
VALUES
    (N'ZZACC01', @p1, 46, 1, N'BI127,BI221', N'Glycated Hemoglobin (HBA1c),TSH : Thyroid Stimulating Hormone', N't,t', N'ZZTEST01', DATEADD(DAY, -3, GETDATE()), 1),
    (N'ZZACC02', @p2, 16, 1, N'CP004', N'Complete Urine Examination', N't', N'ZZTEST01', DATEADD(DAY, -3, GETDATE()), 1);

COMMIT;

SELECT register_sid = N'ZZACC01', register_pid = @p1, reject_sid = N'ZZACC02', reject_pid = @p2;
GO
