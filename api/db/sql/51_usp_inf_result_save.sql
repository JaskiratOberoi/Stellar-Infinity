SET QUOTED_IDENTIFIER ON;
GO
/*
 * 41_usp_inf_result_save.sql
 *
 * Apply a batch of worksheet edits to one sample: values, comments and
 * authorisation flags, with a full audit row per field changed, the abnormal
 * flag derived server-side, auto-authorisation applied where configured, and
 * the sample status recomputed. All in one transaction.
 *
 * ===========================================================================
 * WHAT THIS PROCEDURE IS FIXING
 *
 * The legacy equivalent is WorksheetClass.UpdateSampleResult (MedCis.Business/
 * Pcc/WorksheetClass.cs:1717-1776), called from btnSave_Click. Every numbered
 * defect below is one this procedure exists to avoid.
 *
 * 1. NO TRANSACTION. The legacy save calls SubmitChanges, then recomputes
 *    status, then calls UpdateComments, with nothing tying them together and a
 *    catch that writes the exception text into a label. A failure part-way
 *    leaves the sample half-saved. Here: one transaction, XACT_ABORT ON.
 *
 * 2. COMMENTS PIN STATUS — DELIBERATELY. UpdateComments (:1957-1958) sets
 *    sample_status to 10 (Pending) whenever a sample comment is non-empty,
 *    called unconditionally right after the status computation and silently
 *    discarding the 4/5/6/7 transition just calculated. This first read as a
 *    defect and was left out — until the lab explained it is how a sample is
 *    put ON HOLD: "Pending", "On Hold", "Test Not Performed" in the big
 *    comment box are instructions to the bench, and the status following the
 *    box is the feature. So the rule is kept, with the rough edges filed off:
 *    the pin is applied once, AFTER the recompute, inside the same
 *    transaction; the status change lands in the audit like any other; and
 *    clearing the comment and saving releases the sample to whatever its
 *    results actually warrant — which is how the legacy releases one too,
 *    since its recompute runs before UpdateComments on every save.
 *
 * 3. PERMISSION ENFORCED BY DISABLING A CHECKBOX. The legacy checks
 *    tbl_med_mcc_user_security_auth only to set chkAuth.Enabled; the save
 *    handler re-reads whatever posted back. Because a disabled ASP.NET
 *    CheckBox posts as unchecked, a user WITHOUT the authorise right who saves
 *    the page silently CLEARS every existing authorisation on it. Here the
 *    caller's rights arrive as explicit flags and a violation aborts the whole
 *    batch before anything is written.
 *
 * 4. ORDER-DEPENDENT STATUS ARITHMETIC. The legacy's `|| (authCount > 0)`
 *    clause can set 7 on a partly-filled panel, which a later line then pulls
 *    back to 6. It also never guards status 3 (Rejected). The rules below are
 *    mutually exclusive and evaluated once.
 *
 * 5. NO VALUE HISTORY. See 04_table_inf_result_audit.sql.
 *
 * ===========================================================================
 * AUTO-AUTHORISATION
 *
 * Applies only when: a rule is enabled for the analyte's test / profile /
 * department, the value parses as a number, live 'Auth' bounds exist for this
 * patient, and the value falls inside them. Head and Profile rows are never
 * auto-authorised — they carry no value.
 *
 * It fires REGARDLESS of whether the saving user holds result:authorize. That
 * is the entire point of the feature: the system is authorising, not the
 * person. Which is exactly why it is off by default, gated behind a password at
 * configuration time, and written to the audit trail as action
 * 'auto_authorize' with source 'auto' so it can never be confused with a human
 * decision.
 *
 * ===========================================================================
 * Returns one row: applied (count), status_before, status_after, plus
 * auto_authorized (count). Raises an error with a usable message on a
 * permission violation or a missing amend reason — the API maps those to 403
 * and 400 respectively.
 */
