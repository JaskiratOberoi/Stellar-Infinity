/*
 * 131_usp_inf_order_draft.sql
 *
 * The draft queue's four operations: save (insert or update), list, get, and
 * delete — plus the one Submit All uses to record why it left a row behind.
 *
 * EVERY one of these takes @user_id and filters on it. A draft is private to
 * its author (see 130), and that is enforced here rather than in the endpoint
 * so a future caller cannot forget: an id belonging to someone else simply
 * does not match, and the caller is told NOT_FOUND rather than being handed
 * another operator's half-typed patient.
 */
SET QUOTED_IDENTIFIER ON;
SET ANSI_NULLS ON;
GO

CREATE OR ALTER PROCEDURE dbo.usp_inf_order_draft_save
    @user_id      INT,
    @mcc_code     INT,
    @payload      NVARCHAR(MAX),
    @patient_name NVARCHAR(200) = NULL,
    @total        INT = 0,
    @tubes        INT = 0,
    @sids         INT = 0,
    -- NULL inserts; a value updates that draft IF the caller owns it.
    @id           INT = NULL
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    IF @payload IS NULL OR LEN(@payload) = 0
    BEGIN
        SELECT ok = CAST(0 AS BIT), error_code = 'VALIDATION',
               message = N'A draft cannot be empty.', id = CAST(NULL AS INT);
        RETURN;
    END

    IF @id IS NOT NULL
    BEGIN
        UPDATE dbo.inf_order_draft
        SET payload = @payload, patient_name = @patient_name, total = @total,
            tubes = @tubes, sids = @sids, mcc_code = @mcc_code,
            -- An edit is the operator's answer to whatever went wrong, so the
            -- stale reason goes with it.
            last_error = NULL, updated_at = SYSDATETIME()
        WHERE id = @id AND user_id = @user_id;

        IF @@ROWCOUNT = 0
        BEGIN
            SELECT ok = CAST(0 AS BIT), error_code = 'NOT_FOUND',
                   message = N'That draft is no longer in your list.', id = CAST(NULL AS INT);
            RETURN;
        END

        SELECT ok = CAST(1 AS BIT), error_code = CAST(NULL AS VARCHAR(20)),
               message = CAST(NULL AS NVARCHAR(200)), id = @id;
        RETURN;
    END

    INSERT INTO dbo.inf_order_draft
        (user_id, mcc_code, patient_name, total, tubes, sids, payload)
    VALUES (@user_id, @mcc_code, @patient_name, @total, @tubes, @sids, @payload);

    SELECT ok = CAST(1 AS BIT), error_code = CAST(NULL AS VARCHAR(20)),
           message = CAST(NULL AS NVARCHAR(200)), id = CAST(SCOPE_IDENTITY() AS INT);
END
GO

/* The queue for the client on screen, oldest first — the order it was typed. */
CREATE OR ALTER PROCEDURE dbo.usp_inf_order_draft_list
    @user_id  INT,
    @mcc_code INT
AS
BEGIN
    SET NOCOUNT ON;
    SELECT id, mcc_code, patient_name, total, tubes, sids, last_error,
           created_at, updated_at
    FROM dbo.inf_order_draft
    WHERE user_id = @user_id AND mcc_code = @mcc_code
    ORDER BY id;
END
GO

/* One draft's payload, to load back into the form for editing. */
CREATE OR ALTER PROCEDURE dbo.usp_inf_order_draft_get
    @user_id INT,
    @id      INT
AS
BEGIN
    SET NOCOUNT ON;
    SELECT id, mcc_code, payload
    FROM dbo.inf_order_draft
    WHERE id = @id AND user_id = @user_id;
END
GO

CREATE OR ALTER PROCEDURE dbo.usp_inf_order_draft_delete
    @user_id INT,
    @id      INT
AS
BEGIN
    SET NOCOUNT ON;
    DELETE FROM dbo.inf_order_draft WHERE id = @id AND user_id = @user_id;
    SELECT ok = CAST(CASE WHEN @@ROWCOUNT > 0 THEN 1 ELSE 0 END AS BIT);
END
GO

/*
 * Why Submit All left this one behind. Not a failure of the submission — the
 * run books what it can — so this records the reason ON the surviving draft
 * for the operator to read, fix and resubmit.
 */
CREATE OR ALTER PROCEDURE dbo.usp_inf_order_draft_fail
    @user_id INT,
    @id      INT,
    @error   NVARCHAR(500)
AS
BEGIN
    SET NOCOUNT ON;
    UPDATE dbo.inf_order_draft
    SET last_error = @error, updated_at = SYSDATETIME()
    WHERE id = @id AND user_id = @user_id;
END
GO
