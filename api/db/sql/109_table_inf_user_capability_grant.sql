/*
 * 109_table_inf_user_capability_grant.sql
 *
 * Per-USER capability grants, on top of whatever the user's role gives them.
 *
 * The first need is walk-in ordering: a collection centre is B2B-only by
 * default — every order it raises is billed to its account and settled later —
 * but a few centres genuinely take walk-in patients over their own counter and
 * the lab wants to allow that case by case. That is not a role: the account is
 * still a client in every other respect, so promoting it would hand over the
 * whole client role's shape to solve one flag.
 *
 * ── WHY A WHITELIST, AND WHY IT IS THE POINT ───────────────────────────────
 * A table that grants "any capability to any user" is a privilege-escalation
 * primitive wearing a helpful name: anyone who can write one row, directly or
 * through a bug in the endpoint above it, could hand themselves user:manage.
 * The CHECK constraint below is what stops this table ever becoming that. Only
 * capabilities that are safe to hand to an individual account may appear here,
 * and widening the list is a deliberate migration someone has to write and
 * justify — not a value an endpoint can pass.
 *
 * order:b2c is safe in this sense: it changes how a basket is PRICED for an
 * account that can already raise orders. It grants no read of anyone else's
 * data and no administrative power.
 *
 * Revocation is a DELETE, not a flag, so the table only ever holds live grants
 * and "does this user have it" is an EXISTS. The audit of who changed what
 * lives in inf_result_audit via the procedure, where it cannot be edited.
 */
SET QUOTED_IDENTIFIER ON;
SET ANSI_NULLS ON;
GO

IF OBJECT_ID('dbo.inf_user_capability_grant', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.inf_user_capability_grant (
        id           INT           IDENTITY(1,1) NOT NULL,
        user_id      INT           NOT NULL,
        capability   VARCHAR(40)   NOT NULL,
        granted_by   INT           NULL,
        granted_at   DATETIME2     NOT NULL
            CONSTRAINT DF_inf_user_cap_grant_at DEFAULT SYSDATETIME(),
        CONSTRAINT PK_inf_user_capability_grant PRIMARY KEY (id),
        -- One row per (user, capability): granting twice is not two grants.
        CONSTRAINT UQ_inf_user_capability_grant UNIQUE (user_id, capability),
        -- THE guard. See the remarks above before adding to this list.
        CONSTRAINT CK_inf_user_capability_grant_cap
            CHECK (capability IN ('order:b2c'))
    );

    -- The read is always "everything this user holds", on every token mint.
    CREATE NONCLUSTERED INDEX IX_inf_user_capability_grant_user
        ON dbo.inf_user_capability_grant (user_id) INCLUDE (capability);

    PRINT 'Created dbo.inf_user_capability_grant.';
END
ELSE
    PRINT 'dbo.inf_user_capability_grant already present.';
GO
