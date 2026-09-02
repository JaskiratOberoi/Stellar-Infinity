/*
 * 20_usp_inf_admin_create_user.sql
 *
 * Onboards a new INFINITY user. Atomic: one row in tbl_med_user_master (the
 * shared LIS user table), one in dbo.inf_user_role, one in dbo.inf_account.
 *
 * The LIS usertypeid is required because LIS screens key on it, and because the
 * account may later be granted LIS access. The Infinity role is what actually
 * drives access to Infinity's own features.
 *
 * LIS LOCK — the point of the whole design: the LIS row is created with
 * IsActive = 0 and inf_account.lis_access = 0, so these credentials CANNOT sign
 * in to the legacy LIS until an admin explicitly grants access via
 * usp_inf_admin_set_lis_access. The account works in Infinity immediately,
 * because usp_inf_authenticate gates Infinity-managed accounts on
 * inf_account.inf_active (= 1 here), never on IsActive.
 *
 * Username uniqueness is enforced here because the LIS table has no unique
 * index on it — a duplicate would make login ambiguous rather than failing.
 *
 * Returns { ok, error_code, message, user_id }.
 */
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
    IF @infinityRole NOT IN (N'super_admin', N'admin', N'lab_manager',
                             N'technician', N'reporting', N'client',
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
