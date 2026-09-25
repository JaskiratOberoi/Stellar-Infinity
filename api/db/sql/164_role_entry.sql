SET QUOTED_IDENTIFIER ON;
GO
/*
 * 164_role_entry.sql
 *
 * The Infinity role "entry" — the LIS's ENTRY user type (id 33), the lab's
 * front desk: register orders, receive and reject tubes, keep referrers,
 * read reports; no worksheet, no billing, no analytics (the LIS shows that
 * desk no day-sales figures either). Defined in Auth/InfinityRoles.cs and
 * derived from the LIS user type at sign-in, so every ENTRY login lands on
 * it without an assignment. Here: the two admin procedures learn the name
 * (re-issued whole from 23 and 20, diffed equal to the deployed bodies
 * first), and the one ENTRY user who carried an explicit Infinity
 * assignment — MEENAGIRI (7053), 'reporting' — has it removed so she derives
 * the same role as the rest, with her session version bumped so the change
 * reaches her next request. ZZTEST01 (7214, inactive, a test login of the
 * same LIS type) keeps its 'client' assignment. 2026-09-25.
 */
CREATE OR ALTER PROCEDURE dbo.usp_inf_admin_set_role
    @userId INT,
    @role   NVARCHAR(30),
    @actor  INT
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    IF NOT EXISTS (SELECT 1 FROM dbo.tbl_med_user_master WHERE id = @userId)
    BEGIN
        SELECT ok = CAST(0 AS BIT), error_code = 'NOT_FOUND',
               message = N'User not found';
        RETURN;
    END

    /* Keep in step with Auth/InfinityRoles.cs and SP 20 (create_user). */
    IF @role NOT IN (N'super_admin', N'admin', N'sales', N'sales_exec', N'lab_manager',
                     N'technician', N'entry', N'reporting', N'client',
                     N'client_b2c', N'client_reporting', N'sub_client', N'viewer')
    BEGIN
        SELECT ok = CAST(0 AS BIT), error_code = 'VALIDATION',
               message = N'Unknown Infinity role';
        RETURN;
    END

    /* Escalation guard, both directions: only an LIS Super Admin may grant
       super_admin, or modify someone who already holds the LIS Super Admin type. */
    IF @role = N'super_admin'
       AND NOT EXISTS (SELECT 1 FROM dbo.tbl_med_user_master
                       WHERE id = @actor AND usertypeid = 1)
    BEGIN
        SELECT ok = CAST(0 AS BIT), error_code = 'FORBIDDEN',
               message = N'Only an LIS Super Admin may grant the Super Admin role';
        RETURN;
    END

    IF EXISTS (SELECT 1 FROM dbo.tbl_med_user_master
               WHERE id = @userId AND usertypeid = 1)
       AND NOT EXISTS (SELECT 1 FROM dbo.tbl_med_user_master
                       WHERE id = @actor AND usertypeid = 1)
    BEGIN
        SELECT ok = CAST(0 AS BIT), error_code = 'FORBIDDEN',
               message = N'Only an LIS Super Admin may modify this user';
        RETURN;
    END

    /* Demoting yourself out of user:manage strands the panel. */
    IF @userId = @actor AND @role <> N'super_admin' AND @role <> N'admin'
    BEGIN
        SELECT ok = CAST(0 AS BIT), error_code = 'VALIDATION',
               message = N'You cannot remove your own administrative role.';
        RETURN;
    END

    BEGIN TRY
        BEGIN TRAN;

        MERGE dbo.inf_user_role AS t
        USING (SELECT @userId AS user_id) AS s
            ON t.user_id = s.user_id
        WHEN MATCHED THEN
            UPDATE SET role = @role, assigned_by = @actor, assigned_at = SYSDATETIME()
        WHEN NOT MATCHED THEN
            INSERT (user_id, role, assigned_by) VALUES (@userId, @role, @actor);

        EXEC dbo.usp_inf_bump_session_version @userId = @userId, @reason = N'role changed';

        COMMIT;

        SELECT ok = CAST(1 AS BIT), error_code = CAST(NULL AS VARCHAR(20)),
               message = CAST(NULL AS NVARCHAR(200));
    END TRY
    BEGIN CATCH
        IF @@TRANCOUNT > 0 ROLLBACK;
        SELECT ok = CAST(0 AS BIT), error_code = 'INTERNAL',
               message = LEFT(ERROR_MESSAGE(), 200);
    END CATCH
END
GO

