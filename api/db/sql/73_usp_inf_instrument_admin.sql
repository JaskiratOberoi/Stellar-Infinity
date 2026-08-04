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
 * 73_usp_inf_instrument_admin.sql
 *
 * Instrument registry management and the inbox operators actually work from.
 *
 * The inbox read is the point of the whole staging design: a message that did
 * not match must be VISIBLE and replayable, not lost in a catch block the way
 * the legacy Excel importer lost them.
 */

-- ---------------------------------------------------------------- register --
CREATE OR ALTER PROCEDURE dbo.usp_inf_instrument_upsert
    @code         NVARCHAR(20),
    @name         NVARCHAR(200),
    @apiKeyHash   NVARCHAR(200) = NULL,   -- NULL leaves an existing key alone
    @apiKeyHint   NVARCHAR(8)   = NULL,
    @departmentId INT           = NULL,
    @isActive     BIT           = 1,
    @actor        INT
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE @clean NVARCHAR(20) = LTRIM(RTRIM(@code));

    IF @clean = N'' OR @name IS NULL OR LTRIM(RTRIM(@name)) = N''
    BEGIN
        SELECT ok = CAST(0 AS BIT), error_code = 'VALIDATION',
               message = N'A code and name are required.', instrument_id = CAST(NULL AS INT);
        RETURN;
    END

    DECLARE @existing INT = (SELECT id FROM dbo.inf_instrument WHERE code = @clean);

    IF @existing IS NULL AND @apiKeyHash IS NULL
    BEGIN
        SELECT ok = CAST(0 AS BIT), error_code = 'VALIDATION',
               message = N'A new instrument needs an API key.', instrument_id = CAST(NULL AS INT);
        RETURN;
    END

    BEGIN TRY
        IF @existing IS NULL
        BEGIN
            INSERT INTO dbo.inf_instrument (code, name, api_key_hash, api_key_hint, department_id, is_active, created_by)
            VALUES (@clean, @name, @apiKeyHash, @apiKeyHint, @departmentId, @isActive, @actor);
            SET @existing = SCOPE_IDENTITY();
        END
        ELSE
        BEGIN
            UPDATE dbo.inf_instrument
            SET name          = @name,
                -- A null hash means "keep the current key"; rotation is explicit.
                api_key_hash  = ISNULL(@apiKeyHash, api_key_hash),
                api_key_hint  = CASE WHEN @apiKeyHash IS NULL THEN api_key_hint ELSE @apiKeyHint END,
                department_id = @departmentId,
                is_active     = @isActive
            WHERE id = @existing;
        END

        SELECT ok = CAST(1 AS BIT), error_code = CAST(NULL AS VARCHAR(20)),
               message = CAST(NULL AS NVARCHAR(200)), instrument_id = @existing;
    END TRY
    BEGIN CATCH
        SELECT ok = CAST(0 AS BIT), error_code = 'INTERNAL',
               message = LEFT(ERROR_MESSAGE(), 200), instrument_id = CAST(NULL AS INT);
    END CATCH
END
GO

-- -------------------------------------------------------------------- list --
CREATE OR ALTER PROCEDURE dbo.usp_inf_instrument_list
AS
BEGIN
    SET NOCOUNT ON;

    SELECT
        i.id, i.code, i.name, i.department_id, i.is_active,
        i.api_key_hint, i.created_at, i.last_seen_at,
        -- The two numbers an operator actually wants on this screen.
        pending = (SELECT COUNT(*) FROM dbo.inf_instrument_result_inbox b
                   WHERE b.instrument_id = i.id AND b.match_status IN ('pending','unmatched')),
        applied_24h = (SELECT COUNT(*) FROM dbo.inf_instrument_result_inbox b
                       WHERE b.instrument_id = i.id AND b.match_status = 'applied'
                         AND b.received_at >= DATEADD(HOUR, -24, SYSDATETIMEOFFSET()))
    FROM dbo.inf_instrument i
    ORDER BY i.is_active DESC, i.code;
END
GO

-- ---------------------------------------------------------- authentication --
/*
 * Look up an active instrument by code, returning the stored key hash for the
 * API to verify. The hash is never compared in SQL: the comparison must be the
 * constant-time one in PasswordHash.Verify, and doing it here would also mean
 * the plaintext key travelled to the database.
 */
CREATE OR ALTER PROCEDURE dbo.usp_inf_instrument_by_code
    @code NVARCHAR(20)
AS
BEGIN
    SET NOCOUNT ON;
    SELECT i.id, i.code, i.name, i.api_key_hash, i.is_active
    FROM dbo.inf_instrument i
    WHERE i.code = LTRIM(RTRIM(@code));
END
GO

