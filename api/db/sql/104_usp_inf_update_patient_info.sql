/*
 * 104_usp_inf_update_patient_info.sql
 *
 * Correcting a registered patient's demographics and referral from the
 * worksheet — Listec's "Edit Patient Info" button, which navigates to
 * EditWorkOrder.aspx and writes tbl_med_mcc_patient_master directly.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT usp_telo_update_patient_info
 *
 * Telo already has a patient-info writer, and reusing it was the obvious move.
 * It does not work here, for a reason worth recording so nobody tries again:
 *
 *   - It is keyed by BILL. It resolves the patient through the bill's medid,
 *     and it refuses outright when the bill's addedby is not 'telo:%'. The
 *     worksheet is keyed by SAMPLE, and the overwhelming majority of samples on
 *     it were registered by Listec — 22,707 bills in the database against ~456
 *     from Telo and Infinity combined. A bill-keyed, telo-only guard would
 *     refuse essentially every sample an operator actually opens.
 *   - Samples do not all have bills. A worksheet row can exist without one.
 *
 * So this is keyed by the sample, resolves the patient from it, and carries no
 * origin guard. That is a deliberate widening: Infinity may edit patient rows
 * that Telo's writer refuses to touch, including rows created by Listec.
 *
 * It is not new capability in the lab — Listec's own button does exactly this,
 * with no guard, no audit and no scope check. What is new is that the edit is
 * now scoped, capability-gated (patient:edit, which Technician and Client do
 * NOT hold) and written to an append-only trail.
 * ---------------------------------------------------------------------------
 *
 * NULL means "leave alone" for every field. The UI posts the whole form, so a
 * field the operator did not touch arrives unchanged rather than as NULL, but
 * the procedure does not depend on that: it compares before it writes and
 * records nothing for a column whose value did not actually move.
 *
 * Clearing a field is expressed as the empty string, not NULL — the same
 * convention the result grid uses, and for the same reason: a save that posts
 * every field cannot tell "untouched" from "cleared" if both are NULL.
 *
 * Returns one row: ok, error_code, changed (count of columns actually written).
 */
SET NOCOUNT ON;
SET QUOTED_IDENTIFIER ON;
GO

