/*
 * 05_table_inf_auto_auth.sql
 *
 * Auto-authorisation configuration — which tests, profiles or departments may
 * have in-range results authorised by the system rather than by a person.
 *
 * ---------------------------------------------------------------------------
 * OFF BY DEFAULT, AND OFF MEANS "NO ROW"
 *
 * Absence of a row is disabled. That is deliberate: a configuration table whose
 * default is "enabled unless a row says otherwise" fails open the moment a
 * deploy misses a seed script, and the failure mode here is releasing patient
 * results with no human review.
 *
 * The legacy LIS had the opposite default without ever calling it a setting.
 * SampleWorksheet's "Check" button (AutoAuthAndAbnormal, .aspx.cs:1400-1441)
 * ticks the authorise box for every numerically in-range result, and
 * txtValue_TextChanged1 does the same as you tab out of a cell. So in-range
 * results were always auto-signed, for every test, with no way to turn it off
 * and nothing in the audit trail distinguishing them from a deliberate human
 * authorisation. This table makes that behaviour explicit, scoped, gated and
 * recorded.
 * ---------------------------------------------------------------------------
 *
 * ENABLING REQUIRES A PASSWORD. The API verifies a PBKDF2 hash before calling
 * usp_inf_auto_auth_set, and both successes and failures land in
 * inf_auto_auth_audit. The password is a second pair of hands, not an identity:
 * it does not replace the autoauth:manage capability, it is checked in addition
 * to it.
 *
 * Idempotent: created only if missing.
 */
SET NOCOUNT ON;

-- Required for the FILTERED index below (WHERE enabled = 1). SQL Server refuses
-- to create one unless QUOTED_IDENTIFIER is ON, and sqlcmd connects with it OFF
-- by default — so a script that works through the .NET deploy tool (which
-- connects with it ON) fails when run by hand in sqlcmd. Setting it explicitly
-- makes the script behave the same either way.
SET QUOTED_IDENTIFIER ON;
GO

