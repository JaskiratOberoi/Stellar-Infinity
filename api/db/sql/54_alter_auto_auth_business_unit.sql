/*
 * 54_alter_auto_auth_business_unit.sql
 *
 * Auto-authorisation moves from DEPARTMENT scoping to BUSINESS UNIT scoping,
 * applied per test.
 *
 * ---------------------------------------------------------------------------
 * WHY
 *
 * A department is a property of the TEST — potassium is biochemistry wherever
 * it runs. Enabling automatic release "for biochemistry" therefore enabled it
 * everywhere at once, including branches whose analysers, calibration and
 * staffing the person clicking the toggle had never seen.
 *
 * A business unit is a property of the SAMPLE: which lab actually ran it. That
 * is the real unit of trust here, because whether an in-range result can be
 * released unread depends on the bench that produced it, not on which
 * discipline the assay belongs to. So a rule is now (test, business unit), and
 * a lab can switch a test to automatic release at the main lab while leaving
 * it manual at a satellite.
 *
 * business_unit_id NULL means EVERY unit. A rule for a specific unit beats the
 * blanket one — see the resolution order in usp_inf_result_save.
 *
 * Existing 'department' rows are DELETED rather than migrated. There is no
 * honest mapping from "this discipline" to "this branch", and silently
 * reinterpreting a department rule as a business-unit rule would change which
 * patients' results get released without review. Deleting is the safe
 * direction: it fails closed, and the audit trail records the removal.
 *
 * Idempotent.
 */
SET NOCOUNT ON;
SET QUOTED_IDENTIFIER ON;
GO

IF OBJECT_ID('dbo.inf_auto_auth_config', 'U') IS NULL
BEGIN
    RAISERROR('dbo.inf_auto_auth_config does not exist. Run 46 first.', 16, 1);
    RETURN;
END
GO

-- ---- 1. the column -------------------------------------------------------
IF COL_LENGTH('dbo.inf_auto_auth_config', 'business_unit_id') IS NULL
BEGIN
    ALTER TABLE dbo.inf_auto_auth_config ADD business_unit_id INT NULL;
    PRINT 'Added inf_auto_auth_config.business_unit_id (NULL = all units).';
END
GO

IF COL_LENGTH('dbo.inf_auto_auth_config', 'business_unit_name') IS NULL
BEGIN
    -- Captured at configuration time so the settings screen and the audit stay
    -- readable if the unit is later renamed.
    ALTER TABLE dbo.inf_auto_auth_config ADD business_unit_name NVARCHAR(100) NULL;
    PRINT 'Added inf_auto_auth_config.business_unit_name.';
END
GO

IF COL_LENGTH('dbo.inf_auto_auth_audit', 'business_unit_id') IS NULL
BEGIN
    ALTER TABLE dbo.inf_auto_auth_audit ADD business_unit_id INT NULL;
    ALTER TABLE dbo.inf_auto_auth_audit ADD business_unit_name NVARCHAR(100) NULL;
    PRINT 'Added business unit columns to inf_auto_auth_audit.';
END
GO

-- ---- 2. retire the department scope --------------------------------------
IF EXISTS (SELECT 1 FROM dbo.inf_auto_auth_config WHERE scope_type = 'department')
BEGIN
    -- Record the removal before making it, so the trail explains why a rule
    -- someone remembers switching on is no longer there.
    INSERT INTO dbo.inf_auto_auth_audit
        (action, scope_type, scope_key, scope_label, old_enabled, new_enabled, detail,
         actor_user_id, actor_username, origin)
    SELECT 'disable', c.scope_type, c.scope_key, c.scope_label, c.enabled, 0,
           'Department scoping retired; auto-authorisation is now per test per business unit.',
           0, '(migration 54)', 'inf:0'
    FROM dbo.inf_auto_auth_config c
    WHERE c.scope_type = 'department';

    DELETE FROM dbo.inf_auto_auth_config WHERE scope_type = 'department';
    PRINT 'Removed department-scoped rules (recorded in inf_auto_auth_audit).';
END
GO

IF EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_inf_auto_auth_scope_type')
    ALTER TABLE dbo.inf_auto_auth_config DROP CONSTRAINT CK_inf_auto_auth_scope_type;
GO
ALTER TABLE dbo.inf_auto_auth_config WITH CHECK ADD CONSTRAINT CK_inf_auto_auth_scope_type
    CHECK (scope_type IN ('test', 'profile'));
GO

-- ---- 3. uniqueness now includes the unit ---------------------------------
-- A NULL business_unit_id (the "all units" rule) must be able to coexist with
-- per-unit rules for the same test. A plain UNIQUE constraint treats NULLs as
-- distinct in SQL Server only once, so the blanket rule is separated into its
-- own filtered index.
IF EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = 'UQ_inf_auto_auth_scope')
BEGIN
    ALTER TABLE dbo.inf_auto_auth_config DROP CONSTRAINT UQ_inf_auto_auth_scope;
    PRINT 'Dropped UQ_inf_auto_auth_scope (superseded by the per-unit indexes).';
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UX_inf_auto_auth_scope_unit')
    CREATE UNIQUE INDEX UX_inf_auto_auth_scope_unit
        ON dbo.inf_auto_auth_config (scope_type, scope_key, business_unit_id)
        WHERE business_unit_id IS NOT NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UX_inf_auto_auth_scope_all')
    CREATE UNIQUE INDEX UX_inf_auto_auth_scope_all
        ON dbo.inf_auto_auth_config (scope_type, scope_key)
        WHERE business_unit_id IS NULL;
GO

PRINT 'Auto-authorisation is now scoped per test per business unit.';
GO
