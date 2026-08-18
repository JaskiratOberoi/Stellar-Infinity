/*
 * 109a_alter_audit_grant_vocab.sql
 *
 * Adds the 'grant' action and the 'capability' field, so a per-user capability
 * grant (109/110) leaves a permanent trace of who gave what to whom.
 *
 * Numbered 109a so it lands between the table (109) and the procedure that
 * writes these rows (110) — the procedure would fail its first CHECK otherwise.
 *
 * ---------------------------------------------------------------------------
 * THE LISTS BELOW ARE THE FULL VOCABULARY, NOT THIS SCRIPT'S ADDITIONS.
 *
 * SQL Server cannot add a value to a CHECK constraint; it has to be dropped
 * and recreated whole, which makes these scripts last-writer-wins. Everything
 * 40 established, 55a's attachments, 103's patient fields, 106's inward
 * transit and the grant values added here must all appear, or rows another
 * feature has already written become retroactively invalid. Only ever append.
 * ---------------------------------------------------------------------------
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
        'detach',           -- and removed again
        'patient_edit',     -- demographics or referral corrected
        'inward',           -- a transit scan touched the sample
        'grant'));          -- a capability given to or taken from ONE user
GO

IF EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_inf_result_audit_field')
    ALTER TABLE dbo.inf_result_audit DROP CONSTRAINT CK_inf_result_audit_field;
GO

ALTER TABLE dbo.inf_result_audit WITH CHECK ADD CONSTRAINT CK_inf_result_audit_field
    CHECK (field IN (
        -- result vocabulary (40)
        'value', 'auth', 'abnormal', 'comments', 'status',
        -- attachments (55a)
        'attachment',
        -- patient demographics and referral (103)
        'title', 'name', 'age', 'age_type', 'sex',
        'ref_doctor', 'ref_doctor_other',
        'ref_customer', 'ref_customer_other',
        'mobile', 'email',
        'sample_time', 'clinical_history',
        -- inward transit (106)
        'business_unit',
        -- per-user capability grants (109a). These rows carry no vailid: they
        -- are about a USER, not a sample, and the column is nullable.
        'capability'));
GO

PRINT 'Audit vocabulary extended for per-user capability grants.';
GO
