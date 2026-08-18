/*
 * 103_alter_audit_patient_vocab.sql
 *
 * Adds the 'patient_edit' action and the demographic field names to the result
 * audit, so a correction made from the worksheet's "Edit patient info" is
 * recorded the same way a result change is.
 *
 * Why this matters more than it looks. Editing demographics is not cosmetic:
 * `age` selects which reference-range band a result is flagged against, so
 * changing a patient from 40 years to 40 months can silently turn a normal
 * result abnormal or the reverse, on results that were entered before the edit
 * and are not themselves touched by it. Listec's EditWorkOrder writes these
 * columns with no trail at all — SubmitChanges and nothing else — so after the
 * fact there is no way to tell that a range flag moved because someone fixed a
 * date of birth. One row per changed column closes that.
 *
 * ---------------------------------------------------------------------------
 * ON THE CONSTRAINT VOCABULARY, READ BEFORE EDITING
 *
 * SQL Server has no "add a value to a CHECK" — the constraint has to be dropped
 * and recreated whole. That makes these scripts last-writer-wins, so the lists
 * below are the FULL vocabulary, not just this script's additions: everything
 * 40 established, everything 55a added for attachments, and the patient fields
 * added here. Dropping a value from these lists retroactively invalidates rows
 * already written by another feature, so only ever append.
 * ---------------------------------------------------------------------------
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
        'detach',           -- and removed again
        'patient_edit'));   -- demographics or referral corrected
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
        -- patient demographics and referral, one row per column changed.
        -- Named for the column so the trail reads without a lookup table.
        'title', 'name', 'age', 'age_type', 'sex',
        -- The id column and its free-text fallback are recorded separately.
        -- Collapsing them to one name would make "ref_doctor: 412 -> (null)"
        -- indistinguishable from the referrer being cleared, when in fact it is
        -- usually a switch to a name typed by hand.
        'ref_doctor', 'ref_doctor_other',
        'ref_customer', 'ref_customer_other',
        'mobile', 'email',
        'sample_time', 'clinical_history'));
GO

PRINT 'Audit vocabulary extended for patient edits.';
GO
