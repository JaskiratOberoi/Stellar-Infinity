/*
 * 40_table_inf_result_audit.sql
 *
 * Append-only audit of every change to a laboratory result — one row per FIELD
 * change, with BOTH the old and new value.
 *
 * This is the single biggest departure from the legacy LIS, which records that
 * something happened but never what changed (see docs/worksheet-lis-analysis.md
 * §7 and defect 7). For a clinical result that is not good enough: when a value
 * is amended after authorisation, the question is always "what did it say
 * before, who changed it, and why".
 *
 * Append-only is enforced, not merely intended: UPDATE and DELETE are DENIED to
 * the application login at the bottom of this script. An audit table the
 * application can rewrite is not an audit table.
 *
 * Noble is shared with the running LIS, so every row carries the `origin` stamp
 * ('inf:<userId>') and rows are always attributable to the exact account.
 *
 * Idempotent: created only if missing.
 */
SET NOCOUNT ON;

IF OBJECT_ID('dbo.inf_result_audit', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.inf_result_audit (
        id              BIGINT IDENTITY(1,1) NOT NULL
                        CONSTRAINT PK_inf_result_audit PRIMARY KEY,

        -- What was touched. result_id is the LIS result row; vailid and
        -- patient_id are denormalised so the common "show me this sample's
        -- history" query needs no join to a table the LIS may be rewriting.
        result_id       INT            NULL,
        vailid          NVARCHAR(50)   NULL,
        patient_id      INT            NULL,
        test_code       NVARCHAR(50)   NULL,

        -- enter | amend | authorize | unauthorize | reopen | reject | import
        action          VARCHAR(20)    NOT NULL,
        -- value | auth | abnormal | comments | status
        field           VARCHAR(20)    NOT NULL,

        -- Both populated. A trail that stores only the new value cannot answer
        -- the question it exists to answer.
        old_value       NVARCHAR(MAX)  NULL,
        new_value       NVARCHAR(MAX)  NULL,

        -- Required for amend and reopen; 500 chars, not the legacy 50, because
        -- a real clinical justification does not fit in 50.
        reason          NVARCHAR(500)  NULL,

        -- Username denormalised so deleting or renaming a user cannot orphan
        -- the trail.
        actor_user_id   INT            NULL,
        actor_username  NVARCHAR(100)  NULL,
        actor_ip        NVARCHAR(64)   NULL,
        actor_user_agent NVARCHAR(400) NULL,

        -- ui | instrument | import | api
        source          VARCHAR(20)    NOT NULL
                        CONSTRAINT DF_inf_result_audit_source DEFAULT 'ui',
        instrument_id   NVARCHAR(50)   NULL,

        occurred_at     DATETIMEOFFSET NOT NULL
                        CONSTRAINT DF_inf_result_audit_at DEFAULT SYSDATETIMEOFFSET(),

        -- 'inf:<userId>' — see Domain/Origin.cs.
        origin          NVARCHAR(50)   NULL,

        CONSTRAINT CK_inf_result_audit_action CHECK (action IN
            ('enter','amend','authorize','unauthorize','reopen','reject','import')),
        CONSTRAINT CK_inf_result_audit_field CHECK (field IN
            ('value','auth','abnormal','comments','status')),
        CONSTRAINT CK_inf_result_audit_source CHECK (source IN
            ('ui','instrument','import','api')),
        -- A reason is not optional for the two actions that overwrite or
        -- reverse clinical sign-off.
        CONSTRAINT CK_inf_result_audit_reason CHECK (
            action NOT IN ('amend','reopen') OR (reason IS NOT NULL AND LTRIM(RTRIM(reason)) <> ''))
    );

    CREATE INDEX IX_inf_result_audit_vailid   ON dbo.inf_result_audit (vailid, occurred_at DESC);
    CREATE INDEX IX_inf_result_audit_result   ON dbo.inf_result_audit (result_id, occurred_at DESC);
    CREATE INDEX IX_inf_result_audit_actor    ON dbo.inf_result_audit (actor_user_id, occurred_at DESC);

    PRINT 'Created dbo.inf_result_audit.';
END
ELSE
BEGIN
    PRINT 'dbo.inf_result_audit already present.';
END
GO

/*
 * Append-only enforcement lives in 42_append_only_audit.sql.
 *
 * A DENY was tried here first and does NOT work: the application connects as
 * `nobleone`, which maps to dbo in Noble, and SQL Server refuses to deny
 * permissions to dbo or to yourself. The attempt reported success while
 * achieving nothing — so enforcement is a rollback trigger instead, which the
 * engine applies regardless of caller, and script 42 proves it with a
 * self-test rather than asserting it.
 */
