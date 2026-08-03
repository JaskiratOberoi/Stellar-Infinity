/*
 * 41_table_inf_auth_audit.sql
 *
 * Append-only audit of authentication and account events, sibling to
 * inf_result_audit.
 *
 * Separate from the result trail on purpose: different retention, different
 * readers, and vastly different volume — a failed-login flood must never push
 * clinical result history out of a shared table or its indexes.
 *
 * On client IP: the legacy LIS reads HTTP_X_FORWARDED_FOR unvalidated, which
 * any caller can forge, and elsewhere logs the server's own MAC address as if
 * it identified the user. Infinity records the IP its proxy chain actually
 * resolved (see the forwarded-headers configuration in Program.cs) and stores
 * it as text, never as an identity claim.
 *
 * Idempotent: created only if missing.
 */
SET NOCOUNT ON;

IF OBJECT_ID('dbo.inf_auth_audit', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.inf_auth_audit (
        id              BIGINT IDENTITY(1,1) NOT NULL
                        CONSTRAINT PK_inf_auth_audit PRIMARY KEY,

        -- login | login_failed | login_blocked | logout | password_change |
        -- token_revoked | role_change | lis_access_change | active_change
        event           VARCHAR(30)    NOT NULL,

        -- Nullable: a failed login may not resolve to a real user, and we must
        -- still record the attempt. Username is recorded as SUPPLIED, so a
        -- login attempt against a non-existent account is visible.
        actor_user_id   INT            NULL,
        actor_username  NVARCHAR(100)  NULL,

        -- For admin actions performed ON someone else.
        target_user_id  INT            NULL,
        target_username NVARCHAR(100)  NULL,

        succeeded       BIT            NOT NULL
                        CONSTRAINT DF_inf_auth_audit_ok DEFAULT 1,
        detail          NVARCHAR(500)  NULL,

        actor_ip        NVARCHAR(64)   NULL,
        actor_user_agent NVARCHAR(400) NULL,

        occurred_at     DATETIMEOFFSET NOT NULL
                        CONSTRAINT DF_inf_auth_audit_at DEFAULT SYSDATETIMEOFFSET(),

        origin          NVARCHAR(50)   NULL,

        CONSTRAINT CK_inf_auth_audit_event CHECK (event IN
            ('login','login_failed','login_blocked','logout','password_change',
             'token_revoked','role_change','lis_access_change','active_change'))
    );

    CREATE INDEX IX_inf_auth_audit_at     ON dbo.inf_auth_audit (occurred_at DESC);
    CREATE INDEX IX_inf_auth_audit_actor  ON dbo.inf_auth_audit (actor_user_id, occurred_at DESC);
    -- Supports the brute-force question: how many failures for this username
    -- recently, regardless of which account it resolved to.
    CREATE INDEX IX_inf_auth_audit_user   ON dbo.inf_auth_audit (actor_username, occurred_at DESC);

    PRINT 'Created dbo.inf_auth_audit.';
END
ELSE
BEGIN
    PRINT 'dbo.inf_auth_audit already present.';
END
GO

/*
 * Append-only enforcement lives in 42_append_only_audit.sql — a rollback
 * trigger, because DENY cannot be applied to the dbo-mapped application login.
 */
