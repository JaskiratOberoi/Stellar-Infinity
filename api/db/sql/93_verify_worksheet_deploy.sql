/*
 * 93_verify_worksheet_deploy.sql
 *
 * Post-deploy verification for the worksheet write path.
 *
 * Confirms every object exists, then exercises the REFUSAL paths of
 * usp_inf_result_save against real samples. Those refusals are the safety
 * properties that matter — a write path that accepts everything would "pass" a
 * happy-path test just as well.
 *
 * Writes nothing: every call is made inside a transaction that is rolled back,
 * and the cases exercised are ones the procedure must reject before writing.
 */
SET NOCOUNT ON;

PRINT 'Objects:';
DECLARE @o TABLE (name SYSNAME, kind CHAR(1));
INSERT INTO @o VALUES
    ('dbo.inf_result_audit','U'), ('dbo.inf_auth_audit','U'),
    ('dbo.inf_auto_auth_config','U'), ('dbo.inf_auto_auth_audit','U'),
    ('dbo.usp_inf_worksheet_sample','P'), ('dbo.usp_inf_result_save','P'),
    ('dbo.usp_inf_result_reopen','P'), ('dbo.usp_inf_admin_set_client_codes','P'),
    ('dbo.usp_inf_admin_user_detail','P'), ('dbo.usp_inf_admin_client_search','P'),
    ('dbo.usp_inf_admin_update_profile','P');

DECLARE @n SYSNAME, @k CHAR(1), @missing INT = 0;
DECLARE c CURSOR LOCAL FAST_FORWARD FOR SELECT name, kind FROM @o;
OPEN c; FETCH NEXT FROM c INTO @n, @k;
WHILE @@FETCH_STATUS = 0
BEGIN
    IF OBJECT_ID(@n, @k) IS NULL SET @missing += 1;
    PRINT '  ' + LEFT(@n + REPLICATE(' ', 38), 38)
        + CASE WHEN OBJECT_ID(@n, @k) IS NULL THEN 'MISSING' ELSE 'ok' END;
    FETCH NEXT FROM c INTO @n, @k;
END
CLOSE c; DEALLOCATE c;

PRINT '  TYPE dbo.InfResultEdit                ' + CASE WHEN TYPE_ID('dbo.InfResultEdit') IS NULL THEN 'MISSING' ELSE 'ok' END;

IF @missing > 0 OR TYPE_ID('dbo.InfResultEdit') IS NULL
BEGIN
    RAISERROR('Worksheet deployment incomplete.', 16, 1);
    RETURN;
END

PRINT '';
PRINT 'Refusal paths (each must raise, nothing is committed):';

DECLARE @edits dbo.InfResultEdit;
DECLARE @err NVARCHAR(400);

-- 1. Unknown sample must be refused.
BEGIN TRY
    BEGIN TRAN;
    EXEC dbo.usp_inf_result_save
        @sid = N'__no_such_sid__', @edits = @edits, @actor_user_id = 1,
        @can_enter = 1, @can_amend = 1, @can_authorize = 1;
    ROLLBACK;
    PRINT '  unknown sample        NOT REFUSED  <-- problem';
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK;
    SET @err = ERROR_MESSAGE();
    PRINT '  unknown sample        refused: ' + LEFT(@err, 70);
END CATCH

DECLARE @realSid NVARCHAR(50) =
    (SELECT TOP 1 s.vailid FROM dbo.tbl_med_mcc_patient_samples s
     WHERE s.vailid IS NOT NULL AND s.sample_status > 1 ORDER BY s.id DESC);

IF @realSid IS NOT NULL
BEGIN
    -- 2. Unknown acting user must be refused.
    BEGIN TRY
        BEGIN TRAN;
        EXEC dbo.usp_inf_result_save
            @sid = @realSid, @edits = @edits, @actor_user_id = -999,
            @can_enter = 1, @can_amend = 1, @can_authorize = 1;
        ROLLBACK;
        PRINT '  unknown actor         NOT REFUSED  <-- problem';
    END TRY
    BEGIN CATCH
        IF @@TRANCOUNT > 0 ROLLBACK;
        SET @err = ERROR_MESSAGE();
        PRINT '  unknown actor         refused: ' + LEFT(@err, 70);
    END CATCH

    -- 3. An authorised / printed sample must be refused for editing. This is
    --    the guard that makes Technician's result:amend safe by construction.
    DECLARE @lockedSid NVARCHAR(50) =
        (SELECT TOP 1 s.vailid FROM dbo.tbl_med_mcc_patient_samples s
         WHERE s.vailid IS NOT NULL AND s.sample_status IN (7,8,9) ORDER BY s.id DESC);

    IF @lockedSid IS NULL
        PRINT '  authorised sample     no locked sample available to test';
    ELSE
    BEGIN
        BEGIN TRY
            BEGIN TRAN;
            EXEC dbo.usp_inf_result_save
                @sid = @lockedSid, @edits = @edits, @actor_user_id = 1,
                @can_enter = 1, @can_amend = 1, @can_authorize = 1;
            ROLLBACK;
            PRINT '  authorised sample     NOT REFUSED  <-- problem';
        END TRY
        BEGIN CATCH
            IF @@TRANCOUNT > 0 ROLLBACK;
            SET @err = ERROR_MESSAGE();
            PRINT '  authorised sample     refused: ' + LEFT(@err, 70);
        END CATCH
    END

    -- 4. Reopen without the capability-bearing reason must be refused.
    BEGIN TRY
        BEGIN TRAN;
        EXEC dbo.usp_inf_result_reopen
            @sid = @realSid, @reason = N'', @actor_user_id = 1;
        ROLLBACK;
        PRINT '  reopen, empty reason  NOT REFUSED  <-- problem';
    END TRY
    BEGIN CATCH
        IF @@TRANCOUNT > 0 ROLLBACK;
        SET @err = ERROR_MESSAGE();
        PRINT '  reopen, empty reason  refused: ' + LEFT(@err, 70);
    END CATCH
END
ELSE
    PRINT '  (no reportable sample found to test against)';

PRINT '';
DECLARE @auditRows INT = (SELECT COUNT(*) FROM dbo.inf_result_audit);
PRINT 'inf_result_audit rows (should be unchanged by this script): ' + CAST(@auditRows AS VARCHAR(20));
GO