CREATE OR ALTER PROCEDURE dbo.usp_inf_result_save
    @sid            NVARCHAR(50),
    @edits          dbo.InfResultEdit READONLY,

    -- The caller's identity, resolved from the JWT. Never accepted as a
    -- display name — actor_username is written from the LIS user row.
    @actor_user_id  INT,
    @actor_ip       VARCHAR(64)   = NULL,
    @actor_agent    NVARCHAR(256) = NULL,

    -- The caller's capabilities, passed explicitly rather than re-derived here.
    -- The API is the authority on who holds what; this procedure's job is to
    -- refuse to act beyond what it was told.
    @can_enter      BIT,
    @can_amend      BIT,
    @can_authorize  BIT,

    -- Sample-level free text. NULL leaves each alone. Deliberately does not
    -- touch sample_status (defect 2 above).
    @sample_comments          VARCHAR(500) = NULL,
    @sample_clinical_history  VARCHAR(500) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE @origin VARCHAR(64) = 'inf:' + CONVERT(VARCHAR(20), @actor_user_id);
    DECLARE @actor_username NVARCHAR(50) =
        (SELECT Username FROM dbo.tbl_med_user_master WHERE id = @actor_user_id);

    IF @actor_username IS NULL
    BEGIN
        RAISERROR('Unknown acting user.', 16, 1);
        RETURN;
    END

    DECLARE @sample_id INT, @patient_id INT, @status_before INT,
            @age INT, @age_type INT, @gender INT;

    SELECT @sample_id     = s.id,
           @patient_id    = p.id,
           @status_before = s.sample_status,
           @age           = p.age,
           @age_type      = p.age_type,
           @gender        = p.gender
    FROM dbo.tbl_med_mcc_patient_samples s
    JOIN dbo.tbl_med_mcc_patient_master  p ON p.id = s.patient_id
    WHERE s.vailid = @sid;

    IF @sample_id IS NULL
    BEGIN
        RAISERROR('Sample %s was not found.', 16, 1, @sid);
        RETURN;
    END

    -- Frozen states. An authorised or printed sample must go through
    -- usp_inf_result_reopen first, which requires result:reopen and a reason.
    -- The legacy blocks 7 and 9 but not 8, and not 3 — a rejected sample stays
    -- freely editable there.
    IF @status_before IN (7, 8, 9)
    BEGIN
        RAISERROR('This sample is authorised or printed. Reopen it before editing.', 16, 1);
        RETURN;
    END

    IF @status_before = 3
    BEGIN
        RAISERROR('This sample was rejected and cannot accept results.', 16, 1);
        RETURN;
    END

    ------------------------------------------------------------------
    -- Resolve every edit against current state, before writing anything.
    --
    -- The read below happens INSIDE the transaction and takes UPDLOCK on the
    -- result rows. Reading current values outside it and writing inside would
    -- be a time-of-check/time-of-use race: two technologists saving the same
    -- panel could each decide independently that they were entering a value
    -- into an empty cell, and the second would overwrite the first with no
    -- amend recorded and no reason demanded. Holding the lock from the moment
    -- the old value is read is what makes "was this an entry or an amendment"
    -- a decidable question.
    ------------------------------------------------------------------
    CREATE TABLE #work (
        result_id     INT PRIMARY KEY,
        testtype      VARCHAR(10),
        testcode      VARCHAR(50),
        testid        INT,
        paramid       INT,
        profile_id    INT,
        master_profile_id INT,
        department_id INT,

        old_value     NVARCHAR(MAX),
        new_value     NVARCHAR(MAX),
        value_changed BIT,
        is_amend      BIT,

        old_comments  NVARCHAR(MAX),
        new_comments  NVARCHAR(MAX),
        comments_changed BIT,

        old_auth      BIT,
        req_auth      BIT,

        old_abnormal  BIT,
        new_abnormal  BIT,

        range_low     DECIMAL(18,6),
        range_high    DECIMAL(18,6),
        numeric_value DECIMAL(18,6),

        auto_auth     BIT,
        reason        NVARCHAR(500)
    );

    BEGIN TRY
    BEGIN TRANSACTION;

    -- One deterministic range row per result, same rule as the read procedure.
    WITH bounds AS (
        SELECT r.id AS result_id,
               TRY_CONVERT(DECIMAL(18,6), nr.fnormal) AS low,
               TRY_CONVERT(DECIMAL(18,6), nr.tnormal) AS high,
               ROW_NUMBER() OVER (PARTITION BY r.id ORDER BY nr.id) AS rn
        FROM dbo.tbl_med_mcc_patient_test_result r
        JOIN dbo.tbl_med_test_normalranges nr
              ON nr.testid = r.testid AND nr.ReportType = 'Auth'
             AND ISNULL(nr.IsActive, 1) = 1
             AND nr.agetype = CONVERT(NVARCHAR(10), @age_type)
             AND nr.gender  = @gender
             AND @age BETWEEN nr.fage AND nr.tage
        WHERE r.vailid = @sid AND r.testtype = 'Test'
        UNION ALL
        SELECT r.id,
               TRY_CONVERT(DECIMAL(18,6), pnr.fnormal),
               TRY_CONVERT(DECIMAL(18,6), pnr.tnormal),
               ROW_NUMBER() OVER (PARTITION BY r.id ORDER BY pnr.id)
        FROM dbo.tbl_med_mcc_patient_test_result r
        JOIN dbo.tbl_med_test_param_normalranges pnr
              ON pnr.testid = r.testid AND pnr.paramid = r.paramid
             AND pnr.ReportType = 'Auth'
             AND ISNULL(pnr.IsActive, 1) = 1
             AND pnr.agetype = CONVERT(NVARCHAR(10), @age_type)
             AND pnr.gender  = @gender
             AND @age BETWEEN pnr.fage AND pnr.tage
        WHERE r.vailid = @sid AND r.testtype = 'Param'
    )
    INSERT INTO #work (
        result_id, testtype, testcode, testid, paramid, profile_id, master_profile_id, department_id,
        old_value, new_value, value_changed, is_amend,
        old_comments, new_comments, comments_changed,
        old_auth, req_auth, old_abnormal, new_abnormal,
        range_low, range_high, numeric_value, auto_auth, reason)
    SELECT
        r.id,
        r.testtype,
        r.testcode,
        r.testid,
        r.paramid,
        r.profile_id,
        r.master_profile_id,
        tm.DepartmentId,

        r.value,
        -- NULL in the TVP means "not touched"; the coalesce keeps the old value.
        COALESCE(e.value, r.value),
        CASE WHEN e.value IS NOT NULL
              AND ISNULL(e.value, '') <> ISNULL(r.value, '') THEN 1 ELSE 0 END,
        -- An amend is overwriting something that was already there. Entering a
        -- value into an empty cell is not an amend, and clearing one is.
        CASE WHEN e.value IS NOT NULL
              AND LTRIM(RTRIM(ISNULL(r.value, ''))) <> ''
              AND ISNULL(e.value, '') <> ISNULL(r.value, '') THEN 1 ELSE 0 END,

        r.comments,
        COALESCE(e.comments, r.comments),
        CASE WHEN e.comments IS NOT NULL
              AND ISNULL(e.comments, '') <> ISNULL(r.comments, '') THEN 1 ELSE 0 END,

        ISNULL(r.auth, 0),
        e.set_auth,
        ISNULL(r.abnormal, 0),
        0,                                  -- recomputed below

        b.low,
        b.high,
        TRY_CONVERT(DECIMAL(18,6), LTRIM(RTRIM(COALESCE(e.value, r.value)))),
        0,                                  -- decided below
        e.reason
    FROM @edits e
    JOIN dbo.tbl_med_mcc_patient_test_result r WITH (UPDLOCK, ROWLOCK) ON r.id = e.result_id
    LEFT JOIN bounds b ON b.result_id = r.id AND b.rn = 1
    LEFT JOIN dbo.tbl_med_test_master tm ON tm.id = r.testid
    WHERE r.vailid = @sid;          -- an edit naming a row from another sample is ignored

    ------------------------------------------------------------------
    -- Derive the abnormal flag. Never accepted from the caller.
    ------------------------------------------------------------------
    UPDATE #work
    SET new_abnormal =
        CASE
            WHEN numeric_value IS NULL OR range_low IS NULL OR range_high IS NULL
                -- Not range-checkable: preserve whatever was already recorded
                -- rather than asserting "normal", which is what binding the
                -- checkbox to a literal false does in the legacy UI.
                THEN old_abnormal
            WHEN numeric_value < range_low OR numeric_value > range_high THEN 1
            ELSE 0
        END;

    ------------------------------------------------------------------
    -- Permission gates. Checked across the WHOLE batch before any write, so a
    -- save is all-or-nothing: a grid containing one edit the caller may not
    -- make applies none of them.
    --
    -- No RETURN here — these run inside the transaction, and RAISERROR at
    -- severity 16 inside TRY transfers to CATCH, which rolls back and rethrows.
    -- A RETURN would abandon an open transaction.
    ------------------------------------------------------------------
    IF @can_enter = 0 AND EXISTS (SELECT 1 FROM #work WHERE value_changed = 1 AND is_amend = 0)
        RAISERROR('You do not have permission to enter results.', 16, 1);

    IF @can_amend = 0 AND EXISTS (SELECT 1 FROM #work WHERE is_amend = 1)
        RAISERROR('You do not have permission to change a result that already has a value.', 16, 1);

    -- A reason is mandatory for an amend, and enforced here rather than only in
    -- the UI. The legacy asks for one, accepts any non-empty string, and never
    -- re-checks it server-side.
    IF EXISTS (SELECT 1 FROM #work WHERE is_amend = 1 AND LEN(LTRIM(RTRIM(ISNULL(reason, '')))) < 3)
        RAISERROR('Changing an existing result requires a reason of at least 3 characters.', 16, 1);

    -- Authorising and revoking both require the capability. Revocation is
    -- included on purpose: silently dropping an authorisation is exactly the
    -- legacy bug described at the top.
    IF @can_authorize = 0 AND EXISTS (
        SELECT 1 FROM #work WHERE req_auth IS NOT NULL AND req_auth <> old_auth)
        RAISERROR('You do not have permission to authorise or revoke results.', 16, 1);

    ------------------------------------------------------------------
    -- Auto-authorisation.
    ------------------------------------------------------------------
    -- Scoped per test per BUSINESS UNIT since migration 54. Department
    -- scoping is gone: a department is a property of the test (potassium is
    -- biochemistry everywhere), so it could not express "automatic at the main
    -- lab, manual at the satellite" — which is the distinction that actually
    -- governs whether an unread result may go out.
    --
    -- Resolution, most specific first:
    --   1. this test, THIS unit
    --   2. this test, all units (business_unit_id IS NULL)
    --   3. the profile, same two steps
    -- so a blanket rule can be carved out for one branch.
    --
    -- @sample_bu is the unit that actually ran the sample.
    -- `rule` is a reserved word in T-SQL (the deprecated CREATE RULE object),
    -- so the derived table is aliased aa.
    DECLARE @sample_bu INT =
        (SELECT business_unit_id FROM dbo.tbl_med_mcc_patient_samples WHERE id = @sample_id);

    UPDATE w
    SET auto_auth = 1
    FROM #work w
    CROSS APPLY (
        SELECT TOP 1 cfg.require_in_range, cfg.allow_out_of_range, cfg.numeric_only
        FROM dbo.inf_auto_auth_config cfg
        WHERE cfg.enabled = 1
          AND (
                (cfg.scope_type = 'test'    AND cfg.scope_key = w.testcode)
             OR (cfg.scope_type = 'profile' AND TRY_CONVERT(INT, cfg.scope_key) IN (w.profile_id, w.master_profile_id))
              )
          -- A unit-specific rule applies only to that unit; a NULL rule is the
          -- blanket one. Nothing else matches.
          AND (cfg.business_unit_id IS NULL OR cfg.business_unit_id = @sample_bu)
        ORDER BY
            CASE WHEN cfg.business_unit_id IS NOT NULL THEN 0 ELSE 1 END,
            CASE cfg.scope_type WHEN 'test' THEN 0 ELSE 1 END
    ) aa
    WHERE w.testtype IN ('Test', 'Param')      -- never Head or Profile rows
      AND w.old_auth = 0                       -- do not re-fire on an already-signed row
      AND ISNULL(w.req_auth, 0) = 0            -- an explicit human decision wins
      AND LTRIM(RTRIM(ISNULL(w.new_value, ''))) <> ''
      AND (aa.numeric_only = 0 OR w.numeric_value IS NOT NULL)
      AND (
            -- The normal case: in range, bounds exist.
            (aa.require_in_range = 1
             AND w.numeric_value IS NOT NULL
             AND w.range_low  IS NOT NULL
             AND w.range_high IS NOT NULL
             AND w.numeric_value BETWEEN w.range_low AND w.range_high)
            -- The deliberately awkward case, requiring both flags to be set.
         OR (aa.allow_out_of_range = 1 AND aa.require_in_range = 0)
          );

        ------------------------------------------------------------------
        -- Write.
        ------------------------------------------------------------------
        -- --- audit first, while the old values are still readable ---------
        -- Clearing a value counts as 'amend', not a separate action: it
        -- overwrites something a clinician may have acted on, and so it must
        -- carry a reason exactly as any other overwrite does.
        INSERT INTO dbo.inf_result_audit
            (result_id, vailid, patient_id, test_code, action, field, old_value, new_value, reason,
             actor_user_id, actor_username, actor_ip, actor_user_agent, source, origin)
        SELECT w.result_id, @sid, @patient_id, w.testcode,
               CASE WHEN w.is_amend = 1 THEN 'amend' ELSE 'enter' END,
               'value', w.old_value, w.new_value, w.reason,
               @actor_user_id, @actor_username, @actor_ip, @actor_agent, 'ui', @origin
        FROM #work w
        WHERE w.value_changed = 1;

        INSERT INTO dbo.inf_result_audit
            (result_id, vailid, patient_id, test_code, action, field, old_value, new_value,
             actor_user_id, actor_username, actor_ip, actor_user_agent, source, origin)
        SELECT w.result_id, @sid, @patient_id, w.testcode,
               CASE WHEN LTRIM(RTRIM(ISNULL(w.old_comments, ''))) = '' THEN 'enter' ELSE 'amend' END,
               'comments', w.old_comments, w.new_comments,
               @actor_user_id, @actor_username, @actor_ip, @actor_agent, 'ui', @origin
        FROM #work w
        WHERE w.comments_changed = 1;

        -- Explicit human authorisation / revocation.
        INSERT INTO dbo.inf_result_audit
            (result_id, vailid, patient_id, test_code, action, field, old_value, new_value,
             actor_user_id, actor_username, actor_ip, actor_user_agent, source, origin)
        SELECT w.result_id, @sid, @patient_id, w.testcode,
               CASE WHEN w.req_auth = 1 THEN 'authorize' ELSE 'unauthorize' END,
               'auth',
               CONVERT(NVARCHAR(1), w.old_auth), CONVERT(NVARCHAR(1), w.req_auth),
               @actor_user_id, @actor_username, @actor_ip, @actor_agent, 'ui', @origin
        FROM #work w
        WHERE w.req_auth IS NOT NULL AND w.req_auth <> w.old_auth;

        -- Auto-authorisation: its own action, its own source. A reviewer
        -- filtering the trail on source = 'auto' gets exactly the set of
        -- results no human read before release, which is the question an
        -- auditor actually asks.
        INSERT INTO dbo.inf_result_audit
            (result_id, vailid, patient_id, test_code, action, field, old_value, new_value, reason,
             actor_user_id, actor_username, actor_ip, actor_user_agent, source, origin)
        SELECT w.result_id, @sid, @patient_id, w.testcode, 'auto_authorize', 'auth', '0', '1',
               CONCAT('value ', w.new_value, ' within reference range ',
                      w.range_low, ' - ', w.range_high),
               @actor_user_id, @actor_username, @actor_ip, @actor_agent, 'auto', @origin
        FROM #work w
        WHERE w.auto_auth = 1;

        -- The abnormal flag is computed, not asserted, so it is logged as
        -- 'derive'. Recording it as an amendment would misattribute an
        -- arithmetic consequence to the operator.
        INSERT INTO dbo.inf_result_audit
            (result_id, vailid, patient_id, test_code, action, field, old_value, new_value,
             actor_user_id, actor_username, actor_ip, actor_user_agent, source, origin)
        SELECT w.result_id, @sid, @patient_id, w.testcode, 'derive', 'abnormal',
               CONVERT(NVARCHAR(1), w.old_abnormal), CONVERT(NVARCHAR(1), w.new_abnormal),
               @actor_user_id, @actor_username, @actor_ip, @actor_agent, 'ui', @origin
        FROM #work w
        WHERE w.new_abnormal <> w.old_abnormal;

        -- --- then the rows themselves ------------------------------------
        UPDATE r
        SET value      = w.new_value,
            comments   = w.new_comments,
            abnormal   = w.new_abnormal,
            auth       = CASE WHEN w.req_auth IS NOT NULL THEN w.req_auth
                              WHEN w.auto_auth = 1 THEN 1
                              ELSE w.old_auth END,
            -- The attribution columns the legacy declares and never writes.
            --
            -- Stamped with the origin marker ('inf:<userId>'), not a bare
            -- username, per the convention in Domain/Origin.cs: Noble is shared
            -- with the legacy LIS and with Telo, and a row has to say which
            -- system last touched it. Human-readable attribution is not lost —
            -- it lives in inf_result_audit.actor_username, where it is
            -- append-only rather than overwritten by the next save.
            addedby    = CASE WHEN LTRIM(RTRIM(ISNULL(r.addedby, ''))) = '' AND w.value_changed = 1
                              THEN @origin ELSE r.addedby END,
            addeddate  = CASE WHEN r.addeddate IS NULL AND w.value_changed = 1
                              THEN GETDATE() ELSE r.addeddate END,
            updatedby  = @origin,
            updateddate = GETDATE()
        FROM dbo.tbl_med_mcc_patient_test_result r
        JOIN #work w ON w.result_id = r.id
        WHERE w.value_changed = 1
           OR w.comments_changed = 1
           OR w.auto_auth = 1
           OR w.new_abnormal <> w.old_abnormal
           OR (w.req_auth IS NOT NULL AND w.req_auth <> w.old_auth);

        -- --- sample-level free text ---------------------------------------
        -- An empty string is a deliberate CLEAR and flows through COALESCE
        -- as one; only NULL means "not touched this save". The hold that a
        -- non-empty comment implies is applied after the recompute below —
        -- see note 2 in the header.
        IF @sample_comments IS NOT NULL OR @sample_clinical_history IS NOT NULL
        BEGIN
            UPDATE dbo.tbl_med_mcc_patient_samples
            SET Sample_Comments        = COALESCE(@sample_comments, Sample_Comments),
                Sample_ClinicalHistory = COALESCE(@sample_clinical_history, Sample_ClinicalHistory),
                lastmodified_date      = GETDATE()
            WHERE id = @sample_id;
        END

        ------------------------------------------------------------------
        -- Recompute sample status.
        ------------------------------------------------------------------
        DECLARE @total INT, @filled INT, @authed INT, @status_after INT;

        SELECT @total  = COUNT(*),
               @filled = SUM(CASE WHEN LTRIM(RTRIM(ISNULL(value, ''))) <> '' THEN 1 ELSE 0 END),
               @authed = SUM(CASE WHEN ISNULL(auth, 0) = 1 THEN 1 ELSE 0 END)
        FROM dbo.tbl_med_mcc_patient_test_result
        WHERE vailid = @sid
          AND testtype NOT IN ('Head', 'Profile');   -- scaffolding rows never count

        SET @status_after =
            CASE
                WHEN @total  = 0            THEN @status_before
                WHEN @filled = 0            THEN 2    -- Registered
                WHEN @authed = 0 AND @filled < @total THEN 4    -- Partially Tested
                WHEN @authed = 0                      THEN 5    -- Tested
                WHEN @authed = @total AND @filled = @total THEN 7    -- Authorized
                ELSE 6                                          -- Partially Authorized
            END;

        -- The hold. A non-empty sample comment pins the sample at 10
        -- (Pending) no matter what the counts just said — mirroring the
        -- legacy UpdateComments, which the lab drives by writing "On Hold" /
        -- "Test Not Performed" / "Pending" into the big comment box. Read
        -- back from the row rather than trusting @sample_comments, so a save
        -- that leaves an existing comment untouched (@sample_comments NULL)
        -- keeps the hold, and one that just cleared it releases.
        DECLARE @held VARCHAR(500);
        SELECT @held = Sample_Comments
        FROM dbo.tbl_med_mcc_patient_samples
        WHERE id = @sample_id;

        IF LTRIM(RTRIM(ISNULL(@held, ''))) <> ''
            SET @status_after = 10;    -- Pending

        IF @status_after <> @status_before
        BEGIN
            UPDATE dbo.tbl_med_mcc_patient_samples
            SET sample_status     = @status_after,
                lastmodified_date = GETDATE(),
                -- Attribution only when the sample actually reaches Authorized.
                authorised_by     = CASE WHEN @status_after = 7 THEN @actor_user_id ELSE authorised_by END
            WHERE id = @sample_id;

            INSERT INTO dbo.inf_result_audit
                (result_id, vailid, patient_id, action, field, old_value, new_value,
                 actor_user_id, actor_username, actor_ip, actor_user_agent, source, origin)
            VALUES (NULL, @sid, @patient_id, 'status', 'status',
                    CONVERT(NVARCHAR(10), @status_before), CONVERT(NVARCHAR(10), @status_after),
                    @actor_user_id, @actor_username, @actor_ip, @actor_agent, 'ui', @origin);
        END

        DECLARE @applied INT = (SELECT COUNT(*) FROM #work
                                WHERE value_changed = 1 OR comments_changed = 1 OR auto_auth = 1
                                   OR (req_auth IS NOT NULL AND req_auth <> old_auth));
        DECLARE @auto INT = (SELECT COUNT(*) FROM #work WHERE auto_auth = 1);

        COMMIT TRANSACTION;

        SELECT @applied        AS applied,
               @auto           AS auto_authorized,
               @status_before  AS status_before,
               ISNULL(@status_after, @status_before) AS status_after;
    END TRY
    BEGIN CATCH
        IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
        THROW;
    END CATCH
END
GO
