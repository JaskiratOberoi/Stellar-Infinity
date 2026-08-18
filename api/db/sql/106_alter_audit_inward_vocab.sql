/*
 * 106_alter_audit_inward_vocab.sql
 *
 * Adds the 'inward' action and the 'business_unit' field to the result audit,
 * so the transit scan's silent side effect finally leaves a trace.
 *
 * Every legacy Inward scan overwrites tbl_med_mcc_patient_samples
 * .business_unit_id — the sample's "which lab owns it" pointer — with no audit,
 * no old value, and without even setting modifiedby (contract quirk 4: KEEP the
 * overwrite, FIX the silence). usp_inf_inward_scan keeps the overwrite and
 * writes one audit row per actual change: actor, ip, old unit, new unit.
 *
 * ---------------------------------------------------------------------------
 * ON THE CONSTRAINT VOCABULARY, READ BEFORE EDITING
 *
 * SQL Server has no "add a value to a CHECK" — the constraint has to be dropped
 * and recreated whole. That makes these scripts last-writer-wins, so the lists
 * below are the FULL vocabulary, not just this script's additions: everything
 * 40 established, 55a's attachments, 103's patient fields, and the inward
 * values added here. Dropping a value from these lists retroactively
 * invalidates rows already written by another feature, so only ever append.
 * ---------------------------------------------------------------------------
 *
 * Idempotent: constraints are dropped if present and recreated.
 */
SET QUOTED_IDENTIFIER ON;
GO
SET NOCOUNT ON;

IF OBJECT_ID('dbo.inf_result_audit', 'U') IS NULL
BEGIN
    RAISERROR('dbo.inf_result_audit does not exist. Run 40 first.', 16, 1);
    RETURN;
END
GO

BEGIN TRY
    BEGIN TRANSACTION;

    IF EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_inf_result_audit_action')
        ALTER TABLE dbo.inf_result_audit DROP CONSTRAINT CK_inf_result_audit_action;

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
            'inward'));         -- a transit scan touched the sample

    IF EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_inf_result_audit_field')
        ALTER TABLE dbo.inf_result_audit DROP CONSTRAINT CK_inf_result_audit_field;

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
            -- inward transit (106): the sample's business_unit_id pointer,
            -- old/new recorded as the unit CODES so the trail reads without a
            -- lookup table.
            'business_unit'));

    COMMIT TRANSACTION;
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
    THROW;
END CATCH
GO

PRINT 'Audit vocabulary extended for inward transit scans.';
GO
