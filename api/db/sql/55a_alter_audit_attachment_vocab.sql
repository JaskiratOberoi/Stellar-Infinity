/*
 * 55a_alter_audit_attachment_vocab.sql
 *
 * Adds 'attach' / 'detach' actions and the 'attachment' field to the result
 * audit, so worksheet attachments are recorded like every other change to a
 * sample.
 *
 * The legacy system records neither. Its DeleteGraph removes the row outright
 * with no confirmation and no trace, so an attachment that is no longer there
 * cannot be explained — not who removed it, not when, not whether it ever
 * existed. For a document that may be the only evidence behind a released
 * result, that is the gap worth closing first.
 *
 * Numbered 55a so it lands before 56 (the procedures that write these values)
 * without renumbering anything already deployed.
 *
 * Idempotent: constraints are dropped if present and recreated.
 */
SET NOCOUNT ON;
SET QUOTED_IDENTIFIER ON;
GO

IF OBJECT_ID('dbo.inf_result_audit', 'U') IS NULL
BEGIN
    RAISERROR('dbo.inf_result_audit does not exist. Run 40 first.', 16, 1);
    RETURN;
END
GO

IF EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_inf_result_audit_action')
    ALTER TABLE dbo.inf_result_audit DROP CONSTRAINT CK_inf_result_audit_action;
GO

ALTER TABLE dbo.inf_result_audit WITH CHECK ADD CONSTRAINT CK_inf_result_audit_action
    CHECK (action IN (
        'enter',            -- first value into an empty result
        'amend',            -- an existing value overwritten or cleared
        'derive',           -- computed server-side (the abnormal flag)
        'authorize',        -- a person signed it out
        'auto_authorize',   -- a configured rule signed it out
        'unauthorize',
        'reopen',
        'status',           -- sample status transition
        'reject',
        'import',
        'attach',           -- a document added to the sample
        'detach'));         -- and removed again
GO

IF EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_inf_result_audit_field')
    ALTER TABLE dbo.inf_result_audit DROP CONSTRAINT CK_inf_result_audit_field;
GO

ALTER TABLE dbo.inf_result_audit WITH CHECK ADD CONSTRAINT CK_inf_result_audit_field
    CHECK (field IN ('value', 'auth', 'abnormal', 'comments', 'status', 'attachment'));
GO

PRINT 'Audit vocabulary extended for attachments.';
GO
