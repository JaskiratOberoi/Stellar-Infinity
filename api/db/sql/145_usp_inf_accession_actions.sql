/* QUOTED_IDENTIFIER is baked in at creation time; see script 70. */
SET QUOTED_IDENTIFIER ON;
GO
/*
 * 145_usp_inf_accession_actions.sql
 *
 * The receiving desk's other half: what the legacy Accession page does around
 * the Register action, and the Reject action it has and Infinity did not.
 *
 * Register itself stays with usp_telo_accession_samples — the status flip,
 * the result skeleton, the charge-once billing — because a second copy of
 * that would drift. What the legacy page does BESIDE it, and that procedure
 * does not, is done here after it returns:
 *
 *   • business_unit_id on the sample becomes the RECEIVING user's unit
 *     (Accession.aspx.cs: objSample.business_unit_id = loginUser's unit).
 *     Reports resolve their signatories through it; a tube registered by a
 *     Punjab client and received in Delhi is signed by Delhi.
 *   • One TBL_MED_USER_ACTIVITY_LOG row, "Sample Registered", per tube —
 *     the legacy trail the lab's own readers still consult. Infinity's own
 *     audit row (inf_audit_log 'sample.accessioned') is written by the API.
 *
 * Reject (Accession.aspx.cs chkReject): status 1 → 3, the reason into
 * reject_comments, modifiedby/modifieddate, and a "Sample Rejected" activity
 * row. The legacy does NOT touch business_unit_id or the patient master on a
 * reject, and neither does this. Reasons come from tbl_med_resaon_master
 * (sic), the list the legacy's Reject dropdown shows.
 */

-- ------------------------------------------------------------- after Register --
CREATE OR ALTER PROCEDURE dbo.usp_inf_accession_stamp
    @userId  INT,
    @user    NVARCHAR(50),
    @vailids dbo.TeloVailidList READONLY,
    @ip      VARCHAR(64) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE @bu INT = (SELECT TOP 1 Business_Unit_id FROM dbo.tbl_med_user_master WHERE id = @userId);

    -- Only tubes this user has JUST registered: status 2 with their name on
    -- it. A SID in the batch that was skipped by Register is left alone.
    DECLARE @done TABLE (vailid NVARCHAR(50) PRIMARY KEY, patient_id INT);
    INSERT INTO @done (vailid, patient_id)
    SELECT DISTINCT s.vailid, s.patient_id
    FROM @vailids v
    JOIN dbo.tbl_med_mcc_patient_samples s ON s.vailid = v.vailid
    WHERE s.sample_status = 2 AND s.modifiedby = @user;

    BEGIN TRAN;

    IF @bu IS NOT NULL
        UPDATE s SET s.business_unit_id = @bu
        FROM dbo.tbl_med_mcc_patient_samples s
        JOIN @done d ON d.vailid = s.vailid;

    INSERT INTO dbo.TBL_MED_USER_ACTIVITY_LOG
        (USERID, PID, SAMPLEID, FUNCTION_PERFORMED, FUNCTION_DATE, IPADDRESS, OTEHR_INFO)
    SELECT @userId, CAST(d.patient_id AS NVARCHAR(50)), d.vailid, N'Sample Registered',
           GETDATE(), LEFT(ISNULL(@ip, ''), 20), N''
    FROM @done d;

    COMMIT;

    SELECT stamped = (SELECT COUNT(*) FROM @done), business_unit_id = @bu;
END
GO

-- ------------------------------------------------------------------- Reject --
CREATE OR ALTER PROCEDURE dbo.usp_inf_accession_reject
    @userId  INT,
    @user    NVARCHAR(50),
    @vailids dbo.TeloVailidList READONLY,
    @reason  NVARCHAR(200),
    @ip      VARCHAR(64) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE @reasonSafe NVARCHAR(200) = NULLIF(LTRIM(RTRIM(@reason)), N'');
    IF @reasonSafe IS NULL
    BEGIN
        SELECT ok = CAST(0 AS BIT), error_code = 'VALIDATION',
               message = N'A reason is required to reject a sample', rejected = 0, skipped = 0;
        SELECT vailid = CAST(NULL AS NVARCHAR(50)), outcome = CAST(NULL AS VARCHAR(20)) WHERE 1 = 0;
        RETURN;
    END

    DECLARE @out TABLE (vailid NVARCHAR(50) PRIMARY KEY, outcome VARCHAR(20));

    -- Only Sample Sent tubes can be rejected at the desk; anything further
    -- along is the bench's to reject, from the worksheet.
    DECLARE @work TABLE (vailid NVARCHAR(50) PRIMARY KEY, patient_id INT);
    INSERT INTO @work (vailid, patient_id)
    SELECT DISTINCT s.vailid, s.patient_id
    FROM @vailids v
    JOIN dbo.tbl_med_mcc_patient_samples s ON s.vailid = v.vailid
    WHERE s.sample_status = 1;

    INSERT INTO @out (vailid, outcome)
    SELECT v.vailid, 'skipped'
    FROM (SELECT DISTINCT vailid FROM @vailids) v
    WHERE NOT EXISTS (SELECT 1 FROM @work w WHERE w.vailid = v.vailid);

    BEGIN TRAN;

    UPDATE s
    SET s.sample_status   = 3,
        s.reject_comments = @reasonSafe,
        s.modifiedby      = @user,
        s.modifieddate    = GETDATE()
    FROM dbo.tbl_med_mcc_patient_samples s
    JOIN @work w ON w.vailid = s.vailid
    WHERE s.sample_status = 1;

    INSERT INTO dbo.TBL_MED_USER_ACTIVITY_LOG
        (USERID, PID, SAMPLEID, FUNCTION_PERFORMED, FUNCTION_DATE, IPADDRESS, OTEHR_INFO)
    SELECT @userId, CAST(w.patient_id AS NVARCHAR(50)), w.vailid, N'Sample Rejected',
           GETDATE(), LEFT(ISNULL(@ip, ''), 20), LEFT(@reasonSafe, 100)
    FROM @work w;

    COMMIT;

    INSERT INTO @out (vailid, outcome) SELECT vailid, 'rejected' FROM @work;

    SELECT ok = CAST(1 AS BIT), error_code = CAST(NULL AS VARCHAR(20)),
           message = CAST(NULL AS NVARCHAR(200)),
           rejected = (SELECT COUNT(*) FROM @work),
           skipped  = (SELECT COUNT(*) FROM @out WHERE outcome = 'skipped');
    SELECT vailid, outcome FROM @out ORDER BY vailid;
END
GO

-- ---------------------------------------------------------- the reason list --
CREATE OR ALTER PROCEDURE dbo.usp_inf_reject_reasons
AS
BEGIN
    SET NOCOUNT ON;
    SELECT id, reason = LTRIM(RTRIM(Reason))
    FROM dbo.tbl_med_resaon_master
    WHERE IsActive = 1
    ORDER BY Reason;
END
GO
