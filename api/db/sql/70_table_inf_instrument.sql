/* QUOTED_IDENTIFIER is baked into every procedure and index at creation
   time, not taken from the caller. dbo.inf_instrument_result_inbox carries a
   FILTERED index (IX_inf_inbox_batch, added in script 74), and SQL Server
   refuses to INSERT into such a table from a procedure compiled with this
   setting OFF. sqlcmd connects with it OFF; Microsoft.Data.SqlClient connects
   with it ON. Without this line the ingest procedure deploys cleanly and then
   fails on EVERY call, with an error naming the INSERT rather than the deploy. */
SET QUOTED_IDENTIFIER ON;
GO
/*
 * 70_table_inf_instrument.sql
 *
 * Registry of analysers permitted to post results.
 *
 * Instruments authenticate with a per-instrument API key, NOT a user JWT. An
 * analyser is not a person: it has no role, no MCC scope, no session to revoke,
 * and it must keep working when every human is logged out. Giving a machine a
 * user account is how service accounts end up with a real person's privileges.
 *
 * Only the key HASH is stored (pbkdf2-sha256, the same primitive as the
 * auto-auth unlock secret). A leaked database therefore does not yield working
 * instrument credentials, and a lost key is rotated rather than recovered.
 *
 * `code` is what gets written into tbl_med_mcc_patient_test_result.machine_name
 * — a column that has been in the schema unused since it was written, and is
 * exactly where the analyser id belongs.
 *
 * Idempotent.
 */
SET NOCOUNT ON;

IF OBJECT_ID('dbo.inf_instrument', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.inf_instrument (
        id              INT IDENTITY(1,1) NOT NULL
                        CONSTRAINT PK_inf_instrument PRIMARY KEY,

        -- Short stable identifier, e.g. 'COBAS-C311-1'.
        --
        -- 20 characters because that is exactly the width of
        -- tbl_med_mcc_patient_test_result.machine_name, which this is written
        -- into. Declaring it wider here would let an operator register a code
        -- that silently truncates on every result the analyser posts.
        code            NVARCHAR(20)   NOT NULL,
        name            NVARCHAR(200)  NOT NULL,
        department_id   INT            NULL,

        -- pbkdf2-sha256$<iterations>$<salt>$<key>. Never the key itself.
        api_key_hash    NVARCHAR(200)  NOT NULL,
        -- Last 4 characters of the key, so an operator can tell which key is
        -- installed on which bench without being able to reconstruct it.
        api_key_hint    NVARCHAR(8)    NULL,

        is_active       BIT            NOT NULL CONSTRAINT DF_inf_instrument_active DEFAULT 1,

        created_at      DATETIME2      NOT NULL CONSTRAINT DF_inf_instrument_created DEFAULT SYSDATETIME(),
        created_by      INT            NULL,
        last_seen_at    DATETIMEOFFSET NULL,

        CONSTRAINT UQ_inf_instrument_code UNIQUE (code)
    );

    PRINT 'Created dbo.inf_instrument.';
END
ELSE
BEGIN
    PRINT 'dbo.inf_instrument already present.';
END
GO
