/*
 * 90_verify_auth_audit.sql
 *
 * READ-ONLY. Shows the most recent authentication audit events, to confirm the
 * trail is actually being written rather than merely wired up. Writes nothing.
 */
SET NOCOUNT ON;

DECLARE @total INT = (SELECT COUNT(*) FROM dbo.inf_auth_audit);
PRINT 'inf_auth_audit rows: ' + CAST(@total AS VARCHAR(20));
PRINT '';
PRINT 'By event:';

DECLARE @line NVARCHAR(MAX) = N'';
SELECT @line = @line + '  ' + LEFT(event + REPLICATE(' ', 18), 18)
                     + CAST(COUNT(*) AS VARCHAR(10)) + CHAR(10)
FROM dbo.inf_auth_audit
GROUP BY event;
PRINT ISNULL(@line, '  (none)');

PRINT 'Most recent 5:';
DECLARE @recent NVARCHAR(MAX) = N'';
SELECT @recent = @recent + '  ' + CONVERT(VARCHAR(19), a.occurred_at, 120)
                         + '  ' + LEFT(a.event + REPLICATE(' ', 16), 16)
                         + '  ' + LEFT(ISNULL(a.actor_username, '(none)') + REPLICATE(' ', 18), 18)
                         + '  ip=' + ISNULL(a.actor_ip, '?')
                         + '  ' + LEFT(ISNULL(a.detail, ''), 60) + CHAR(10)
FROM (SELECT TOP 5 * FROM dbo.inf_auth_audit ORDER BY id DESC) a;
PRINT ISNULL(@recent, '  (none)');
GO
