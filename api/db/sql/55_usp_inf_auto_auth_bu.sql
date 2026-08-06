/*
 * 55_usp_inf_auto_auth_bu.sql
 *
 * Auto-authorisation read/write, per test per business unit. Supersedes the
 * department-scoped bodies in script 53 (same procedure names, so this is a
 * replacement, not a parallel path).
 */
SET QUOTED_IDENTIFIER ON;
GO

/* ---- the catalogue: active tests, left-joined to their rule --------------
 *
 * @business_unit_id selects WHICH unit's rules are shown. NULL means the
 * blanket "all units" rule. The catalogue itself does not change per unit —
 * every test exists everywhere — only which rule row is attached to it.
 */
CREATE OR ALTER PROCEDURE dbo.usp_inf_auto_auth_list
    @search           NVARCHAR(100) = NULL,
    @only_enabled     BIT           = 0,
    @business_unit_id INT           = NULL,
    @page             INT           = 1,
    @page_size        INT           = 200
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @pageSafe INT = CASE WHEN @page < 1 THEN 1 ELSE @page END;
    DECLARE @size INT =
        CASE WHEN @page_size < 1 THEN 200
             WHEN @page_size > 1000 THEN 1000
             ELSE @page_size END;
    DECLARE @offset INT = (@pageSafe - 1) * @size;
    DECLARE @like NVARCHAR(120) = '%' + LTRIM(RTRIM(ISNULL(@search, ''))) + '%';

    SELECT
        scope_type   = 'test',
        scope_key    = CONVERT(NVARCHAR(50), t.TestCode),
        label        = CONVERT(NVARCHAR(200), ISNULL(t.ReportTestname, t.Testname)),
        department_name = d.Name,          -- shown as context, no longer a scope
        business_unit_id   = @business_unit_id,
        business_unit_name = bu.BusinessUnitName,
        enabled            = ISNULL(cfg.enabled, 0),
        require_in_range   = ISNULL(cfg.require_in_range, 1),
        allow_out_of_range = ISNULL(cfg.allow_out_of_range, 0),
        numeric_only       = ISNULL(cfg.numeric_only, 1),
        cfg.updated_at,
        cfg.updated_by_username,
        total_count = COUNT(*) OVER()
    FROM dbo.tbl_med_test_master t
    LEFT JOIN dbo.tbl_med_department_master d ON d.id = t.DepartmentId
    LEFT JOIN dbo.tbl_med_business_unit_master bu ON bu.id = @business_unit_id
    LEFT JOIN dbo.inf_auto_auth_config cfg
           ON cfg.scope_type = 'test'
          AND cfg.scope_key  = CONVERT(NVARCHAR(50), t.TestCode)
          -- NULL = NULL is not true in SQL, so the blanket rule needs its own
          -- arm rather than a plain equality.
          AND ((@business_unit_id IS NULL AND cfg.business_unit_id IS NULL)
            OR (cfg.business_unit_id = @business_unit_id))
    WHERE ISNULL(t.IsActive, 1) = 1
      AND (@search IS NULL OR LTRIM(RTRIM(@search)) = ''
           OR t.Testname LIKE @like OR t.ReportTestname LIKE @like OR t.TestCode LIKE @like)
      AND (@only_enabled = 0 OR ISNULL(cfg.enabled, 0) = 1)
    ORDER BY ISNULL(cfg.enabled, 0) DESC, label, t.TestCode
    OFFSET @offset ROWS FETCH NEXT @size ROWS ONLY;
END
GO

/* ---- the business units a rule can be scoped to -------------------------- */
CREATE OR ALTER PROCEDURE dbo.usp_inf_business_units
AS
BEGIN
    SET NOCOUNT ON;
    SELECT id, code = BusinessUnitCode, name = BusinessUnitName
    FROM dbo.tbl_med_business_unit_master
    WHERE ISNULL(IsActive, 1) = 1
    ORDER BY BusinessUnitName;
END
GO

