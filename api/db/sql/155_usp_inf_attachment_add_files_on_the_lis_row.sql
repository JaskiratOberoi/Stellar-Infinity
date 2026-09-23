SET QUOTED_IDENTIFIER ON;
GO
/*
 * 155_usp_inf_attachment_add_files_on_the_lis_row.sql
 *
 * usp_inf_attachment_add re-issued whole from 56 with one addition: a
 * sample-level upload (no result_id) is filed on the result row the legacy
 * worksheet shows its paperclip on, so the LIS lists it like its own. Then
 * the two rows already stored with no row (ids 9204, 9206, uploaded
 * 2026-09-23) are re-homed the same way. Everything else is as in 56.
 */
CREATE OR ALTER PROCEDURE dbo.usp_inf_attachment_add
    @sid            NVARCHAR(50),
    @result_id      INT            = NULL,   -- NULL = belongs to the sample
    @file_type      VARCHAR(50),
    @content        VARBINARY(MAX),
    @actor_user_id  INT,
    @actor_ip       VARCHAR(64)    = NULL,
    @file_name      NVARCHAR(200)  = NULL
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE @actor_username NVARCHAR(50) =
        (SELECT Username FROM dbo.tbl_med_user_master WHERE id = @actor_user_id);

    IF @actor_username IS NULL
    BEGIN
        RAISERROR('Unknown acting user.', 16, 1);
        RETURN;
    END

    DECLARE @patient_id INT, @sample_id INT;
    SELECT TOP 1 @sample_id = id, @patient_id = patient_id
    FROM dbo.tbl_med_mcc_patient_samples WHERE vailid = @sid;

    IF @sample_id IS NULL
    BEGIN
        RAISERROR('Sample %s was not found.', 16, 1, @sid);
        RETURN;
    END

    -- A result_id, if given, must belong to THIS sample. Otherwise a caller
    -- could hang a document off another patient's analyte.
    IF @result_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM dbo.tbl_med_mcc_patient_test_result
                       WHERE id = @result_id AND vailid = @sid)
    BEGIN
        RAISERROR('That test does not belong to this sample.', 16, 1);
        RETURN;
    END

    BEGIN TRY
        BEGIN TRANSACTION;

        /* A document for the WHOLE sample is filed on the row the legacy
           worksheet shows its paperclip on. The LIS lists a sample's
           attachments per result row (GetTestGraph by result_id) and draws
           the clip only on a row whose attachment bit is set — the bit
           copied from tbl_med_test_master.Has_graph when the sample was
           registered. A row stored with no result_id is therefore
           invisible on the LIS side, which is how a graph uploaded here
           "did not show up in the old LIS" (2026-09-23). So, when the
           caller names no row: the sample's first flagged row; else the
           first row (Head first) of a test the catalogue marks Has_graph,
           which gets the flag; else the sample's first row, flagged. The
           flag is the LIS's own signal for "this row has a clip" and
           nothing else reads it. */
        IF @result_id IS NULL
        BEGIN
            SELECT TOP 1 @result_id = r.id
            FROM dbo.tbl_med_mcc_patient_test_result r
            WHERE r.vailid = @sid AND r.attachment = 1
            ORDER BY r.id;

            IF @result_id IS NULL
            BEGIN
                SELECT TOP 1 @result_id = r.id
                FROM dbo.tbl_med_mcc_patient_test_result r
                JOIN dbo.tbl_med_test_master tm ON tm.id = r.testid
                WHERE r.vailid = @sid AND tm.Has_graph = 1
                ORDER BY CASE WHEN r.testtype = 'Head' THEN 0 ELSE 1 END, r.id;

                IF @result_id IS NULL
                    SELECT TOP 1 @result_id = r.id
                    FROM dbo.tbl_med_mcc_patient_test_result r
                    WHERE r.vailid = @sid
                    ORDER BY CASE WHEN r.testtype = 'Head' THEN 0 ELSE 1 END, r.id;

                IF @result_id IS NOT NULL
                    UPDATE dbo.tbl_med_mcc_patient_test_result
                    SET attachment = 1
                    WHERE id = @result_id AND ISNULL(attachment, 0) = 0;
            END
        END

        INSERT INTO dbo.tbl_med_mcc_patient_test_result_attachment
            (result_id, attachment, vail_id, file_type)
        VALUES (@result_id, @content, @sid, @file_type);

        DECLARE @new_id INT = CONVERT(INT, SCOPE_IDENTITY());

        INSERT INTO dbo.inf_result_audit
            (result_id, vailid, patient_id, action, field, old_value, new_value, reason,
             actor_user_id, actor_username, actor_ip, source, origin)
        VALUES (@result_id, @sid, @patient_id, 'attach', 'attachment',
                NULL, CONVERT(NVARCHAR(20), @new_id),
                CONCAT(ISNULL(@file_name, N'file'), N' (', @file_type, N', ',
                       DATALENGTH(@content) / 1024, N' KB)'),
                @actor_user_id, @actor_username, @actor_ip, 'ui',
                'inf:' + CONVERT(VARCHAR(20), @actor_user_id));

        COMMIT TRANSACTION;

        SELECT id = @new_id;
    END TRY
    BEGIN CATCH
        IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
        THROW;
    END CATCH
END
GO

/* ---- re-home the sample-level uploads already stored with no row ------- */
UPDATE a
SET result_id = (SELECT TOP 1 r.id FROM dbo.tbl_med_mcc_patient_test_result r
                 WHERE r.vailid = a.vail_id AND r.attachment = 1 ORDER BY r.id)
FROM dbo.tbl_med_mcc_patient_test_result_attachment a
WHERE a.result_id IS NULL
  AND EXISTS (SELECT 1 FROM dbo.tbl_med_mcc_patient_test_result r
              WHERE r.vailid = a.vail_id AND r.attachment = 1);
PRINT CONCAT('re-homed: ', @@ROWCOUNT);
SELECT id, vail_id, result_id FROM dbo.tbl_med_mcc_patient_test_result_attachment WHERE id >= 9204 ORDER BY id;
GO
