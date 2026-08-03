/*
 * 43_usp_inf_auto_auth.sql
 *
 * Read and change the auto-authorisation rules.
 *
 * The password that gates enabling is verified in the API (PBKDF2, constant
 * time) BEFORE usp_inf_auto_auth_set is called — it is never sent to the
 * database and never stored here. This procedure's contract is narrower: it
 * assumes the caller has already been authorised twice over (capability plus
 * password) and its job is to apply the change and record it.
 *
 * usp_inf_auto_auth_unlock_failed exists so that a failed password attempt is
 * still recorded even though no configuration change follows it. A run of those
 * rows is the signature worth being able to see.
 */

/*
 * QUOTED_IDENTIFIER is captured at CREATE PROCEDURE time and baked into the
 * procedure, not taken from the caller's session. usp_inf_auto_auth_set uses
 * MERGE, which SQL Server refuses to run unless the setting was ON when the
 * procedure was compiled — so a procedure created through a client that
 * defaults it OFF (sqlcmd does; Microsoft.Data.SqlClient does not) fails at
 * every call, forever, with an error that points at the MERGE rather than at
 * the deploy. Setting it explicitly makes the deploy path irrelevant.
 */
SET QUOTED_IDENTIFIER ON;
GO

/* ---- what is configurable, and what is currently switched on --------------
 *
 * Returns the catalogue the settings screen renders: every active test and
 * profile, left-joined to its rule. Tests with no rule come back enabled = 0,
 * which is the default and the reason absence-of-row means disabled.
 *
 * @search keeps the payload sane — Noble carries several thousand tests.
 */
CREATE OR ALTER PROCEDURE dbo.usp_inf_auto_auth_list
    @search    NVARCHAR(100) = NULL,
    @only_enabled BIT        = 0,
    @top       INT           = 200
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @like NVARCHAR(120) = '%' + LTRIM(RTRIM(ISNULL(@search, ''))) + '%';

    ;WITH catalogue AS (
        SELECT 'test' AS scope_type,
               CONVERT(NVARCHAR(50), t.TestCode) AS scope_key,
               CONVERT(NVARCHAR(200), ISNULL(t.ReportTestname, t.Testname)) AS label,
               d.Name AS department_name,
               t.DepartmentId AS department_id
        FROM dbo.tbl_med_test_master t
        LEFT JOIN dbo.tbl_med_department_master d ON d.id = t.DepartmentId
        WHERE ISNULL(t.IsActive, 1) = 1

        UNION ALL

        SELECT 'department',
               CONVERT(NVARCHAR(50), d.id),
               CONVERT(NVARCHAR(200), d.Name),
               d.Name,
               d.id
        FROM dbo.tbl_med_department_master d
        WHERE ISNULL(d.IsActive, 1) = 1
    )
    SELECT TOP (@top)
        c.scope_type,
        c.scope_key,
        c.label,
        c.department_name,
        ISNULL(cfg.enabled, 0)            AS enabled,
        ISNULL(cfg.require_in_range, 1)   AS require_in_range,
        ISNULL(cfg.allow_out_of_range, 0) AS allow_out_of_range,
        ISNULL(cfg.numeric_only, 1)       AS numeric_only,
        cfg.updated_at,
        cfg.updated_by_username
    FROM catalogue c
    LEFT JOIN dbo.inf_auto_auth_config cfg
           ON cfg.scope_type = c.scope_type AND cfg.scope_key = c.scope_key
    WHERE (@search IS NULL OR LTRIM(RTRIM(@search)) = ''
           OR c.label LIKE @like OR c.scope_key LIKE @like)
      AND (@only_enabled = 0 OR ISNULL(cfg.enabled, 0) = 1)
    ORDER BY ISNULL(cfg.enabled, 0) DESC, c.scope_type, c.label;
END
GO

