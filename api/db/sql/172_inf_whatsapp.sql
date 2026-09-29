/* QUOTED_IDENTIFIER is baked in at creation time; see script 70. */
SET QUOTED_IDENTIFIER ON;
GO
/*
 * 172_inf_whatsapp.sql
 *
 * Reports to patients on WhatsApp, through a linked WhatsApp Web number (the
 * whatsapp sidecar). Infinity's own tables; nothing in the LIS reads them.
 *
 * Staging and prod share this database, so everything that could make one
 * act on the other's behalf is keyed by INSTANCE ('prod' / 'staging', from
 * the API's WhatsApp__Instance): each worker drains only its own queue rows
 * and reads only its own settings. A message queued on staging is never sent
 * from the prod number, and switching staging on switches nothing on prod.
 *
 * inf_wa_message   the queue and the log in one: every report sent, or
 *                  refused and why. status: queued → sending → sent →
 *                  delivered → read, or failed / skipped. trigger 'auto' rows
 *                  are unique per (instance, pid): a visit is sent
 *                  automatically once, ever; anything after is a manual resend.
 * inf_wa_client    the client codes whose patients get reports automatically.
 * inf_wa_optout    numbers that replied STOP; nothing more goes to them.
 * inf_wa_setting   per-instance switches and text (enabled, auto, caption,
 *                  pacing, daily cap, quiet hours).
 *
 * Idempotent.
 */
IF OBJECT_ID('dbo.inf_wa_message', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.inf_wa_message (
        id            BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_inf_wa_message PRIMARY KEY,
        instance      VARCHAR(12)    NOT NULL,
        pid           INT            NULL,
        sids          NVARCHAR(600)  NULL,
        client_code   NVARCHAR(50)   NULL,
        patient_name  NVARCHAR(150)  NULL,
        phone         VARCHAR(15)    NOT NULL,
        kind          VARCHAR(12)    NOT NULL CONSTRAINT DF_inf_wa_message_kind DEFAULT 'report',
        [trigger]     VARCHAR(8)     NOT NULL,
        status        VARCHAR(12)    NOT NULL CONSTRAINT DF_inf_wa_message_status DEFAULT 'queued',
        attempts      INT            NOT NULL CONSTRAINT DF_inf_wa_message_attempts DEFAULT 0,
        error         NVARCHAR(400)  NULL,
        wa_id         VARCHAR(160)   NULL,
        created_by    INT            NULL,
        created_at    DATETIME2(0)   NOT NULL CONSTRAINT DF_inf_wa_message_created DEFAULT SYSUTCDATETIME(),
        sent_at       DATETIME2(0)   NULL,
        updated_at    DATETIME2(0)   NOT NULL CONSTRAINT DF_inf_wa_message_updated DEFAULT SYSUTCDATETIME(),
        CONSTRAINT CK_inf_wa_message_status CHECK (status IN ('queued','sending','sent','delivered','read','failed','skipped')),
        CONSTRAINT CK_inf_wa_message_trigger CHECK ([trigger] IN ('auto','manual','test'))
    );
    CREATE INDEX IX_inf_wa_message_queue ON dbo.inf_wa_message (instance, status, id);
    CREATE INDEX IX_inf_wa_message_pid ON dbo.inf_wa_message (pid, id);
    CREATE INDEX IX_inf_wa_message_wa ON dbo.inf_wa_message (wa_id) WHERE wa_id IS NOT NULL;
    CREATE UNIQUE INDEX UX_inf_wa_message_auto ON dbo.inf_wa_message (instance, pid) WHERE [trigger] = 'auto';
END
GO
IF OBJECT_ID('dbo.inf_wa_client', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.inf_wa_client (
        client_code   NVARCHAR(50)  NOT NULL CONSTRAINT PK_inf_wa_client PRIMARY KEY,
        updated_by    INT           NULL,
        updated_at    DATETIME2(0)  NOT NULL CONSTRAINT DF_inf_wa_client_at DEFAULT SYSUTCDATETIME()
    );
END
GO
IF OBJECT_ID('dbo.inf_wa_optout', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.inf_wa_optout (
        phone         VARCHAR(15)   NOT NULL CONSTRAINT PK_inf_wa_optout PRIMARY KEY,
        source        VARCHAR(12)   NOT NULL,
        created_at    DATETIME2(0)  NOT NULL CONSTRAINT DF_inf_wa_optout_at DEFAULT SYSUTCDATETIME()
    );
END
GO
IF OBJECT_ID('dbo.inf_wa_setting', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.inf_wa_setting (
        instance      VARCHAR(12)    NOT NULL,
        [key]         NVARCHAR(50)   NOT NULL,
        value         NVARCHAR(2000) NOT NULL,
        updated_by    INT            NULL,
        updated_at    DATETIME2(0)   NOT NULL CONSTRAINT DF_inf_wa_setting_at DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_inf_wa_setting PRIMARY KEY (instance, [key])
    );
END
GO
PRINT 'inf_wa_* ready';
GO
