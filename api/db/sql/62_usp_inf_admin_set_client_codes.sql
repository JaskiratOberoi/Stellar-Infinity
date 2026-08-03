/*
 * 62_usp_inf_admin_set_client_codes.sql
 *
 * Sets a user's client-code access to EXACTLY the supplied set, by inserting
 * and deleting rows in dbo.tbl_med_user_sales_mcc_mapping.
 *
 * This is the most security-relevant admin action in Infinity: that mapping is
 * what ScopeRepository resolves into MCC scope, which decides whose patients,
 * bills and reports a user can see. Consequences of getting it wrong run in
 * both directions — too few codes and a reporting user sees nothing (the exact
 * failure Telo hit with CLIENT REPORTING accounts); too many and one client
 * reads another's patients.
 *
 * ── WRITING TO A SHARED LIS TABLE ──────────────────────────────────────────
 * tbl_med_user_sales_mcc_mapping belongs to the legacy LIS, not to Infinity.
 * Three consequences, all handled here:
 *
 *   • Rows Infinity inserts are stamped addedby = 'inf:<actor>' so they stay
 *     attributable and distinguishable from LIS-created ones.
 *
 *   • Deletions are reported back per row, with whether each removed mapping
 *     was Infinity's or the LIS's. The caller writes that into the audit trail;
 *     silently discarding an LIS-created grant would be untraceable.
 *
 *   • The whole change is one transaction. A half-applied scope change is a
 *     user with access to an arbitrary subset - worse than a failed save.
 *
 * Codes are matched case-insensitively against MCCUnitCode. Unknown codes are
 * REJECTED rather than ignored, because silently dropping a code an admin
 * typed produces a user who quietly cannot see what the admin believes they
 * granted.
 *
 * Passing an EMPTY set is legitimate and means "revoke all explicit mappings".
 * It is not the same as unrestricted - see ScopeFilter.
 *
 * Returns { ok, error_code, message, added, removed } plus a detail rowset of
 * the changes actually made.
 */
CREATE OR ALTER PROCEDURE dbo.usp_inf_admin_set_client_codes
    @userId INT,
    @codes  dbo.ClientCodeList READONLY,
    @actor  INT
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    IF NOT EXISTS (SELECT 1 FROM dbo.tbl_med_user_master WHERE id = @userId)
    BEGIN
        SELECT ok = CAST(0 AS BIT), error_code = 'NOT_FOUND',
               message = N'User not found', added = 0, removed = 0;
        RETURN;
    END

    /* Same Super-Admin guard as the other admin procedures: only an LIS Super
       Admin may alter what a Super Admin can reach. */
    IF EXISTS (SELECT 1 FROM dbo.tbl_med_user_master WHERE id = @userId AND usertypeid = 1)
       AND NOT EXISTS (SELECT 1 FROM dbo.tbl_med_user_master WHERE id = @actor AND usertypeid = 1)
    BEGIN
        SELECT ok = CAST(0 AS BIT), error_code = 'FORBIDDEN',
               message = N'Only an LIS Super Admin may modify this user', added = 0, removed = 0;
        RETURN;
    END

    -- Resolve codes to ids. TRIM + case-insensitive, matching how operators type.
    DECLARE @wanted TABLE (mcc_id INT PRIMARY KEY, client_code NVARCHAR(50));

    INSERT INTO @wanted (mcc_id, client_code)
    SELECT DISTINCT c.id, c.MCCUnitCode
    FROM @codes k
    JOIN dbo.tbl_med_mcc_unit_master c
      ON UPPER(LTRIM(RTRIM(c.MCCUnitCode))) = UPPER(LTRIM(RTRIM(k.code)));

    -- Reject unknown codes rather than silently dropping them.
    DECLARE @unknown NVARCHAR(MAX) = NULL;
    SELECT @unknown = STRING_AGG(k.code, ', ')
    FROM @codes k
    WHERE NOT EXISTS (
        SELECT 1 FROM dbo.tbl_med_mcc_unit_master c
        WHERE UPPER(LTRIM(RTRIM(c.MCCUnitCode))) = UPPER(LTRIM(RTRIM(k.code))));

    IF @unknown IS NOT NULL
    BEGIN
        SELECT ok = CAST(0 AS BIT), error_code = 'VALIDATION',
               message = N'Unknown client code(s): ' + LEFT(@unknown, 300),
               added = 0, removed = 0;
        RETURN;
    END

    /* OUTPUT cannot contain a subquery, so only raw columns are captured here;
       the client code is resolved by join in the final SELECT. */
    DECLARE @changes TABLE (
        change      VARCHAR(10),
        mcc_id      INT,
        prior_owner NVARCHAR(100)
    );

    BEGIN TRY
        BEGIN TRAN;

        -- Remove mappings no longer wanted, capturing who had created them.
        DELETE m
        OUTPUT 'removed', deleted.mcc_code, deleted.addedby
        INTO @changes (change, mcc_id, prior_owner)
        FROM dbo.tbl_med_user_sales_mcc_mapping m
        WHERE m.user_id = @userId
          AND NOT EXISTS (SELECT 1 FROM @wanted w WHERE w.mcc_id = m.mcc_code);

        -- Add the ones missing.
        INSERT INTO dbo.tbl_med_user_sales_mcc_mapping (user_id, mcc_code, addeddate, addedby)
        OUTPUT 'added', inserted.mcc_code, NULL
        INTO @changes (change, mcc_id, prior_owner)
        SELECT @userId, w.mcc_id, GETDATE(), CONCAT(N'inf:', @actor)
        FROM @wanted w
        WHERE NOT EXISTS (
            SELECT 1 FROM dbo.tbl_med_user_sales_mcc_mapping m
            WHERE m.user_id = @userId AND m.mcc_code = w.mcc_id);

        -- Scope is cached in the API and baked into issued tokens, so a change
        -- here must invalidate outstanding sessions or it will not take effect
        -- until they expire.
        EXEC dbo.usp_inf_bump_session_version @userId = @userId, @reason = N'client code access changed';

        COMMIT;

        DECLARE @added INT = (SELECT COUNT(*) FROM @changes WHERE change = 'added');
        DECLARE @removed INT = (SELECT COUNT(*) FROM @changes WHERE change = 'removed');

        SELECT ok = CAST(1 AS BIT), error_code = CAST(NULL AS VARCHAR(20)),
               message = CAST(NULL AS NVARCHAR(200)),
               added = @added, removed = @removed;

        SELECT ch.change,
               ch.mcc_id,
               c.MCCUnitCode AS client_code,
               ch.prior_owner
        FROM @changes ch
        LEFT JOIN dbo.tbl_med_mcc_unit_master c ON c.id = ch.mcc_id
        ORDER BY ch.change, c.MCCUnitCode;
    END TRY
    BEGIN CATCH
        IF @@TRANCOUNT > 0 ROLLBACK;
        SELECT ok = CAST(0 AS BIT), error_code = 'INTERNAL',
               message = LEFT(ERROR_MESSAGE(), 200), added = 0, removed = 0;
    END CATCH
END
GO
