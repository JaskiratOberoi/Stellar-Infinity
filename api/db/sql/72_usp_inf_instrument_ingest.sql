/*
 * 72_usp_inf_instrument_ingest.sql
 *
 * Accepts one normalised instrument reading into the inbox and, when it
 * resolves cleanly, writes it onto the patient result in the same transaction.
 *
 * ── NEVER AUTO-AUTHORISES ──────────────────────────────────────────────────
 * An ingested value lands with auth = 0, awaiting a human. The legacy COVID
 * importer set auth = true and fired an automatic WhatsApp to the patient; that
 * is the specific pattern this must not repeat. Auto-release, if a lab wants
 * it, is the separate per-test inf_auto_auth_config path with its own audit
 * source — a deliberate configuration, never an implicit consequence of a
 * machine having spoken.
 *
 * Matching is deliberately conservative. Anything ambiguous is parked in the
 * inbox as 'unmatched' with a reason, rather than guessed at:
 *   • unknown SID
 *   • SID present but the test was not ordered on it
 *   • sample already authorised/printed (7/8/9) — an instrument must not
 *     silently overwrite a signed-out result
 *   • the same instrument+SID+test+sequence already applied (duplicate)
 *
 * Returns { inbox_id, match_status, failure_reason, result_id }.
 */