-- ------------------------------------------------------------------- inbox --
CREATE OR ALTER PROCEDURE dbo.usp_inf_instrument_inbox
    @status       VARCHAR(12)  = NULL,   -- NULL = everything needing attention
    @instrumentId INT          = NULL,
    @sid          NVARCHAR(50) = NULL,
    @top          INT          = 100
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @n INT = CASE WHEN @top BETWEEN 1 AND 500 THEN @top ELSE 100 END;

    SELECT TOP (@n)
        b.id, b.instrument_id, b.instrument_code,
        b.sid, b.test_code, b.value, b.unit, b.flags,
        b.measured_at, b.sequence_no,
        b.parse_status, b.match_status, b.failure_reason,
        b.result_id, b.received_at, b.applied_at, b.attempts,
        -- Lets the operator tell a bench fault from a spreadsheet typo, and
        -- trace a bad row back to the file it came from.
        b.source, b.source_name, b.batch_id,
        COUNT(*) OVER() AS total_count
    FROM dbo.inf_instrument_result_inbox b
    WHERE (@instrumentId IS NULL OR b.instrument_id = @instrumentId)
      AND (@sid IS NULL OR b.sid = @sid)
      AND (
            (@status IS NOT NULL AND b.match_status = @status)
            -- Default view: only what a human still has to deal with.
         OR (@status IS NULL AND b.match_status IN ('pending','unmatched','rejected'))
          )
    ORDER BY b.received_at DESC, b.id DESC;
END
GO

-- ------------------------------------------------------------------ replay --
/*
 * Re-attempt an inbox message. Replay re-runs the ingest against current state,
 * which is what makes an unmatched message recoverable: the SID gets registered,
 * or the test gets added to the order, and the same message then applies.
 *
 * The original row is marked 'duplicate' and the replay is a NEW row, so the
 * inbox keeps a record of both the failure and the recovery rather than
 * rewriting history.
 */
CREATE OR ALTER PROCEDURE dbo.usp_inf_instrument_replay
    @inboxId BIGINT,
    @actor   INT
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE @instrumentId INT, @sid NVARCHAR(50), @testCode NVARCHAR(50),
            @value NVARCHAR(400), @unit NVARCHAR(50), @flags NVARCHAR(100),
            @measuredAt DATETIMEOFFSET, @seq NVARCHAR(50), @raw NVARCHAR(MAX),
            @status VARCHAR(12),
            -- Carried through so replaying an IMPORT stays an import.
            @source VARCHAR(16), @importedBy INT, @batchId UNIQUEIDENTIFIER,
            @sourceName NVARCHAR(260);

    SELECT @instrumentId = b.instrument_id, @sid = b.sid, @testCode = b.test_code,
           @value = b.value, @unit = b.unit, @flags = b.flags,
           @measuredAt = b.measured_at, @seq = b.sequence_no, @raw = b.raw_payload,
           @status = b.match_status,
           @source = b.source, @importedBy = b.imported_by,
           @batchId = b.batch_id, @sourceName = b.source_name
    FROM dbo.inf_instrument_result_inbox b
    WHERE b.id = @inboxId;

    /* Existence is checked on match_status, which is NOT NULL on every stored
       row. It used to be checked on instrument_id — which became wrong the
       moment script 74 made that column nullable for file imports: every
       imported row would have reported "not found" while sitting in plain
       sight in the inbox. */
    IF @status IS NULL
    BEGIN
        RAISERROR('Inbox message not found.', 16, 1);
        RETURN;
    END

    IF @status = 'applied'
    BEGIN
        RAISERROR('This message has already been applied.', 16, 1);
        RETURN;
    END

    -- Mark the original as superseded before the retry, so a replay that fails
    -- again does not leave two identical unmatched rows competing for attention.
    UPDATE dbo.inf_instrument_result_inbox
    SET match_status  = 'duplicate',
        failure_reason = LEFT(N'Superseded by a replay requested by user ' + CAST(@actor AS NVARCHAR(20)), 400),
        attempts      = attempts + 1
    WHERE id = @inboxId;

    /* The source fields must be passed on. Without them the ingest procedure
       defaults to source='instrument' with a NULL instrument_id and refuses the
       row as an unknown instrument — so an imported message could never be
       replayed at all. */
    EXEC dbo.usp_inf_instrument_ingest
        @instrument_id = @instrumentId,
        @sid           = @sid,
        @test_code     = @testCode,
        @value         = @value,
        @unit          = @unit,
        @flags         = @flags,
        @measured_at   = @measuredAt,
        @sequence_no   = @seq,
        @raw_payload   = @raw,
        @source        = @source,
        @imported_by   = @importedBy,
        @batch_id      = @batchId,
        @source_name   = @sourceName;
END
GO
