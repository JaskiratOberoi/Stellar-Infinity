/*
 * 03_table_inf_user_session_version.sql
 *
 * Session-revocation counter, one row per user.
 *
 * Infinity issues stateless JWTs, which cannot be withdrawn once handed out. The
 * version here is stamped into every token as `sv`; each authenticated request
 * re-reads it and rejects the token if it no longer matches. Bumping the counter
 * therefore invalidates every outstanding token for that user immediately —
 * which is what must happen on password reset, deactivation, role change, or
 * revoking LIS access.
 *
 * Reads are cached briefly in the API, so revocation is effective within the
 * cache TTL rather than instantly. That trade is deliberate: the alternative is
 * a database round-trip on every single request against a database shared with
 * the live LIS.
 *
 * A missing row means version 0 — no row needs to exist until the first bump.
 *
 * Idempotent: created only if missing.
 */
SET NOCOUNT ON;

IF OBJECT_ID('dbo.inf_user_session_version', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.inf_user_session_version (
        user_id    INT       NOT NULL PRIMARY KEY,
        version    INT       NOT NULL CONSTRAINT DF_inf_session_version DEFAULT 1,
        updated_at DATETIME2 NOT NULL CONSTRAINT DF_inf_session_updated DEFAULT SYSDATETIME(),
        reason     NVARCHAR(100) NULL
    );

    PRINT 'Created dbo.inf_user_session_version.';
END
ELSE
BEGIN
    PRINT 'dbo.inf_user_session_version already present.';
END
GO

/*
 * Bump a user's session version, invalidating every token they hold.
 * Called by the admin procedures; safe to call for a user with no row yet.
 */
CREATE OR ALTER PROCEDURE dbo.usp_inf_bump_session_version
    @userId INT,
    @reason NVARCHAR(100) = NULL
AS
BEGIN
    SET NOCOUNT ON;

    MERGE dbo.inf_user_session_version AS t
    USING (SELECT @userId AS user_id) AS s
        ON t.user_id = s.user_id
    WHEN MATCHED THEN
        UPDATE SET version = t.version + 1, updated_at = SYSDATETIME(), reason = @reason
    WHEN NOT MATCHED THEN
        INSERT (user_id, version, reason) VALUES (@userId, 1, @reason);
END
GO