/* ---- apply a change ------------------------------------------------------ */
CREATE OR ALTER PROCEDURE dbo.usp_inf_auto_auth_set
    @scope_type         VARCHAR(12),
    @scope_key          NVARCHAR(50),
    @scope_label        NVARCHAR(200) = NULL,
    @enabled            BIT,
    @require_in_range   BIT = 1,
    @allow_out_of_range BIT = 0,
    @actor_user_id      INT,
    @actor_ip           VARCHAR(64) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    IF @scope_type NOT IN ('test', 'profile', 'department')
    BEGIN
        RAISERROR('Scope must be test, profile or department.', 16, 1);
        RETURN;
    END

    -- Refuse the dangerous combination outright rather than relying on the
    -- CHECK constraint to produce an opaque error. Authorising out-of-range
    -- results without a range check means releasing anything the analyser
    -- produces, unread.
    IF @require_in_range = 0 AND @allow_out_of_range = 0
    BEGIN
        RAISERROR('Auto-authorisation must either require an in-range value or explicitly allow out-of-range results.', 16, 1);
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

    BEGIN TRY
        BEGIN TRANSACTION;

        DECLARE @old_enabled BIT =
            (SELECT enabled FROM dbo.inf_auto_auth_config
             WHERE scope_type = @scope_type AND scope_key = @scope_key);

        -- HOLDLOCK is required, not optional: without it MERGE takes only an
        -- update lock on the matched row and two concurrent callers can both
        -- fall through to NOT MATCHED, producing a unique-key violation on
        -- UQ_inf_auto_auth_scope. It serialises on the key range instead.
        MERGE dbo.inf_auto_auth_config WITH (HOLDLOCK) AS target
        USING (SELECT @scope_type AS scope_type, @scope_key AS scope_key) AS src
           ON target.scope_type = src.scope_type AND target.scope_key = src.scope_key
        WHEN MATCHED THEN UPDATE SET
            enabled             = @enabled,
            require_in_range    = @require_in_range,
            allow_out_of_range  = @allow_out_of_range,
            scope_label         = COALESCE(@scope_label, target.scope_label),
            updated_at          = SYSDATETIMEOFFSET(),
            updated_by          = @actor_user_id,
            updated_by_username = @actor_username,
            origin              = @origin
        WHEN NOT MATCHED THEN INSERT
            (scope_type, scope_key, scope_label, enabled, require_in_range, allow_out_of_range,
             updated_at, updated_by, updated_by_username, origin)
            VALUES (@scope_type, @scope_key, @scope_label, @enabled, @require_in_range, @allow_out_of_range,
                    SYSDATETIMEOFFSET(), @actor_user_id, @actor_username, @origin);

        INSERT INTO dbo.inf_auto_auth_audit
            (action, scope_type, scope_key, scope_label, old_enabled, new_enabled, detail,
             actor_user_id, actor_username, actor_ip, origin)
        VALUES (CASE WHEN @old_enabled IS NULL THEN (CASE WHEN @enabled = 1 THEN 'enable' ELSE 'disable' END)
                     WHEN @old_enabled = @enabled THEN 'update'
                     WHEN @enabled = 1 THEN 'enable' ELSE 'disable' END,
                @scope_type, @scope_key, @scope_label, @old_enabled, @enabled,
                CONCAT('require_in_range=', @require_in_range, ' allow_out_of_range=', @allow_out_of_range),
                @actor_user_id, @actor_username, @actor_ip, @origin);

        COMMIT TRANSACTION;

        SELECT @scope_type AS scope_type, @scope_key AS scope_key, @enabled AS enabled;
    END TRY
    BEGIN CATCH
        IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
        THROW;
    END CATCH
END
GO

/* ---- record a rejected unlock attempt ------------------------------------ */
CREATE OR ALTER PROCEDURE dbo.usp_inf_auto_auth_unlock_failed
    @scope_type    VARCHAR(12)  = NULL,
    @scope_key     NVARCHAR(50) = NULL,
    @actor_user_id INT,
    @actor_ip      VARCHAR(64)  = NULL
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @actor_username NVARCHAR(50) =
        (SELECT Username FROM dbo.tbl_med_user_master WHERE id = @actor_user_id);

    INSERT INTO dbo.inf_auto_auth_audit
        (action, scope_type, scope_key, detail, actor_user_id, actor_username, actor_ip, origin)
    VALUES ('unlock_failed', @scope_type, @scope_key, 'Incorrect auto-authorisation password.',
            @actor_user_id, ISNULL(@actor_username, '(unknown)'), @actor_ip,
            'inf:' + CONVERT(VARCHAR(20), @actor_user_id));
END
GO

/* ---- the auto-authorisation change log ----------------------------------- */
CREATE OR ALTER PROCEDURE dbo.usp_inf_auto_auth_audit_read
    @top INT = 100
AS
BEGIN
    SET NOCOUNT ON;

    SELECT TOP (@top)
        id, action, scope_type, scope_key, scope_label,
        old_enabled, new_enabled, detail,
        actor_username, actor_ip, occurred_at
    FROM dbo.inf_auto_auth_audit
    ORDER BY occurred_at DESC, id DESC;
END
GO
