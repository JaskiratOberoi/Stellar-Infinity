/*
 * letterhead-demo-cleanup-20260929.sql
 *
 * Removes the demo client letterhead ("ZZ Test Diagnostics (demo)", id 1,
 * seeded for review on 2026-09-29) and its ZZTEST01 assignment, on Jas's
 * instruction. Infinity-only tables (script 171); nothing else is touched.
 * Guarded on id AND name so it can never remove a real client's letterhead.
 */
SET XACT_ABORT ON;
BEGIN TRAN;

DECLARE @id INT = (SELECT id FROM dbo.inf_letterhead WHERE id = 1 AND name = N'ZZ Test Diagnostics (demo)');

DELETE FROM dbo.inf_client_letterhead WHERE letterhead_id = @id;
DELETE FROM dbo.inf_letterhead WHERE id = @id;

COMMIT;

SELECT l.id, l.name, c.client_code
FROM dbo.inf_letterhead l
LEFT JOIN dbo.inf_client_letterhead c ON c.letterhead_id = l.id
ORDER BY l.id;
GO
