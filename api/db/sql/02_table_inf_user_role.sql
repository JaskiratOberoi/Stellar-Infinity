/*
 * 02_table_inf_user_role.sql
 *
 * Infinity-only mapping: LIS user_id -> one Infinity role.
 *
 * Authentication still flows through tbl_med_user_master via
 * usp_inf_authenticate; this table only assigns the Infinity-side role. Users
 * without a row fall back to a role derived in code from their LIS usertypeid
 * (see Auth/InfinityRoles.cs), so every existing LIS user gets a sensible role
 * on first login with no rows written and no LIS schema change.
 *
 * The LIS Super Admin (usertypeid = 1) is treated as super_admin on first login
 * so the admin panel is reachable from day one — otherwise granting the first
 * role would require a role nobody has yet.
 *
 * Idempotent: created only if missing.
 */
SET NOCOUNT ON;

IF OBJECT_ID('dbo.inf_user_role', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.inf_user_role (
        id          INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
        user_id     INT           NOT NULL,
        role        NVARCHAR(30)  NOT NULL,
        assigned_by INT           NULL,
        assigned_at DATETIME2     NOT NULL CONSTRAINT DF_inf_user_role_assigned DEFAULT SYSDATETIME(),
        CONSTRAINT UQ_inf_user_role_user UNIQUE (user_id)
    );

    PRINT 'Created dbo.inf_user_role.';
END
ELSE
BEGIN
    PRINT 'dbo.inf_user_role already present.';
END
GO
