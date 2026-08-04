/*
 * 71a_alter_inbox_for_import.sql
 *
 * Lets the instrument inbox also hold rows from a file import.
 *
 * The importer deliberately reuses the inbox rather than getting a path of its
 * own. The whole reason the inbox exists is that the legacy Excel importer
 * dropped unmatched rows into a catch block; giving the new importer a separate
 * route would recreate exactly that split, with one set of failures visible and
 * another set not. One inbox, one matcher, one screen where an operator finds
 * everything that did not land.
 *
 * Three changes:
 *   • instrument_id becomes NULLABLE — an uploaded file has no analyser.
 *   • `source` distinguishes instrument from import, so the operator can tell
 *     a bench fault from a spreadsheet typo.
 *   • `imported_by` and `batch_id` attribute an upload to a person and group a
 *     file's rows, so one bad file can be reviewed — and replayed — as a unit.
 *
 * Idempotent: each column is added only if absent.
 */
SET NOCOUNT ON;

-- Required for the FILTERED index at the bottom (WHERE batch_id IS NOT NULL).
-- SQL Server refuses to create one unless QUOTED_IDENTIFIER is ON, and sqlcmd
-- connects with it OFF while Microsoft.Data.SqlClient connects with it ON — so
-- without this the script deploys cleanly through the .NET tool and fails when
-- a DBA runs the same file by hand. Same trap as scripts 46 and 53.
SET QUOTED_IDENTIFIER ON;
GO

IF OBJECT_ID('dbo.inf_instrument_result_inbox', 'U') IS NULL
BEGIN
    RAISERROR('dbo.inf_instrument_result_inbox does not exist. Run 71 first.', 16, 1);
    RETURN;
END
GO

-- instrument_id: NOT NULL -> NULL
IF EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA='dbo' AND TABLE_NAME='inf_instrument_result_inbox'
      AND COLUMN_NAME='instrument_id' AND IS_NULLABLE='NO')
BEGIN
    ALTER TABLE dbo.inf_instrument_result_inbox ALTER COLUMN instrument_id INT NULL;
    PRINT 'inf_instrument_result_inbox.instrument_id is now nullable.';
END
GO

IF COL_LENGTH('dbo.inf_instrument_result_inbox', 'source') IS NULL
BEGIN
    ALTER TABLE dbo.inf_instrument_result_inbox
        ADD source VARCHAR(16) NOT NULL
            CONSTRAINT DF_inf_inbox_source DEFAULT 'instrument';
    PRINT 'Added inf_instrument_result_inbox.source.';
END
GO

IF COL_LENGTH('dbo.inf_instrument_result_inbox', 'imported_by') IS NULL
BEGIN
    ALTER TABLE dbo.inf_instrument_result_inbox ADD imported_by INT NULL;
    PRINT 'Added inf_instrument_result_inbox.imported_by.';
END
GO

IF COL_LENGTH('dbo.inf_instrument_result_inbox', 'batch_id') IS NULL
BEGIN
    ALTER TABLE dbo.inf_instrument_result_inbox ADD batch_id UNIQUEIDENTIFIER NULL;
    PRINT 'Added inf_instrument_result_inbox.batch_id.';
END
GO

IF COL_LENGTH('dbo.inf_instrument_result_inbox', 'source_name') IS NULL
BEGIN
    -- The uploaded file's name. An operator looking at a failed row a week
    -- later needs to know which spreadsheet it came from.
    ALTER TABLE dbo.inf_instrument_result_inbox ADD source_name NVARCHAR(260) NULL;
    PRINT 'Added inf_instrument_result_inbox.source_name.';
END
GO

IF EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_inf_inbox_source')
    ALTER TABLE dbo.inf_instrument_result_inbox DROP CONSTRAINT CK_inf_inbox_source;
GO

ALTER TABLE dbo.inf_instrument_result_inbox WITH CHECK
    ADD CONSTRAINT CK_inf_inbox_source CHECK (source IN ('instrument', 'import'));
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_inf_inbox_batch')
BEGIN
    CREATE INDEX IX_inf_inbox_batch
        ON dbo.inf_instrument_result_inbox (batch_id)
        WHERE batch_id IS NOT NULL;
    PRINT 'Created IX_inf_inbox_batch.';
END
GO