CREATE OR ALTER PROCEDURE dbo.usp_inf_admin_create_user
    @username      NVARCHAR(50),
    @password      NVARCHAR(50),
    @firstName     NVARCHAR(100),
    @lastName      NVARCHAR(100) = NULL,
    @email         NVARCHAR(100) = NULL,
    @lisUsertypeId INT,
    @infinityRole  NVARCHAR(30),
    @grantLisAccess BIT = 0,
    @actor         INT
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE @clean NVARCHAR(50) = LTRIM(RTRIM(@username));

    IF @clean IS NULL OR @clean = N''
       OR @password IS NULL OR LTRIM(RTRIM(@password)) = N''
    BEGIN
        SELECT ok = CAST(0 AS BIT), error_code = 'VALIDATION',
               message = N'Username and password are required',
               user_id = CAST(NULL AS INT);
        RETURN;
    END

    /* Keep this list in step with Auth/InfinityRoles.cs and SP 23 (set_role).
       Telo shipped a version of this guard that omitted roles its own admin
       panel offered, making those users unsavable with "Unknown role" — if you
       add a role in code, deploy this procedure too. */
    IF @infinityRole NOT IN (N'super_admin', N'admin', N'sales', N'sales_exec', N'lab_manager',
                             N'technician', N'entry', N'reporting', N'client',
                     N'client_b2c', N'client_reporting', N'sub_client', N'viewer')
    BEGIN
        SELECT ok = CAST(0 AS BIT), error_code = 'VALIDATION',
               message = N'Unknown Infinity role',
               user_id = CAST(NULL AS INT);
        RETURN;
    END

    IF NOT EXISTS (SELECT 1 FROM dbo.tbl_med_usertypes
                   WHERE id = @lisUsertypeId AND IsActive = 1)
    BEGIN
        SELECT ok = CAST(0 AS BIT), error_code = 'VALIDATION',
               message = N'Unknown or inactive LIS user type',
               user_id = CAST(NULL AS INT);
        RETURN;
    END

    IF EXISTS (SELECT 1 FROM dbo.tbl_med_user_master WHERE Username = @clean)
    BEGIN
        SELECT ok = CAST(0 AS BIT), error_code = 'CONFLICT',
               message = N'Username already exists',
               user_id = CAST(NULL AS INT);
        RETURN;
    END

    /* Only an LIS Super Admin may mint another Super Admin. Privilege
       escalation guard: without it, any admin could create an account more
       powerful than their own and log into it. */
    IF @infinityRole = N'super_admin'
       AND NOT EXISTS (SELECT 1 FROM dbo.tbl_med_user_master
                       WHERE id = @actor AND usertypeid = 1)
    BEGIN
        SELECT ok = CAST(0 AS BIT), error_code = 'FORBIDDEN',
               message = N'Only an LIS Super Admin may create an Infinity Super Admin',
               user_id = CAST(NULL AS INT);
        RETURN;
    END

    DECLARE @newId INT;
    DECLARE @isActive BIT = CASE WHEN @grantLisAccess = 1 THEN 1 ELSE 0 END;

    BEGIN TRY
        BEGIN TRAN;

        INSERT INTO dbo.tbl_med_user_master
            (Username, password, firstname, lastname, Email,
             usertypeid, IsActive, createdby, createddate)
        VALUES
            (@clean, @password,
             LEFT(ISNULL(@firstName, N''), 100),
             LEFT(ISNULL(@lastName, N''), 100),
             LEFT(ISNULL(@email, N''), 100),
             @lisUsertypeId,
             @isActive,                      -- LIS-locked unless explicitly granted
             CONCAT(N'inf:', @actor),        -- Infinity origin marker, NOT 'telo:'
             GETDATE());

        SET @newId = SCOPE_IDENTITY();

        INSERT INTO dbo.inf_user_role (user_id, role, assigned_by)
        VALUES (@newId, @infinityRole, @actor);

        -- Marks the account Infinity-managed; usp_inf_authenticate keys off this.
        INSERT INTO dbo.inf_account (user_id, inf_active, lis_access, created_by)
        VALUES (@newId, 1, @grantLisAccess, @actor);

        COMMIT;

        SELECT ok = CAST(1 AS BIT), error_code = CAST(NULL AS VARCHAR(20)),
               message = CAST(NULL AS NVARCHAR(200)), user_id = @newId;
    END TRY
    BEGIN CATCH
        IF @@TRANCOUNT > 0 ROLLBACK;
        SELECT ok = CAST(0 AS BIT), error_code = 'INTERNAL',
               message = LEFT(ERROR_MESSAGE(), 200),
               user_id = CAST(NULL AS INT);
    END CATCH
END
GO

/* ---- ENTRY users derive the role: drop the one explicit assignment ------ */
DELETE r FROM dbo.inf_user_role r
JOIN dbo.tbl_med_user_master u ON u.id = r.user_id
WHERE u.usertypeid = 33 AND u.IsActive = 1 AND r.role <> N'entry';
PRINT CONCAT('assignments removed: ', @@ROWCOUNT);
EXEC dbo.usp_inf_bump_session_version @userId = 7053, @reason = N'role now derived: entry';
GO
SELECT u.id, u.Username, u.IsActive, r.role AS inf_override FROM dbo.tbl_med_user_master u LEFT JOIN dbo.inf_user_role r ON r.user_id = u.id WHERE u.usertypeid = 33 ORDER BY u.Username;
GO
