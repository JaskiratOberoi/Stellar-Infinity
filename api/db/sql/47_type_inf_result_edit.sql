/*
 * 06_type_inf_result_edit.sql
 *
 * Table type for a batch of worksheet edits. One row per analyte the
 * technologist touched — the whole grid save arrives as a single parameter and
 * is applied inside one transaction.
 *
 * Note what is NOT in this type: `abnormal`. The high/low flag is derived
 * server-side from the reference ranges inside usp_inf_result_save and is never
 * accepted from the caller. In the legacy UI the abnormal checkbox is bound to
 * a literal (SampleWorksheet.aspx:403 hard-codes Checked="false" instead of
 * Eval("abnormal")), so the stored flag never round-trips and any manual
 * marking is silently lost on reopen. Deriving it in one place removes both the
 * bug and the possibility of a client asserting a result is normal when it is
 * not.
 *
 * Idempotent, with a caveat: a table type cannot be altered. If the shape needs
 * to change, every procedure referencing it must be dropped first — which is
 * why the guard reports rather than silently doing nothing useful.
 */
SET NOCOUNT ON;

IF TYPE_ID('dbo.InfResultEdit') IS NULL
BEGIN
    CREATE TYPE dbo.InfResultEdit AS TABLE (
        result_id   INT           NOT NULL,

        -- The new value. NULL means "leave the value alone"; empty string means
        -- "clear it". The distinction matters — a grid save posts every visible
        -- row, and without it, collapsing NULL and '' would let an untouched
        -- row wipe a result entered by someone else since the page loaded.
        value       NVARCHAR(MAX) NULL,

        -- Same convention: NULL leaves comments untouched.
        comments    NVARCHAR(MAX) NULL,

        -- NULL leaves the authorisation flag alone; 1 authorises, 0 revokes.
        set_auth    BIT           NULL,

        -- Required when overwriting a value that is already present. Enforced
        -- in the procedure, not here, so the caller gets a usable error rather
        -- than a constraint violation.
        reason      NVARCHAR(500) NULL,

        PRIMARY KEY CLUSTERED (result_id)
    );

    PRINT 'Created type dbo.InfResultEdit.';
END
ELSE
BEGIN
    PRINT 'Type dbo.InfResultEdit already present.';
END
GO
