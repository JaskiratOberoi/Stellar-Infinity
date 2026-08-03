/*
 * 45_alter_audit_auto_auth_vocab.sql
 *
 * Extends the vocabulary of dbo.inf_result_audit (script 40) so that
 * auto-authorisation and server-derived changes are recordable.
 *
 * Script 40 was written before auto-authorisation existed, and its CHECK
 * constraints are — correctly — a closed list. Three additions are needed, and
 * each one exists because the alternative is worse:
 *
 * 1. action 'auto_authorize', and source 'auto'.
 *
 *    An authorisation the SYSTEM performed must never be indistinguishable from
 *    one a person performed. That is the exact failure of the legacy "Check"
 *    button: AutoAuthAndAbnormal ticks the authorise box for every in-range
 *    result, and the row it writes is identical to one a pathologist ticked by
 *    hand. Recording auto-authorisation as plain 'authorize' here would
 *    reproduce that, which would defeat the point of building the feature
 *    behind a password.
 *
 * 2. action 'derive'.
 *
 *    The high/low flag is computed server-side from the reference ranges — no
 *    person asserted it. Logging that as 'amend' would both misattribute it and
 *    trip the reason requirement, since nobody can supply a reason for an
 *    arithmetic consequence.
 *
 * 3. action 'status'.
 *
 *    A sample status transition (4 -> 5 -> 7) is its own kind of event, not an
 *    amendment of a result.
 *
 * It also NARROWS the reason requirement. Script 40 demands a reason for every
 * 'amend', including an amended comment. Requiring a clinical justification to
 * fix a typo in a free-text note is the kind of friction that gets worked
 * around rather than complied with. The requirement is kept exactly where it
 * matters — overwriting a result VALUE, and reopening a signed-off sample —
 * and both are additionally enforced in usp_inf_result_save and
 * usp_inf_result_reopen, which fail with a readable message rather than a
 * constraint violation.
 *
 * Idempotent: each constraint is dropped if present and recreated.
 */
SET NOCOUNT ON;

IF OBJECT_ID('dbo.inf_result_audit', 'U') IS NULL
BEGIN
    RAISERROR('dbo.inf_result_audit does not exist. Run 40_table_inf_result_audit.sql first.', 16, 1);
    RETURN;
END
GO

-- ---- action -------------------------------------------------------------
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
        'import'));
GO

-- ---- source -------------------------------------------------------------
IF EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_inf_result_audit_source')
    ALTER TABLE dbo.inf_result_audit DROP CONSTRAINT CK_inf_result_audit_source;
GO

ALTER TABLE dbo.inf_result_audit WITH CHECK ADD CONSTRAINT CK_inf_result_audit_source
    CHECK (source IN ('ui', 'auto', 'instrument', 'import', 'api'));
GO

-- ---- reason -------------------------------------------------------------
IF EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_inf_result_audit_reason')
    ALTER TABLE dbo.inf_result_audit DROP CONSTRAINT CK_inf_result_audit_reason;
GO

ALTER TABLE dbo.inf_result_audit WITH CHECK ADD CONSTRAINT CK_inf_result_audit_reason
    CHECK (
        NOT (action = 'reopen' OR (action = 'amend' AND field = 'value'))
        OR (reason IS NOT NULL AND LTRIM(RTRIM(reason)) <> ''));
GO

PRINT 'Extended dbo.inf_result_audit vocabulary for auto-authorisation.';
GO
