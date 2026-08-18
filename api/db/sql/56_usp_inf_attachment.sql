/*
 * 56_usp_inf_attachment.sql
 *
 * Worksheet attachments — the analyser graph, the scanned trace, the outside
 * lab's PDF — for EVERY sample.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS SAMPLE-SCOPED, NOT TEST-SCOPED
 *
 * The legacy LIS shows its paperclip only when the result row's `attachment`
 * bit is set, and that bit is copied from tbl_med_test_master.Has_graph. Only
 * 357 of 1,457 active tests carry that flag, so on most samples there is no way
 * to attach anything at all — which is the reported problem.
 *
 * The stored data says the flag was the wrong model anyway: 6,724 attachments
 * exist across 6,710 distinct vials. Very nearly one per SAMPLE. People are
 * attaching a document to a sample, not to an analyte, and the per-test gate
 * only ever got in the way.
 *
 * So attachments here hang off vail_id, with result_id kept OPTIONAL for the
 * cases where a document really does belong to one analyte. Both are written
 * into the legacy table dbo.tbl_med_mcc_patient_test_result_attachment — the
 * same rows the LIS and its Crystal reports already read — so nothing is
 * stranded in an Infinity-only store.
 * ---------------------------------------------------------------------------
 *
 * Content is NOT validated here. Size, extension and magic-byte checks belong
 * at the API boundary where the bytes arrive; by the time a payload reaches
 * SQL it is too late to say anything useful about it.
 */
SET QUOTED_IDENTIFIER ON;
GO

/* ---- what is attached to this sample ------------------------------------
 * Deliberately does NOT return the bytes. A worksheet listing ten attachments
 * would otherwise ship ten PDFs to render a list of filenames.
 */
CREATE OR ALTER PROCEDURE dbo.usp_inf_attachment_list
    @sid NVARCHAR(50)
AS
BEGIN
    SET NOCOUNT ON;

    SELECT
        a.id,
        a.result_id,
        test_name = r.testname,
        test_code = r.testcode,
        a.file_type,
        size_bytes = DATALENGTH(a.attachment),
        -- The legacy table has no uploader or timestamp columns, so anything
        -- Infinity uploaded is matched back to its audit row. Rows created by
        -- the LIS simply have no provenance to show, and saying so is better
        -- than inventing one.
        uploaded_by = au.actor_username,
        uploaded_at = au.occurred_at
    FROM dbo.tbl_med_mcc_patient_test_result_attachment a
    LEFT JOIN dbo.tbl_med_mcc_patient_test_result r ON r.id = a.result_id
    OUTER APPLY (
        SELECT TOP 1 x.actor_username, x.occurred_at
        FROM dbo.inf_result_audit x
        WHERE x.field = 'attachment'
          AND x.action = 'attach'
          AND x.new_value = CONVERT(NVARCHAR(20), a.id)
        ORDER BY x.id DESC
    ) au
    WHERE a.vail_id = @sid
    ORDER BY a.id;
END
GO

/* ---- the bytes, for one attachment --------------------------------------
 * Returns vail_id alongside so the CALLER can prove the file belongs to a
 * sample the user may see. The legacy handler (graph.ashx?id=N) streams any
 * attachment to anyone who can guess an integer — no authentication, no
 * ownership check. That hole is closed at the endpoint, and this procedure
 * hands it the fact it needs to close it.
 */
CREATE OR ALTER PROCEDURE dbo.usp_inf_attachment_get
    @id INT
AS
BEGIN
    SET NOCOUNT ON;

    SELECT a.id, a.vail_id, a.file_type, a.attachment
    FROM dbo.tbl_med_mcc_patient_test_result_attachment a
    WHERE a.id = @id;
END
GO

/* ---- attach -------------------------------------------------------------- */
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

/* ---- detach --------------------------------------------------------------
 * A hard delete, matching the legacy behaviour, but audited — the legacy
 * DeleteGraph removes the row with no confirmation and no record at all, so a
 * vanished graph is currently unexplainable.
 */
CREATE OR ALTER PROCEDURE dbo.usp_inf_attachment_delete
    @id            INT,
    @sid           NVARCHAR(50),
    @actor_user_id INT,
    @actor_ip      VARCHAR(64) = NULL
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

    -- Scoped by SID as well as id: the endpoint has already checked the caller
    -- may see this sample, so tying the delete to it stops an id from another
    -- sample being passed in.
    DECLARE @result_id INT, @file_type VARCHAR(50), @bytes INT;
    SELECT @result_id = result_id, @file_type = file_type, @bytes = DATALENGTH(attachment)
    FROM dbo.tbl_med_mcc_patient_test_result_attachment
    WHERE id = @id AND vail_id = @sid;

    IF @@ROWCOUNT = 0
    BEGIN
        RAISERROR('That attachment is not on this sample.', 16, 1);
        RETURN;
    END

    DECLARE @patient_id INT =
        (SELECT TOP 1 patient_id FROM dbo.tbl_med_mcc_patient_samples WHERE vailid = @sid);

    BEGIN TRY
        BEGIN TRANSACTION;

        DELETE FROM dbo.tbl_med_mcc_patient_test_result_attachment
        WHERE id = @id AND vail_id = @sid;

        INSERT INTO dbo.inf_result_audit
            (result_id, vailid, patient_id, action, field, old_value, new_value, reason,
             actor_user_id, actor_username, actor_ip, source, origin)
        VALUES (@result_id, @sid, @patient_id, 'detach', 'attachment',
                CONVERT(NVARCHAR(20), @id), NULL,
                CONCAT(N'removed ', @file_type, N' (', @bytes / 1024, N' KB)'),
                @actor_user_id, @actor_username, @actor_ip, 'ui',
                'inf:' + CONVERT(VARCHAR(20), @actor_user_id));

        COMMIT TRANSACTION;
    END TRY
    BEGIN CATCH
        IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
        THROW;
    END CATCH
END
GO
