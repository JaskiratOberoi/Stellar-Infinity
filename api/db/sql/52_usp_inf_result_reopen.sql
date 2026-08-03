SET QUOTED_IDENTIFIER ON;
GO
/*
 * 42_usp_inf_result_reopen.sql
 *
 * Unlock an authorised or printed sample so its results can be corrected.
 *
 * ---------------------------------------------------------------------------
 * This is the single most consequential action in the worksheet, and the one
 * the legacy system gets most wrong. SampleWorksheet.aspx.cs:906-924:
 *
 *     if (txtReason.Text != string.Empty) {
 *         gvWorksheet.Enabled = true;  btnSave.Enabled = true;
 *         utl.GetUserLog(user, pid, sid, txtReason.Text, DateTime.Now, "", "");
 *     }
 *
 * Any user who can open the worksheet can re-open an authorised report by
 * typing any non-empty string. No role check — GetEditPatientInfo is not even
 * consulted. No supervisor approval. No minimum length. No amendment record.
 * The original value is then overwritten in place and is unrecoverable, and the
 * only trace is one activity-log row whose reason is truncated to 50 characters
 * by the stored procedure's parameter width.
 *
 * Here: a distinct capability (result:reopen) that technicians do not hold, a
 * reason of real length that is stored in full, and an audit row recording the
 * status transition. The results themselves keep their values and their
 * authorisation flags — reopening grants permission to edit, it does not
 * silently un-authorise fourteen analytes because one was wrong.
 * ---------------------------------------------------------------------------
 *
 * The sample drops to 6 (Partially Authorized) when some rows are authorised,
 * or 5 (Tested) when none are. It never drops below what the data supports.
 */
CREATE OR ALTER PROCEDURE dbo.usp_inf_result_reopen
    @sid           NVARCHAR(50),
    @reason        NVARCHAR(500),
    @actor_user_id INT,
    @actor_ip      VARCHAR(64)   = NULL,
    @actor_agent   NVARCHAR(256) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    IF LEN(LTRIM(RTRIM(ISNULL(@reason, '')))) < 10
    BEGIN
        RAISERROR('Reopening an authorised sample requires a reason of at least 10 characters.', 16, 1);
        RETURN;
    END

    DECLARE @origin VARCHAR(64) = 'inf:' + CONVERT(VARCHAR(20), @actor_user_id);
    DECLARE @actor_username NVARCHAR(50) =
        (SELECT Username FROM dbo.tbl_med_user_master WHERE id = @actor_user_id);

    IF @actor_username IS NULL
    BEGIN
        RAISERROR('Unknown acting user.', 16, 1);
        RETURN;
    END

    DECLARE @sample_id INT, @patient_id INT, @status_before INT;

    SELECT @sample_id = id, @patient_id = patient_id, @status_before = sample_status
    FROM dbo.tbl_med_mcc_patient_samples
    WHERE vailid = @sid;

    IF @sample_id IS NULL
    BEGIN
        RAISERROR('Sample %s was not found.', 16, 1, @sid);
        RETURN;
    END

    IF @status_before NOT IN (7, 8, 9)
    BEGIN
        RAISERROR('This sample is not authorised, so there is nothing to reopen.', 16, 1);
        RETURN;
    END

    BEGIN TRY
        BEGIN TRANSACTION;

        DECLARE @authed INT = (
            SELECT COUNT(*) FROM dbo.tbl_med_mcc_patient_test_result
            WHERE vailid = @sid AND testtype NOT IN ('Head', 'Profile') AND ISNULL(auth, 0) = 1);

        DECLARE @status_after INT = CASE WHEN @authed > 0 THEN 6 ELSE 5 END;

        UPDATE dbo.tbl_med_mcc_patient_samples
        SET sample_status     = @status_after,
            lastmodified_date = GETDATE()
        WHERE id = @sample_id;

        INSERT INTO dbo.inf_result_audit
            (result_id, vailid, patient_id, action, field, old_value, new_value, reason,
             actor_user_id, actor_username, actor_ip, actor_user_agent, source, origin)
        VALUES (NULL, @sid, @patient_id, 'reopen', 'status',
                CONVERT(NVARCHAR(10), @status_before), CONVERT(NVARCHAR(10), @status_after),
                @reason, @actor_user_id, @actor_username, @actor_ip, @actor_agent, 'ui', @origin);

        COMMIT TRANSACTION;

        SELECT @status_before AS status_before, @status_after AS status_after;
    END TRY
    BEGIN CATCH
        IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
        THROW;
    END CATCH
END
GO

/*
 * The sample's audit history, newest first — what the "History" panel on the
 * result screen reads.
 *
 * Deliberately unfiltered by actor: seeing who else touched a sample is the
 * whole point. Scope is enforced by the endpoint before this is called.
 */
CREATE OR ALTER PROCEDURE dbo.usp_inf_result_audit_read
    @sid   NVARCHAR(50),
    @top   INT = 200
AS
BEGIN
    SET NOCOUNT ON;

    SELECT TOP (@top)
        a.id,
        a.result_id,
        r.testname,
        r.testcode,
        a.action,
        a.field,
        a.old_value,
        a.new_value,
        a.reason,
        a.actor_username,
        a.actor_ip,
        a.source,
        a.occurred_at
    FROM dbo.inf_result_audit a
    LEFT JOIN dbo.tbl_med_mcc_patient_test_result r ON r.id = a.result_id
    WHERE a.vailid = @sid
    ORDER BY a.occurred_at DESC, a.id DESC;
END
GO