/* ---- apply a change ------------------------------------------------------ */
CREATE OR ALTER PROCEDURE dbo.usp_inf_auto_auth_set
    @scope_type         VARCHAR(12),
    @scope_key          NVARCHAR(50),
    @scope_label        NVARCHAR(200) = NULL,
    @business_unit_id   INT           = NULL,
    @enabled            BIT,
    @require_in_range   BIT = 1,
    @allow_out_of_range BIT = 0,
    @actor_user_id      INT,
    @actor_ip           VARCHAR(64) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    IF @scope_type NOT IN ('test', 'profile')
    BEGIN
        RAISERROR('Scope must be test or profile. Department scoping was retired in migration 54.', 16, 1);
        RETURN;
    END

    IF @require_in_range = 0 AND @allow_out_of_range = 0
    BEGIN
        RAISERROR('Auto-authorisation must either require an in-range value or explicitly allow out-of-range results.', 16, 1);
        RETURN;
    END

    IF @business_unit_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM dbo.tbl_med_business_unit_master WHERE id = @business_unit_id)
    BEGIN
        RAISERROR('Unknown business unit.', 16, 1);
        RETURN;
    END

    DECLARE @origin VARCHAR(64) = 'inf:' + CONVERT(VARCHAR(20), @actor_user_id);
    DECLARE @actor_username NVARCHAR(50) =
        (SELECT Username FROM dbo.tbl_med_user_master WHERE id = @actor_user_id);
    DECLARE @bu_name NVARCHAR(100) =
        (SELECT BusinessUnitName FROM dbo.tbl_med_business_unit_master WHERE id = @business_unit_id);

    IF @actor_username IS NULL
    BEGIN
        RAISERROR('Unknown acting user.', 16, 1);
        RETURN;
    END

    BEGIN TRY
        BEGIN TRANSACTION;

        DECLARE @old_enabled BIT =
            (SELECT enabled FROM dbo.inf_auto_auth_config
             WHERE scope_type = @scope_type AND scope_key = @scope_key
               AND ((@business_unit_id IS NULL AND business_unit_id IS NULL)
                 OR (business_unit_id = @business_unit_id)));

        -- HOLDLOCK: without it two concurrent callers can both miss the match
        -- and both insert, violating the uniqueness indexes from script 54.
        MERGE dbo.inf_auto_auth_config WITH (HOLDLOCK) AS target
        USING (SELECT @scope_type AS scope_type, @scope_key AS scope_key,
                      @business_unit_id AS business_unit_id) AS src
           ON target.scope_type = src.scope_type
          AND target.scope_key  = src.scope_key
          AND ((src.business_unit_id IS NULL AND target.business_unit_id IS NULL)
            OR (target.business_unit_id = src.business_unit_id))
        WHEN MATCHED THEN UPDATE SET
            enabled             = @enabled,
            require_in_range    = @require_in_range,
            allow_out_of_range  = @allow_out_of_range,
            scope_label         = COALESCE(@scope_label, target.scope_label),
            business_unit_name  = @bu_name,
            updated_at          = SYSDATETIMEOFFSET(),
            updated_by          = @actor_user_id,
            updated_by_username = @actor_username,
            origin              = @origin
        WHEN NOT MATCHED THEN INSERT
            (scope_type, scope_key, scope_label, business_unit_id, business_unit_name,
             enabled, require_in_range, allow_out_of_range,
             updated_at, updated_by, updated_by_username, origin)
            VALUES (@scope_type, @scope_key, @scope_label, @business_unit_id, @bu_name,
                    @enabled, @require_in_range, @allow_out_of_range,
                    SYSDATETIMEOFFSET(), @actor_user_id, @actor_username, @origin);

        INSERT INTO dbo.inf_auto_auth_audit
            (action, scope_type, scope_key, scope_label, business_unit_id, business_unit_name,
             old_enabled, new_enabled, detail, actor_user_id, actor_username, actor_ip, origin)
        VALUES (CASE WHEN @old_enabled IS NULL THEN (CASE WHEN @enabled = 1 THEN 'enable' ELSE 'disable' END)
                     WHEN @old_enabled = @enabled THEN 'update'
                     WHEN @enabled = 1 THEN 'enable' ELSE 'disable' END,
                @scope_type, @scope_key, @scope_label, @business_unit_id, @bu_name,
                @old_enabled, @enabled,
                CONCAT('unit=', ISNULL(@bu_name, N'ALL'),
                       ' require_in_range=', @require_in_range,
                       ' allow_out_of_range=', @allow_out_of_range),
                @actor_user_id, @actor_username, @actor_ip, @origin);

        COMMIT TRANSACTION;

        SELECT scope_type = @scope_type, scope_key = @scope_key,
               business_unit_id = @business_unit_id, enabled = @enabled;
    END TRY
    BEGIN CATCH
        IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
        THROW;
    END CATCH
END
GO

/* ---- the change log, now carrying the unit ------------------------------- */
CREATE OR ALTER PROCEDURE dbo.usp_inf_auto_auth_audit_read
    @page      INT = 1,
    @page_size INT = 100
AS
BEGIN
    SET NOCOUNT ON;
    DECLARE @pageSafe INT = CASE WHEN @page < 1 THEN 1 ELSE @page END;
    DECLARE @size INT = CASE WHEN @page_size < 1 THEN 100 WHEN @page_size > 500 THEN 500 ELSE @page_size END;

    SELECT id, action, scope_type, scope_key, scope_label,
           business_unit_id, business_unit_name,
           old_enabled, new_enabled, detail,
           actor_username, actor_ip, occurred_at,
           total_count = COUNT(*) OVER()
    FROM dbo.inf_auto_auth_audit
    ORDER BY occurred_at DESC, id DESC
    OFFSET (@pageSafe - 1) * @size ROWS FETCH NEXT @size ROWS ONLY;
END
GO