CREATE OR ALTER PROCEDURE dbo.usp_inf_update_patient_info
    @sid                NVARCHAR(50),
    @userId             INT,
    @username           NVARCHAR(100)  = NULL,
    @title              VARCHAR(10)    = NULL,
    @name               NVARCHAR(400)  = NULL,
    @age                INT            = NULL,
    @age_type           INT            = NULL,
    @gender             INT            = NULL,
    @ref_doctor         INT            = NULL,
    @ref_doctor_other   VARCHAR(200)   = NULL,
    @ref_customer       INT            = NULL,
    @ref_customer_other VARCHAR(200)   = NULL,
    @mobile             VARCHAR(50)    = NULL,
    @email              VARCHAR(100)   = NULL,
    @sample_time        DATETIME       = NULL,
    @clinical_history   NVARCHAR(MAX)  = NULL,
    @client_codes       dbo.ClientCodeList READONLY
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE @unrestricted BIT =
        CASE WHEN EXISTS (SELECT 1 FROM @client_codes) THEN 0 ELSE 1 END;

    DECLARE @pid INT, @sample_id INT;

    -- Resolve through the scope filter, so a caller who cannot see the sample
    -- cannot edit its patient either. Same predicate as the worksheet read.
    SELECT TOP 1 @sample_id = s.id, @pid = p.id
    FROM dbo.tbl_med_mcc_patient_samples s
    JOIN dbo.tbl_med_mcc_patient_master  p ON p.id = s.patient_id
    JOIN dbo.tbl_med_mcc_unit_master     u ON u.id = p.mcc_code
    WHERE s.vailid = @sid
      AND (@unrestricted = 1
           OR EXISTS (SELECT 1 FROM @client_codes c
                      WHERE c.code = LTRIM(RTRIM(u.MCCUnitCode))));

    IF @pid IS NULL
    BEGIN
        SELECT ok = CAST(0 AS BIT), error_code = 'NOT_FOUND', changed = 0;
        RETURN;
    END

    -- A referral id that does not exist would leave the header showing a blank
    -- doctor with no explanation, so reject it rather than store it.
    IF @ref_doctor IS NOT NULL AND @ref_doctor <> 0
       AND NOT EXISTS (SELECT 1 FROM dbo.tbl_med_mcc_doctors WHERE id = @ref_doctor)
    BEGIN
        SELECT ok = CAST(0 AS BIT), error_code = 'BAD_DOCTOR', changed = 0;
        RETURN;
    END

    IF @ref_customer IS NOT NULL AND @ref_customer <> 0
       AND NOT EXISTS (SELECT 1 FROM dbo.tbl_med_mcc_customer WHERE id = @ref_customer)
    BEGIN
        SELECT ok = CAST(0 AS BIT), error_code = 'BAD_CUSTOMER', changed = 0;
        RETURN;
    END

    -- age_type is 1/2/3 (years/months/days) everywhere in this schema. A value
    -- outside that renders as "Unknown" in every header and quietly breaks the
    -- paediatric reference-range bands.
    IF @age_type IS NOT NULL AND @age_type NOT IN (1, 2, 3)
    BEGIN
        SELECT ok = CAST(0 AS BIT), error_code = 'BAD_AGE_TYPE', changed = 0;
        RETURN;
    END

    IF @gender IS NOT NULL AND @gender NOT IN (1, 2)
    BEGIN
        SELECT ok = CAST(0 AS BIT), error_code = 'BAD_GENDER', changed = 0;
        RETURN;
    END

    IF @age IS NOT NULL AND (@age < 0 OR @age > 200)
    BEGIN
        SELECT ok = CAST(0 AS BIT), error_code = 'BAD_AGE', changed = 0;
        RETURN;
    END

    DECLARE @origin NVARCHAR(50) = CONCAT(N'inf:', @userId);
    DECLARE @changed INT = 0;

    BEGIN TRY
        BEGIN TRAN;

        -- Snapshot under the same lock the UPDATE will take, so the old values
        -- written to the trail are the ones this statement actually replaced
        -- and not a version another session overwrote in between.
        DECLARE
            @o_title VARCHAR(10), @o_name NVARCHAR(400), @o_age INT, @o_age_type INT,
            @o_gender INT, @o_ref_doctor INT, @o_ref_doctor_other VARCHAR(200),
            @o_ref_customer INT, @o_ref_customer_other VARCHAR(200),
            @o_mobile VARCHAR(20), @o_email VARCHAR(100), @o_sample_time DATETIME;

        SELECT
            @o_title = p.initial, @o_name = p.name, @o_age = p.age,
            @o_age_type = p.age_type, @o_gender = p.gender,
            @o_ref_doctor = p.ref_doctor, @o_ref_doctor_other = p.ref_doctor_other,
            @o_ref_customer = p.ref_customer, @o_ref_customer_other = p.ref_customer_other,
            @o_mobile = p.mobile_number, @o_email = p.email, @o_sample_time = p.sample_time
        FROM dbo.tbl_med_mcc_patient_master p WITH (UPDLOCK, HOLDLOCK)
        WHERE p.id = @pid;

        -- Empty string clears; NULL leaves alone. NULLIF turns the former into
        -- a real NULL for the nullable text columns.
        UPDATE dbo.tbl_med_mcc_patient_master
        SET initial            = COALESCE(NULLIF(@title, ''), initial),
            name               = COALESCE(NULLIF(@name, ''), name),
            age                = COALESCE(@age, age),
            age_type           = COALESCE(@age_type, age_type),
            gender             = COALESCE(@gender, gender),
            -- 0 is the UI's "no master row selected", which pairs with a
            -- free-text value in the _other column.
            ref_doctor         = CASE WHEN @ref_doctor IS NULL THEN ref_doctor
                                      WHEN @ref_doctor = 0     THEN NULL
                                      ELSE @ref_doctor END,
            ref_doctor_other   = CASE WHEN @ref_doctor_other IS NULL THEN ref_doctor_other
                                      ELSE NULLIF(@ref_doctor_other, '') END,
            ref_customer       = CASE WHEN @ref_customer IS NULL THEN ref_customer
                                      WHEN @ref_customer = 0     THEN NULL
                                      ELSE @ref_customer END,
            ref_customer_other = CASE WHEN @ref_customer_other IS NULL THEN ref_customer_other
                                      ELSE NULLIF(@ref_customer_other, '') END,
            mobile_number      = CASE WHEN @mobile IS NULL THEN mobile_number
                                      ELSE NULLIF(@mobile, '') END,
            email              = CASE WHEN @email IS NULL THEN email
                                      ELSE NULLIF(@email, '') END,
            sample_time        = COALESCE(@sample_time, sample_time),
            -- sample_date carries the date at midnight and sample_time the full
            -- stamp; Listec's own edit screen writes both from one control, so
            -- keep them in step or its header starts disagreeing with ours.
            sample_date        = CASE WHEN @sample_time IS NULL THEN sample_date
                                      ELSE CAST(CAST(@sample_time AS DATE) AS DATETIME) END,
            updatedby          = @origin,
            updateddate        = GETDATE()
        WHERE id = @pid;

        -- Clinical history lives on the SAMPLE, not the patient — Listec's edit
        -- screen presents them together but they are different rows.
        IF @clinical_history IS NOT NULL
        BEGIN
            DECLARE @o_hist NVARCHAR(MAX);
            SELECT @o_hist = Sample_ClinicalHistory
            FROM dbo.tbl_med_mcc_patient_samples WHERE id = @sample_id;

            IF ISNULL(@o_hist, N'') <> @clinical_history
            BEGIN
                UPDATE dbo.tbl_med_mcc_patient_samples
                SET Sample_ClinicalHistory = NULLIF(@clinical_history, N'')
                WHERE id = @sample_id;

                INSERT INTO dbo.inf_result_audit
                    (vailid, patient_id, action, field, old_value, new_value,
                     actor_user_id, actor_username, source, origin)
                VALUES
                    (@sid, @pid, 'patient_edit', 'clinical_history',
                     @o_hist, NULLIF(@clinical_history, N''),
                     @userId, @username, 'ui', @origin);

                SET @changed += 1;
            END
        END

        -- One audit row per column that actually moved. Built as a single
        -- INSERT..SELECT over a VALUES list rather than a dozen IF blocks: the
        -- comparison and the insert then cannot drift apart, which is exactly
        -- the bug an audit trail must not have.
        INSERT INTO dbo.inf_result_audit
            (vailid, patient_id, action, field, old_value, new_value,
             actor_user_id, actor_username, source, origin)
        SELECT @sid, @pid, 'patient_edit', v.field, v.old_value, v.new_value,
               @userId, @username, 'ui', @origin
        FROM (VALUES
            ('title',        CONVERT(NVARCHAR(MAX), @o_title),
                             CONVERT(NVARCHAR(MAX), NULLIF(@title, ''))),
            ('name',         CONVERT(NVARCHAR(MAX), @o_name),
                             CONVERT(NVARCHAR(MAX), NULLIF(@name, ''))),
            ('age',          CONVERT(NVARCHAR(MAX), @o_age),
                             CONVERT(NVARCHAR(MAX), @age)),
            ('age_type',     CONVERT(NVARCHAR(MAX), @o_age_type),
                             CONVERT(NVARCHAR(MAX), @age_type)),
            ('sex',          CONVERT(NVARCHAR(MAX), @o_gender),
                             CONVERT(NVARCHAR(MAX), @gender)),
            ('ref_doctor',   CONVERT(NVARCHAR(MAX), @o_ref_doctor),
                             CONVERT(NVARCHAR(MAX), NULLIF(@ref_doctor, 0))),
            ('ref_doctor_other',   CONVERT(NVARCHAR(MAX), @o_ref_doctor_other),
                             CONVERT(NVARCHAR(MAX), NULLIF(@ref_doctor_other, ''))),
            ('ref_customer', CONVERT(NVARCHAR(MAX), @o_ref_customer),
                             CONVERT(NVARCHAR(MAX), NULLIF(@ref_customer, 0))),
            ('ref_customer_other', CONVERT(NVARCHAR(MAX), @o_ref_customer_other),
                             CONVERT(NVARCHAR(MAX), NULLIF(@ref_customer_other, ''))),
            ('mobile',       CONVERT(NVARCHAR(MAX), @o_mobile),
                             CONVERT(NVARCHAR(MAX), NULLIF(@mobile, ''))),
            ('email',        CONVERT(NVARCHAR(MAX), @o_email),
                             CONVERT(NVARCHAR(MAX), NULLIF(@email, ''))),
            ('sample_time',  CONVERT(NVARCHAR(MAX), @o_sample_time, 126),
                             CONVERT(NVARCHAR(MAX), @sample_time, 126))
        ) AS v(field, old_value, new_value)
        -- Only where a new value was actually supplied AND differs. The second
        -- half is what stops a form that posts every field from writing twelve
        -- audit rows every time someone fixes one spelling.
        WHERE v.new_value IS NOT NULL
          AND ISNULL(v.old_value, N'') <> v.new_value;

        SET @changed += @@ROWCOUNT;

        COMMIT;

        SELECT ok = CAST(1 AS BIT), error_code = CAST(NULL AS VARCHAR(20)), changed = @changed;
    END TRY
    BEGIN CATCH
        IF @@TRANCOUNT > 0 ROLLBACK;
        THROW;
    END CATCH
END
GO

PRINT 'usp_inf_update_patient_info created.';
GO
