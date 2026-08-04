/*
 * 83_diagnose_patient_identity.sql
 *
 * READ-ONLY. Establishes what actually identifies the SAME PERSON across
 * visits, before any history/trending feature relies on it.
 *
 * This matters more than it looks. tbl_med_mcc_patient_master appears to get a
 * new row per registration, so patient_id identifies a VISIT, not a person. A
 * delta graph that trends "the patient's previous values" has to join on
 * something stable, and joining on the wrong thing shows one patient another
 * person's results â€” which is a clinical error, not a display bug.
 *
 * Writes nothing.
 */
SET NOCOUNT ON;

PRINT 'Candidate identity columns on tbl_med_mcc_patient_master:';
DECLARE @cols NVARCHAR(MAX) = N'';
SELECT @cols = @cols + '  ' + c.COLUMN_NAME + ' ' + c.DATA_TYPE + CHAR(10)
FROM INFORMATION_SCHEMA.COLUMNS c
WHERE c.TABLE_SCHEMA = 'dbo' AND c.TABLE_NAME = 'tbl_med_mcc_patient_master'
  AND (c.COLUMN_NAME LIKE '%mrn%' OR c.COLUMN_NAME LIKE '%uhid%' OR c.COLUMN_NAME LIKE '%mobile%'
       OR c.COLUMN_NAME LIKE '%name%' OR c.COLUMN_NAME LIKE '%medid%' OR c.COLUMN_NAME LIKE '%aadhaar%'
       OR c.COLUMN_NAME = 'id' OR c.COLUMN_NAME LIKE '%patient%');
PRINT ISNULL(@cols, '  (none matched)');

-- Is patient_id per-visit or per-person?
DECLARE @patients INT = (SELECT COUNT(*) FROM dbo.tbl_med_mcc_patient_master);
DECLARE @withMobile INT =
    (SELECT COUNT(*) FROM dbo.tbl_med_mcc_patient_master
     WHERE mobile_number IS NOT NULL AND LEN(LTRIM(RTRIM(mobile_number))) >= 10);
DECLARE @distinctMobile INT =
    (SELECT COUNT(DISTINCT LTRIM(RTRIM(mobile_number))) FROM dbo.tbl_med_mcc_patient_master
     WHERE mobile_number IS NOT NULL AND LEN(LTRIM(RTRIM(mobile_number))) >= 10);

PRINT '';
PRINT 'patient_master rows          : ' + CAST(@patients AS VARCHAR(20));
PRINT 'rows with a usable mobile    : ' + CAST(@withMobile AS VARCHAR(20));
PRINT 'distinct mobiles among those : ' + CAST(@distinctMobile AS VARCHAR(20));
PRINT '  (rows >> distinct mobiles means a person really does recur across visits)';

-- How often does one name+mobile span several registrations?
PRINT '';
PRINT 'Top repeat patients by (name, mobile):';
DECLARE @rep NVARCHAR(MAX) = N'';
SELECT TOP 6 @rep = @rep + '  ' + LEFT(ISNULL(x.name, '?') + REPLICATE(' ', 26), 26)
                   + 'visits=' + CAST(x.visits AS VARCHAR(10))
                   + '  samples=' + CAST(x.samples AS VARCHAR(10)) + CHAR(10)
FROM (
    SELECT p.name,
           COUNT(DISTINCT p.id) AS visits,
           COUNT(DISTINCT s.vailid) AS samples
    FROM dbo.tbl_med_mcc_patient_master p
    LEFT JOIN dbo.tbl_med_mcc_patient_samples s ON s.patient_id = p.id
    WHERE p.mobile_number IS NOT NULL AND LEN(LTRIM(RTRIM(p.mobile_number))) >= 10
      AND p.name IS NOT NULL
    GROUP BY p.name, LTRIM(RTRIM(p.mobile_number))
    HAVING COUNT(DISTINCT p.id) > 1
) x
ORDER BY x.visits DESC;
PRINT ISNULL(@rep, '  (no repeat patients found)');
GO
