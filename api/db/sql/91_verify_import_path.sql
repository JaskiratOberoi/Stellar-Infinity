/*
 * 91_verify_import_path.sql
 *
 * Verifies the file-import path end to end against real data, then UNDOES the
 * only lasting effect it could have.
 *
 * Deliberately exercises the case that matters: an import for a SID that does
 * not exist must land in the inbox as 'unmatched' with a readable reason, not
 * vanish. That is the legacy failure mode the whole staging design exists to
 * prevent, so a green tick here is worth more than a happy-path check.
 *
 * Also verifies the two bugs that appeared when instrument_id became nullable
 * for imports:
 *   • replay reported "not found" for every imported row
 *   • replay dropped the source fields, so the retry was rejected as an
 *     unknown instrument
 *
 * The inbox rows this creates are deleted at the end. Nothing is written to any
 * patient result, because the SID is deliberately fictional.
 */
SET QUOTED_IDENTIFIER ON;
GO

SET NOCOUNT ON;

DECLARE @batch UNIQUEIDENTIFIER = NEWID();
DECLARE @fakeSid NVARCHAR(50) = N'__import_selftest__';
DECLARE @actor INT = (SELECT TOP 1 id FROM dbo.tbl_med_user_master ORDER BY id);

PRINT 'Import path verification';
PRINT '------------------------';

-- 1. Import for a nonexistent SID must be parked, not lost.
EXEC dbo.usp_inf_instrument_ingest
    @instrument_id = NULL,
    @sid           = @fakeSid,
    @test_code     = N'GLU',
    @value         = N'5.4',
    @source        = 'import',
    @imported_by   = @actor,
    @batch_id      = @batch,
    @source_name   = N'selftest.csv';

DECLARE @inboxId BIGINT, @status VARCHAR(12), @reason NVARCHAR(400), @src VARCHAR(16);
SELECT TOP 1 @inboxId = id, @status = match_status, @reason = failure_reason, @src = source
FROM dbo.inf_instrument_result_inbox
WHERE batch_id = @batch ORDER BY id DESC;

IF @inboxId IS NULL
BEGIN
    RAISERROR('FAIL: the imported row was not recorded in the inbox at all.', 16, 1);
    RETURN;
END

PRINT '  recorded in inbox   id=' + CAST(@inboxId AS VARCHAR(20))
    + '  source=' + @src + '  status=' + @status;
PRINT '  reason              ' + ISNULL(@reason, '(none)');

IF @status <> 'unmatched'
    RAISERROR('FAIL: expected match_status = unmatched for an unknown SID, got %s.', 16, 1, @status);
IF @src <> 'import'
    RAISERROR('FAIL: source was not recorded as import.', 16, 1);

-- 2. Replay must FIND the row (it used to fail on the nullable instrument_id)
--    and must keep it an import (it used to be rejected as unknown instrument).
BEGIN TRY
    EXEC dbo.usp_inf_instrument_replay @inboxId = @inboxId, @actor = @actor;

    DECLARE @replayStatus VARCHAR(12), @replaySrc VARCHAR(16), @replayId BIGINT;
    SELECT TOP 1 @replayId = id, @replayStatus = match_status, @replaySrc = source
    FROM dbo.inf_instrument_result_inbox
    WHERE batch_id = @batch AND id <> @inboxId ORDER BY id DESC;

    IF @replayId IS NULL
        RAISERROR('FAIL: replay produced no new inbox row.', 16, 1);
    ELSE
    BEGIN
        PRINT '  replay              new id=' + CAST(@replayId AS VARCHAR(20))
            + '  source=' + @replaySrc + '  status=' + @replayStatus;
        IF @replaySrc <> 'import'
            RAISERROR('FAIL: replay lost the import source.', 16, 1);
    END
END TRY
BEGIN CATCH
    PRINT '  replay              FAILED: ' + ERROR_MESSAGE();
    RAISERROR('FAIL: replay of an imported row raised.', 16, 1);
END CATCH

-- 3. Confirm no patient result was touched by a fictional SID.
IF EXISTS (SELECT 1 FROM dbo.inf_result_audit WHERE vailid = @fakeSid)
    RAISERROR('FAIL: the self-test wrote a result audit row.', 16, 1);
PRINT '  no result written   ok';

-- Clean up. The inbox is mutable (unlike the audit trails), so the self-test
-- rows can and should be removed.
DELETE FROM dbo.inf_instrument_result_inbox WHERE batch_id = @batch;
PRINT '  cleaned up          ' + CAST(@@ROWCOUNT AS VARCHAR(10)) + ' row(s) removed';
PRINT '';
PRINT 'Import path verified.';
GO
