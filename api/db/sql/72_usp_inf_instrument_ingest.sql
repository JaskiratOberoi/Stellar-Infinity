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
    @instrument_id  INT            = NULL,   -- NULL for a file import
    @sid            NVARCHAR(50),
    @test_code      NVARCHAR(50),
    @value          NVARCHAR(400),
    @unit           NVARCHAR(50)   = NULL,
    @flags          NVARCHAR(100)  = NULL,
    @measured_at    DATETIMEOFFSET = NULL,
    @sequence_no    NVARCHAR(50)   = NULL,
    @raw_payload    NVARCHAR(MAX)  = NULL,
    -- Import path. Shares this procedure so instrument and file results go
    -- through ONE matcher and land in ONE inbox — see 71a_alter_inbox_for_import.
    @source         VARCHAR(16)    = 'instrument',
    @imported_by    INT            = NULL,
    @batch_id       UNIQUEIDENTIFIER = NULL,
    @source_name    NVARCHAR(260)  = NULL
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    -- code is 20 chars (the width of machine_name), so 'inst:' + code is 25 —
    -- comfortably inside updatedby's varchar(50).
    DECLARE @code NVARCHAR(20), @origin NVARCHAR(50);

    IF @source = 'import'
    BEGIN
        IF @imported_by IS NULL
        BEGIN
            RAISERROR('An import must record which user uploaded it.', 16, 1);
            RETURN;
        END
        -- machine_name records HOW the value arrived. 'IMPORT' is honest; the
        -- uploading user is attributed in the audit row and imported_by.
        SET @code = N'IMPORT';
        SET @origin = CONCAT(N'inf:', @imported_by);
    END
    ELSE
    BEGIN
        SELECT @code = i.code FROM dbo.inf_instrument i WHERE i.id = @instrument_id;

        IF @code IS NULL
        BEGIN
            RAISERROR('Unknown instrument.', 16, 1);
            RETURN;
        END

        SET @origin = CONCAT(N'inst:', @code);
    END

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
             flags, measured_at, sequence_no, parse_status, match_status, attempts,
             source, imported_by, batch_id, source_name)
        VALUES
            (@instrument_id, @code, @raw_payload, NULLIF(@cleanSid, N''), NULLIF(@cleanCode, N''),
             @value, @unit, @flags, @measured_at, @sequence_no,
             CASE WHEN @cleanSid = N'' OR @cleanCode = N'' OR @value IS NULL THEN 'invalid' ELSE 'parsed' END,
             'pending', 1,
             @source, @imported_by, @batch_id, @source_name);

        SET @inbox = SCOPE_IDENTITY();

        IF @cleanSid = N'' OR @cleanCode = N'' OR @value IS NULL
        BEGIN
            SET @status = 'rejected';
            SET @reason = N'Message is missing a SID, test code or value.';
        END
        ELSE
        BEGIN
            /* Duplicate: the same reading already applied.
               Keyed on instrument for an analyser, and on source for an import
               where instrument_id is NULL — a plain `=` comparison against NULL
               never matches, so a re-uploaded file would sail past this check. */
            IF @sequence_no IS NOT NULL AND EXISTS (
                SELECT 1 FROM dbo.inf_instrument_result_inbox b
                WHERE ((@instrument_id IS NOT NULL AND b.instrument_id = @instrument_id)
                       OR (@instrument_id IS NULL AND b.source = @source))
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
                        DECLARE @old NVARCHAR(MAX), @oldAbnormal BIT,
                                @testId INT, @paramId INT, @testType VARCHAR(10);
                        SELECT @old = r.value, @oldAbnormal = ISNULL(r.abnormal, 0),
                               @testId = r.testid, @paramId = r.paramid, @testType = r.testtype
                        FROM dbo.tbl_med_mcc_patient_test_result r WHERE r.id = @resultId;

                        ------------------------------------------------------
                        -- Derive the abnormal flag, exactly as the UI save path
                        -- does.
                        --
                        -- Without this an out-of-range analyser result is stored
                        -- with abnormal = 0. The worksheet screen still shows
                        -- H/L, because it computes that live from the bounds —
                        -- but the REPORT reads the stored column
                        -- (usp_listec_worksheet_report_json selects r.abnormal),
                        -- so a critical potassium would print unflagged while
                        -- looking correct on the bench. An inconsistency that
                        -- only appears on the patient-facing artefact is the
                        -- worst place for one.
                        ------------------------------------------------------
                        DECLARE @age INT, @ageType INT, @gender INT;
                        SELECT @age = p.age, @ageType = p.age_type, @gender = p.gender
                        FROM dbo.tbl_med_mcc_patient_master p WHERE p.id = @patientId;

                        DECLARE @numeric DECIMAL(18,6) = TRY_CONVERT(DECIMAL(18,6), LTRIM(RTRIM(@value)));
                        DECLARE @low DECIMAL(18,6), @high DECIMAL(18,6);

                        -- Lowest id wins when bands overlap, matching
                        -- usp_inf_result_save so the two paths cannot disagree
                        -- about the same value.
                        IF @testType = 'Test'
                            SELECT TOP 1 @low  = TRY_CONVERT(DECIMAL(18,6), nr.fnormal),
                                         @high = TRY_CONVERT(DECIMAL(18,6), nr.tnormal)
                            FROM dbo.tbl_med_test_normalranges nr
                            WHERE nr.testid = @testId AND nr.ReportType = 'Auth'
                              AND ISNULL(nr.IsActive, 1) = 1
                              AND nr.agetype = CONVERT(NVARCHAR(10), @ageType)
                              AND nr.gender  = @gender
                              AND @age BETWEEN nr.fage AND nr.tage
                            ORDER BY nr.id;
                        ELSE
                            SELECT TOP 1 @low  = TRY_CONVERT(DECIMAL(18,6), pnr.fnormal),
                                         @high = TRY_CONVERT(DECIMAL(18,6), pnr.tnormal)
                            FROM dbo.tbl_med_test_param_normalranges pnr
                            WHERE pnr.testid = @testId AND pnr.paramid = @paramId
                              AND pnr.ReportType = 'Auth'
                              AND ISNULL(pnr.IsActive, 1) = 1
                              AND pnr.agetype = CONVERT(NVARCHAR(10), @ageType)
                              AND pnr.gender  = @gender
                              AND @age BETWEEN pnr.fage AND pnr.tage
                            ORDER BY pnr.id;

                        DECLARE @newAbnormal BIT =
                            CASE
                                -- Not range-checkable (narrative result, no band
                                -- for this age/sex): keep what was there rather
                                -- than asserting "normal".
                                WHEN @numeric IS NULL OR @low IS NULL OR @high IS NULL THEN @oldAbnormal
                                WHEN @numeric < @low OR @numeric > @high THEN 1
                                ELSE 0
                            END;

                        UPDATE dbo.tbl_med_mcc_patient_test_result
                        SET value        = @value,
                            abnormal     = @newAbnormal,
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

                        -- Logged as 'derive': computed server-side, asserted by
                        -- nobody.
                        IF @newAbnormal <> @oldAbnormal
                            INSERT INTO dbo.inf_result_audit
                                (result_id, vailid, patient_id, test_code, action, field,
                                 old_value, new_value, actor_username, source, instrument_id, origin)
                            VALUES
                                (@resultId, @cleanSid, @patientId, @cleanCode,
                                 'derive', 'abnormal',
                                 CONVERT(NVARCHAR(1), @oldAbnormal), CONVERT(NVARCHAR(1), @newAbnormal),
                                 @code, 'instrument', @code, @origin);

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

        -- No-op for an import, which has no instrument row.
        IF @instrument_id IS NOT NULL
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
