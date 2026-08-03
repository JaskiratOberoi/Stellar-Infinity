/*
 * 00_schema_guard.sql
 *
 * Read-only pre-flight. Asserts every Noble object Infinity's auth layer depends
 * on actually exists, so a deploy fails loudly here rather than at 2am inside a
 * stored procedure via deferred name resolution.
 *
 * Runs first (lexical order) and writes nothing.
 */
SET NOCOUNT ON;

DECLARE @missing NVARCHAR(MAX) = N'';

DECLARE @required TABLE (name SYSNAME, kind CHAR(1));
INSERT INTO @required (name, kind) VALUES
    -- LIS tables the auth path reads
    ('dbo.tbl_med_user_master',            'U'),
    ('dbo.tbl_med_usertypes',              'U'),
    ('dbo.tbl_med_mcc_user_security_auth', 'U'),
    -- Telo's sidecar. Infinity does NOT write to it, but usp_inf_authenticate
    -- reads it to recognise Telo-managed accounts as a distinct population, and
    -- the admin procs read it to refuse fighting Telo over IsActive.
    ('dbo.telo_account',                   'U');

DECLARE @name SYSNAME, @kind CHAR(1);
DECLARE c CURSOR LOCAL FAST_FORWARD FOR SELECT name, kind FROM @required;
OPEN c;
FETCH NEXT FROM c INTO @name, @kind;
WHILE @@FETCH_STATUS = 0
BEGIN
    IF OBJECT_ID(@name, @kind) IS NULL
        SET @missing = @missing + @name + N'; ';
    FETCH NEXT FROM c INTO @name, @kind;
END
CLOSE c;
DEALLOCATE c;

IF LEN(@missing) > 0
BEGIN
    DECLARE @msg NVARCHAR(2000) =
        N'Infinity schema guard FAILED. Missing Noble objects: ' + @missing +
        N'If dbo.telo_account is the only one missing, Telo is not deployed on this ' +
        N'server — see the notes in 10_usp_inf_authenticate.sql before removing the dependency.';
    RAISERROR(@msg, 16, 1);
END
ELSE
BEGIN
    PRINT 'Infinity schema guard passed.';
END
GO
