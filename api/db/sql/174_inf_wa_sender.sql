/* QUOTED_IDENTIFIER is baked in at creation time; see script 70. */
SET QUOTED_IDENTIFIER ON;
GO
/*
 * 174_inf_wa_sender.sql
 *
 * More than one WhatsApp number. 'default' is the lab's universal number;
 * an admin can add others, each a separately linked phone, and assign
 * client codes to one — that client's reports then go from its number.
 * Jas, 2026-10-01.
 *
 * inf_wa_sender         a sender per instance ('default' is implied and
 *                       never stored; the sidecar always has it)
 * inf_wa_sender_client  client code → sender, per instance; a client not
 *                       listed uses 'default'
 * inf_wa_message.sender which number a message goes (went) from
 *
 * Idempotent.
 */
IF OBJECT_ID('dbo.inf_wa_sender', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.inf_wa_sender (
        instance      VARCHAR(12)   NOT NULL,
        id            VARCHAR(32)   NOT NULL,
        name          NVARCHAR(80)  NOT NULL,
        created_by    INT           NULL,
        created_at    DATETIME2(0)  NOT NULL CONSTRAINT DF_inf_wa_sender_at DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_inf_wa_sender PRIMARY KEY (instance, id)
    );
END
GO
IF OBJECT_ID('dbo.inf_wa_sender_client', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.inf_wa_sender_client (
        instance      VARCHAR(12)   NOT NULL,
        client_code   NVARCHAR(50)  NOT NULL,
        sender_id     VARCHAR(32)   NOT NULL,
        updated_by    INT           NULL,
        updated_at    DATETIME2(0)  NOT NULL CONSTRAINT DF_inf_wa_sender_client_at DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_inf_wa_sender_client PRIMARY KEY (instance, client_code)
    );
END
GO
IF COL_LENGTH('dbo.inf_wa_message', 'sender') IS NULL
BEGIN
    ALTER TABLE dbo.inf_wa_message ADD sender VARCHAR(32) NOT NULL CONSTRAINT DF_inf_wa_message_sender DEFAULT 'default';
END
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_inf_wa_message_sender_queue' AND object_id = OBJECT_ID('dbo.inf_wa_message'))
    CREATE INDEX IX_inf_wa_message_sender_queue ON dbo.inf_wa_message (instance, sender, status, id);
GO
PRINT 'inf_wa_sender ready';
GO