IF OBJECT_ID('dbo.inf_auto_auth_config', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.inf_auto_auth_config (
        id                  INT           NOT NULL IDENTITY(1,1),

        -- test | profile | department
        -- Resolution order at save time is most-specific-wins: an explicit
        -- 'test' row beats the 'profile' row that contains it, which beats the
        -- 'department' row. That lets a lab switch on a whole department and
        -- then carve out the two assays it does not trust.
        scope_type          VARCHAR(12)   NOT NULL,

        -- The LIS key for that scope: a test code for 'test' (matched against
        -- tbl_med_mcc_patient_test_result.testcode), a profile id for
        -- 'profile', a department id for 'department'. NVARCHAR because test
        -- codes are alphanumeric; the numeric scopes are stored as text and
        -- compared after conversion.
        scope_key           NVARCHAR(50)  NOT NULL,

        -- Human label captured at configuration time, so the settings screen
        -- and the audit trail stay readable if the master row is later renamed.
        scope_label         NVARCHAR(200) NULL,

        enabled             BIT           NOT NULL CONSTRAINT DF_inf_auto_auth_enabled DEFAULT 0,

        -- Auto-authorise only when the value falls inside the reference range.
        -- Settable to 0, but the procedure refuses that combination unless
        -- allow_out_of_range is also set — see below. Two flags rather than one
        -- so that "authorise anything" can never be reached by a single
        -- mis-click on a screen that mostly toggles safe things.
        require_in_range    BIT           NOT NULL CONSTRAINT DF_inf_auto_auth_inrange DEFAULT 1,
        allow_out_of_range  BIT           NOT NULL CONSTRAINT DF_inf_auto_auth_oor     DEFAULT 0,

        -- Non-numeric results (narratives, coded values, cultures) can never be
        -- range-checked, so they are never auto-authorised. Kept as a stored
        -- flag rather than a hard-coded rule so the intent is visible in the
        -- data, but the procedure does not offer a way to turn it off.
        numeric_only        BIT           NOT NULL CONSTRAINT DF_inf_auto_auth_numonly DEFAULT 1,

        updated_at          DATETIMEOFFSET(3) NOT NULL CONSTRAINT DF_inf_auto_auth_at DEFAULT SYSDATETIMEOFFSET(),
        updated_by          INT           NULL,
        updated_by_username NVARCHAR(50)  NULL,
        origin              VARCHAR(64)   NOT NULL,

        CONSTRAINT PK_inf_auto_auth_config PRIMARY KEY CLUSTERED (id),
        CONSTRAINT UQ_inf_auto_auth_scope  UNIQUE (scope_type, scope_key),
        CONSTRAINT CK_inf_auto_auth_scope_type
            CHECK (scope_type IN ('test', 'profile', 'department')),
        -- The database's own backstop against the dangerous combination, so it
        -- holds even if a future caller bypasses the procedure.
        CONSTRAINT CK_inf_auto_auth_range_guard
            CHECK (require_in_range = 1 OR allow_out_of_range = 1)
    );

    -- The save path reads this on every batch; it must be an index seek.
    CREATE NONCLUSTERED INDEX IX_inf_auto_auth_lookup
        ON dbo.inf_auto_auth_config (scope_type, scope_key)
        INCLUDE (enabled, require_in_range, allow_out_of_range, numeric_only)
        WHERE enabled = 1;

    PRINT 'Created dbo.inf_auto_auth_config.';
END
ELSE
BEGIN
    PRINT 'dbo.inf_auto_auth_config already present.';
END
GO

/*
 * Every attempt to change auto-authorisation, successful or not.
 *
 * Failed password attempts are recorded too. A run of them against this table
 * is the signature of someone trying to switch auto-release on, and that is
 * worth being able to see after the fact.
 */
IF OBJECT_ID('dbo.inf_auto_auth_audit', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.inf_auto_auth_audit (
        id                  BIGINT        NOT NULL IDENTITY(1,1),
        -- enable | disable | update | unlock_failed
        action              VARCHAR(20)   NOT NULL,
        scope_type          VARCHAR(12)   NULL,
        scope_key           NVARCHAR(50)  NULL,
        scope_label         NVARCHAR(200) NULL,
        old_enabled         BIT           NULL,
        new_enabled         BIT           NULL,
        detail              NVARCHAR(400) NULL,
        actor_user_id       INT           NOT NULL,
        actor_username      NVARCHAR(50)  NOT NULL,
        actor_ip            VARCHAR(64)   NULL,
        occurred_at         DATETIMEOFFSET(3) NOT NULL CONSTRAINT DF_inf_auto_auth_audit_at DEFAULT SYSDATETIMEOFFSET(),
        origin              VARCHAR(64)   NOT NULL,

        CONSTRAINT PK_inf_auto_auth_audit PRIMARY KEY CLUSTERED (id)
    );

    CREATE NONCLUSTERED INDEX IX_inf_auto_auth_audit_time
        ON dbo.inf_auto_auth_audit (occurred_at DESC);

    PRINT 'Created dbo.inf_auto_auth_audit.';
END
ELSE
BEGIN
    PRINT 'dbo.inf_auto_auth_audit already present.';
END
GO

/*
 * Append-only, by the same mechanism as the other two trails.
 *
 * A DENY is deliberately NOT used here: the application connects as `nobleone`,
 * which maps to dbo in Noble, and SQL Server refuses to deny permissions to
 * dbo or to yourself — it reports success while achieving nothing. That was
 * found the hard way in script 42; a rollback trigger is enforced by the engine
 * regardless of caller.
 */
CREATE OR ALTER TRIGGER dbo.trg_inf_auto_auth_audit_append_only
ON dbo.inf_auto_auth_audit
AFTER UPDATE, DELETE
AS
BEGIN
    SET NOCOUNT ON;
    ROLLBACK TRANSACTION;
    RAISERROR('dbo.inf_auto_auth_audit is append-only: UPDATE and DELETE are not permitted.', 16, 1);
END
GO
