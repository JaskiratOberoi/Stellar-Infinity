/*
 * 139_type_inf_abnormal_override.sql
 *
 * Table type for the operator's MANUAL abnormal marks — one row per result the
 * technologist explicitly flagged (or unflagged) where the machine cannot
 * judge.
 *
 * Context: usp_inf_result_save derives the abnormal flag from the resolved
 * reference range and refuses to accept it from the caller (see
 * 47_type_inf_result_edit.sql for why — the legacy AB checkbox silently erased
 * flags on every save). That leaves one real gap: a result the derivation
 * cannot judge — a qualitative value ("REACTIVE"), or a test whose reference
 * is prose rather than a numeric band. There the LIS's manual AB mark was the
 * only way to bold the value on the report, and Infinity had none.
 *
 * This type carries exactly that, and ONLY that: the procedure honours a row
 * here solely when its result is not range-checkable. For a numeric result
 * inside a numeric range the derivation stays authoritative and the override
 * is ignored — a caller still cannot assert a result is normal when the range
 * says it is not.
 *
 * A table type cannot be altered; see 47's note.
 */
SET NOCOUNT ON;

IF TYPE_ID('dbo.InfAbnormalOverride') IS NULL
BEGIN
    CREATE TYPE dbo.InfAbnormalOverride AS TABLE (
        result_id INT NOT NULL,
        abnormal  BIT NOT NULL,
        PRIMARY KEY CLUSTERED (result_id)
    );

    PRINT 'Created type dbo.InfAbnormalOverride.';
END
ELSE
BEGIN
    PRINT 'Type dbo.InfAbnormalOverride already present.';
END
GO
