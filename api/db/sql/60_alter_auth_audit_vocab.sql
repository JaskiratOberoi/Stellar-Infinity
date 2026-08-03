/*
 * 60_alter_auth_audit_vocab.sql
 *
 * Extends dbo.inf_auth_audit (script 41) with the account-administration events
 * the admin panel produces.
 *
 * Script 41's CHECK is a closed list written before the admin panel could grant
 * client codes or edit a profile. Two additions:
 *
 * 1. 'scope_change' — client-code access granted or revoked. This is the single
 *    most security-relevant admin action in the system: it decides which
 *    patients a user can see. It must be attributable, and it must record what
 *    the access was BEFORE, not merely that it changed.
 *
 * 2. 'profile_change' — name/email edits, which are innocuous but should not
 *    have to masquerade as some other event to be recorded at all.
 *
 * Idempotent.
 */
SET NOCOUNT ON;

IF OBJECT_ID('dbo.inf_auth_audit', 'U') IS NULL
BEGIN
    RAISERROR('dbo.inf_auth_audit does not exist. Run 41_table_inf_auth_audit.sql first.', 16, 1);
    RETURN;
END
GO

IF EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_inf_auth_audit_event')
    ALTER TABLE dbo.inf_auth_audit DROP CONSTRAINT CK_inf_auth_audit_event;
GO

ALTER TABLE dbo.inf_auth_audit WITH CHECK ADD CONSTRAINT CK_inf_auth_audit_event
    CHECK (event IN (
        'login', 'login_failed', 'login_blocked', 'logout',
        'password_change', 'token_revoked',
        'role_change', 'lis_access_change', 'active_change',
        'scope_change',      -- client-code access granted/revoked
        'profile_change',    -- name / email edited
        'user_created'));
GO

PRINT 'Extended dbo.inf_auth_audit vocabulary for admin actions.';
GO