CREATE OR ALTER PROCEDURE dbo.usp_inf_instrument_ingest
    @instrument_id  INT,
    @sid            NVARCHAR(50),
    @test_code      NVARCHAR(50),
    @value          NVARCHAR(400),
    @unit           NVARCHAR(50)   = NULL,
    @flags          NVARCHAR(100)  = NULL,
    @measured_at    DATETIMEOFFSET = NULL,
    @sequence_no    NVARCHAR(50)   = NULL,
    @raw_payload    NVARCHAR(MAX)  = NULL
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    -- code is 20 chars (the width of machine_name), so 'inst:' + code is 25 —
    -- comfortably inside updatedby's varchar(50).
    DECLARE @code NVARCHAR(20), @origin NVARCHAR(50);
    SELECT @code = i.code FROM dbo.inf_instrument i WHERE i.id = @instrument_id;

    IF @code IS NULL
    BEGIN
        RAISERROR('Unknown instrument.', 16, 1);
        RETURN;
    END

    SET @origin = CONCAT(N'inst:', @code);

    DECLARE @inbox   BIGINT,
            @status  VARCHAR(12) = 'pending',
            @reason  NVARCHAR(400) = NULL,
            @resultId INT = NULL;

    DECLARE @cleanSid  NVARCHAR(50) = LTRIM(RTRIM(ISNULL(@sid, N'')));
    DECLARE @cleanCode NVARCHAR(50) = LTRIM(RTRIM(ISNULL(@test_code, N'')));

    BEGIN TRY
        BEGIN TRANSACTION;

        -- Always record the message first, whatever happens next.
        INSERT INTO dbo.inf_instrument_result_inbox
            (instrument_id, instrument_code, raw_payload, sid, test_code, value, unit,
             flags, measured_at, sequence_no, parse_status, match_status, attempts)
        VALUES
            (@instrument_id, @code, @raw_payload, NULLIF(@cleanSid, N''), NULLIF(@cleanCode, N''),
             @value, @unit, @flags, @measured_at, @sequence_no,
             CASE WHEN @cleanSid = N'' OR @cleanCode = N'' OR @value IS NULL THEN 'invalid' ELSE 'parsed' END,
             'pending', 1);

        SET @inbox = SCOPE_IDENTITY();

        IF @cleanSid = N'' OR @cleanCode = N'' OR @value IS NULL
        BEGIN
            SET @status = 'rejected';
            SET @reason = N'Message is missing a SID, test code or value.';
        END
        ELSE
        BEGIN
            -- Duplicate: same instrument, sample, analyte and sequence already applied.
            IF @sequence_no IS NOT NULL AND EXISTS (
                SELECT 1 FROM dbo.inf_instrument_result_inbox b
                WHERE b.instrument_id = @instrument_id
                  AND b.sid = @cleanSid AND b.test_code = @cleanCode
                  AND b.sequence_no = @sequence_no
                  AND b.match_status = 'applied'
                  AND b.id <> @inbox)
            BEGIN
                SET @status = 'duplicate';
                SET @reason = N'This reading was already applied.';
            END
            ELSE
            BEGIN
                DECLARE @sampleStatus INT, @patientId INT;
                SELECT TOP 1 @sampleStatus = s.sample_status, @patientId = s.patient_id
                FROM dbo.tbl_med_mcc_patient_samples s
                WHERE s.vailid = @cleanSid
                ORDER BY s.id DESC;

                IF @sampleStatus IS NULL
                BEGIN
                    SET @status = 'unmatched';
                    SET @reason = N'No sample with SID ' + @cleanSid + N'.';
                END
                ELSE IF @sampleStatus IN (7, 8, 9)
                BEGIN
                    -- An instrument must never silently overwrite a signed-out
                    -- result. Parked for a human to reopen deliberately.
                    SET @status = 'unmatched';
                    SET @reason = N'Sample is authorised or printed; reopen it before accepting instrument results.';
                END
                ELSE
                BEGIN
                    SELECT TOP 1 @resultId = r.id
                    FROM dbo.tbl_med_mcc_patient_test_result r
                    WHERE r.vailid = @cleanSid
                      AND LTRIM(RTRIM(r.testcode)) = @cleanCode
                      AND r.testtype IN ('Test', 'Param')
                    ORDER BY r.id;

                    IF @resultId IS NULL
                    BEGIN
                        SET @status = 'unmatched';
                        SET @reason = N'Test ' + @cleanCode + N' is not on sample ' + @cleanSid + N'.';
                    END
                    ELSE
                    BEGIN
                        DECLARE @old NVARCHAR(MAX);
                        SELECT @old = r.value FROM dbo.tbl_med_mcc_patient_test_result r WHERE r.id = @resultId;

                        UPDATE dbo.tbl_med_mcc_patient_test_result
                        SET value        = @value,
                            -- The analyser id belongs here; the column has sat
                            -- unused since the schema was written.
                            machine_name = @code,
                            -- Explicitly NOT authorised. See the header.
                            auth         = 0,
                            updatedby    = @origin,
                            updateddate  = GETDATE()
                        WHERE id = @resultId;

                        INSERT INTO dbo.inf_result_audit
                            (result_id, vailid, patient_id, test_code, action, field,
                             old_value, new_value, actor_username, source, instrument_id, origin)
                        VALUES
                            (@resultId, @cleanSid, @patientId, @cleanCode,
                             'import', 'value', @old, @value, @code, 'instrument', @code, @origin);

                        -- Partially Tested, unless further along already.
                        UPDATE dbo.tbl_med_mcc_patient_samples
                        SET sample_status = 4
                        WHERE vailid = @cleanSid AND sample_status < 4;

                        SET @status = 'applied';
                    END
                END
            END
        END

        UPDATE dbo.inf_instrument_result_inbox
        SET match_status   = @status,
            failure_reason = @reason,
            result_id      = @resultId,
            applied_at     = CASE WHEN @status = 'applied' THEN SYSDATETIMEOFFSET() END
        WHERE id = @inbox;

        UPDATE dbo.inf_instrument SET last_seen_at = SYSDATETIMEOFFSET() WHERE id = @instrument_id;

        COMMIT TRANSACTION;

        SELECT inbox_id = @inbox, match_status = @status,
               failure_reason = @reason, result_id = @resultId;
    END TRY
    BEGIN CATCH
        IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
        DECLARE @msg NVARCHAR(400) = ERROR_MESSAGE();
        RAISERROR(@msg, 16, 1);
    END CATCH
END
GO
