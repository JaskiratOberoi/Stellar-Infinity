/*
 * 71_table_inf_instrument_inbox.sql
 *
 * Staging table for instrument results. Messages land HERE first and are
 * matched to a result row afterwards — they are never written straight through.
 *
 * The reason is the failure mode being designed out. The legacy Excel importer
 * swallowed unmatched rows in a catch block: a result that did not match simply
 * vanished, with no record that it had ever arrived. An analyser posting to a
 * mistyped SID at 2am must leave a visible, replayable message, not silence.
 *
 * So every message is retained with:
 *   • the raw payload exactly as received, for replay and for arguing with a
 *     vendor about what their analyser actually sent
 *   • parse status and match status, separately — a well-formed message for an
 *     unknown SID is a different problem from malformed JSON
 *   • the failure reason, in words
 *
 * Rows are mutable, unlike the audit tables: matching updates status, and a
 * replay updates it again. The immutable record of what changed in the patient
 * result lives in inf_result_audit with source = 'instrument'.
 *
 * Idempotent.
 */
SET NOCOUNT ON;

IF OBJECT_ID('dbo.inf_instrument_result_inbox', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.inf_instrument_result_inbox (
        id              BIGINT IDENTITY(1,1) NOT NULL
                        CONSTRAINT PK_inf_instrument_inbox PRIMARY KEY,

        instrument_id   INT            NOT NULL,
        instrument_code NVARCHAR(50)   NULL,

        -- As received. Kept even when parsing succeeded.
        raw_payload     NVARCHAR(MAX)  NULL,

        -- Normalised fields, null when parsing failed.
        sid             NVARCHAR(50)   NULL,
        test_code       NVARCHAR(50)   NULL,
        value           NVARCHAR(400)  NULL,
        unit            NVARCHAR(50)   NULL,
        flags           NVARCHAR(100)  NULL,
        measured_at     DATETIMEOFFSET NULL,
        sequence_no     NVARCHAR(50)   NULL,

        -- pending | parsed | invalid
        parse_status    VARCHAR(12)    NOT NULL
                        CONSTRAINT DF_inf_inbox_parse DEFAULT 'pending',
        -- pending | matched | applied | unmatched | rejected | duplicate
        match_status    VARCHAR(12)    NOT NULL
                        CONSTRAINT DF_inf_inbox_match DEFAULT 'pending',

        -- Plain words, for the operator staring at the inbox at 2am.
        failure_reason  NVARCHAR(400)  NULL,

        -- Set once the message has been written onto a patient result.
        result_id       INT            NULL,
        applied_at      DATETIMEOFFSET NULL,
        applied_by      INT            NULL,

        received_at     DATETIMEOFFSET NOT NULL
                        CONSTRAINT DF_inf_inbox_received DEFAULT SYSDATETIMEOFFSET(),
        attempts        INT            NOT NULL CONSTRAINT DF_inf_inbox_attempts DEFAULT 0,

        CONSTRAINT CK_inf_inbox_parse CHECK (parse_status IN ('pending','parsed','invalid')),
        CONSTRAINT CK_inf_inbox_match CHECK (match_status IN
            ('pending','matched','applied','unmatched','rejected','duplicate'))
    );

    -- The operator's main view: what still needs attention, newest first.
    CREATE INDEX IX_inf_inbox_pending
        ON dbo.inf_instrument_result_inbox (match_status, received_at DESC)
        INCLUDE (sid, test_code, instrument_code);

    CREATE INDEX IX_inf_inbox_sid ON dbo.inf_instrument_result_inbox (sid, received_at DESC);

    -- Supports duplicate detection: the same analyser resending the same
    -- reading for the same analyte.
    CREATE INDEX IX_inf_inbox_dedupe
        ON dbo.inf_instrument_result_inbox (instrument_id, sid, test_code, sequence_no);

    PRINT 'Created dbo.inf_instrument_result_inbox.';
END
ELSE
BEGIN
    PRINT 'dbo.inf_instrument_result_inbox already present.';
END
GO
