/*
 * 42_append_only_audit.sql
 *
 * Makes the audit tables genuinely append-only.
 *
 * WHY A TRIGGER AND NOT JUST DENY
 * The obvious approach — DENY UPDATE, DELETE to the application login — does
 * not work here. The application connects as `nobleone`, which maps to `dbo` in
 * Noble, and SQL Server refuses: "Cannot grant, deny, or revoke permissions to
 * sa, dbo, entity owner, information_schema, sys, or yourself." So the DENY in
 * scripts 40/41 silently achieves nothing for the account that actually writes.
 *
 * A rollback trigger is enforced by the engine regardless of who the caller is,
 * including dbo. A determined dbo can still disable or drop the trigger, but
 * that is a deliberate, visible act — quite different from an ordinary UPDATE
 * statement quietly rewriting clinical history.
 *
 * Applies to both trails. Idempotent: CREATE OR ALTER.
 */
SET NOCOUNT ON;
GO

CREATE OR ALTER TRIGGER dbo.trg_inf_result_audit_append_only
ON dbo.inf_result_audit
AFTER UPDATE, DELETE
AS
BEGIN
    SET NOCOUNT ON;
    ROLLBACK TRANSACTION;
    RAISERROR('dbo.inf_result_audit is append-only: UPDATE and DELETE are not permitted. Correct a mistaken entry by appending a compensating row.', 16, 1);
END
GO

CREATE OR ALTER TRIGGER dbo.trg_inf_auth_audit_append_only
ON dbo.inf_auth_audit
AFTER UPDATE, DELETE
AS
BEGIN
    SET NOCOUNT ON;
    ROLLBACK TRANSACTION;
    RAISERROR('dbo.inf_auth_audit is append-only: UPDATE and DELETE are not permitted.', 16, 1);
END
GO

/*
 * Prove it. A claim that a table is append-only must be tested, not asserted —
 * the DENY in scripts 40/41 reported success while doing nothing.
 *
 * The self-test writes one row it then cannot remove (that being the point), so
 * it runs ONCE. On re-deploy it confirms the triggers are still in place rather
 * than accumulating a test row per deploy.
 */
SET NOCOUNT ON;

IF EXISTS (SELECT 1 FROM dbo.inf_result_audit WHERE actor_username = '__selftest__')
BEGIN
    IF EXISTS (SELECT 1 FROM sys.triggers WHERE name = 'trg_inf_result_audit_append_only' AND is_disabled = 0)
       AND EXISTS (SELECT 1 FROM sys.triggers WHERE name = 'trg_inf_auth_audit_append_only' AND is_disabled = 0)
        PRINT 'Append-only triggers present and enabled (self-test already run).';
    ELSE
        RAISERROR('An append-only trigger is missing or DISABLED - the audit tables are rewritable.', 16, 1);
    RETURN;
END

DECLARE @ok BIT = 1;

INSERT INTO dbo.inf_result_audit (action, field, old_value, new_value, actor_username, source, reason)
VALUES ('enter', 'value', NULL, '__append_only_selftest__', '__selftest__', 'api', NULL);

DECLARE @id BIGINT = SCOPE_IDENTITY();

BEGIN TRY
    UPDATE dbo.inf_result_audit SET new_value = 'tampered' WHERE id = @id;
    SET @ok = 0;   -- reached only if the trigger did NOT fire
END TRY
BEGIN CATCH
    IF @@TRANCOUNT = 0 AND ERROR_NUMBER() <> 3609 SET @ok = @ok;  -- expected rollback
END CATCH

IF EXISTS (SELECT 1 FROM dbo.inf_result_audit WHERE id = @id AND new_value = 'tampered')
    SET @ok = 0;

BEGIN TRY
    DELETE FROM dbo.inf_result_audit WHERE id = @id;
END TRY
BEGIN CATCH
END CATCH

IF NOT EXISTS (SELECT 1 FROM dbo.inf_result_audit WHERE id = @id)
BEGIN
    SET @ok = 0;
    PRINT 'FAIL: the self-test row was deleted - the table is NOT append-only.';
END

IF @ok = 1
    PRINT 'Verified: dbo.inf_result_audit rejects UPDATE and DELETE.';
ELSE
    RAISERROR('Append-only enforcement is NOT working on dbo.inf_result_audit.', 16, 1);
GO
