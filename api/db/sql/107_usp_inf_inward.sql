/*
 * 107_usp_inf_inward.sql
 *
 * F1 — sample transit / inward tracking (legacy Worksheet/Inward.aspx, menu 55
 * "Sample Tracking"). Contract: docs/contracts/f1-inward-contract.md; data
 * findings: docs/contracts/f1-inward-schema.md. Requires 105 (indexes) and 106
 * (audit vocabulary).
 *
 * ── THE DATA MODEL, KEPT EXACTLY (contract KEEP #1) ─────────────────────────
 * One row per (vailid, business unit) leg. A vial couriered branch → hub gets
 * one row per unit that scans it. Within a unit, the 2nd–4th scans fill
 * received_one/two/three by strict null-cascade; the 5th and later scans
 * change nothing on the row — but unlike the legacy page, the scan procedure
 * SAYS so ('already_full', contract quirk 2) instead of staying silent.
 *
 * What is deliberately fixed against the legacy code (each a contract FIX):
 *   - vailid is trimmed of spaces, tabs and CR/LF on insert AND lookup (#7 —
 *     untrimmed inserts produced 100-row pile-ups invisible to every query);
 *   - scan_by stores the PLAIN username (#6 — not "USER- Scan DT:date"; the
 *     date half was 100% redundant and the composite was a varchar(50)
 *     truncation bomb). The list still parses legacy composites for display;
 *   - slno keeps its per-unit per-day 1..N meaning but is computed under
 *     UPDLOCK/HOLDLOCK inside the transaction (#8 — no count-then-insert race,
 *     no .AddSeconds(0.1) hole, no Thread.Sleep(1000));
 *   - the business_unit_id overwrite on the sample is kept (it IS the transit
 *     pointer) but audited with actor, ip, old and new unit (#4 / quirk 21:
 *     tracking row + overwrite + audit commit in ONE transaction).
 *
 * What is deliberately NOT here: the auto-accession at head office. That chain
 * (billing debit, result skeletons, status 1→2) already exists in Infinity as
 * usp_telo_accession_samples behind AccessionRepository.AccessionAsync, with
 * its own charge-once latch. The API calls it AFTER this procedure commits,
 * when the scanner's unit is HO and the sample was status 1. A failure between
 * the two leaves "arrived, not registered" — coherent and retryable — instead
 * of the legacy half-accessioned states (quirk 21).
 */
SET QUOTED_IDENTIFIER ON;
GO

/* ---- the grid -------------------------------------------------------------
 *
 * Filters:
 *   @actor_user_id resolves legacy business-unit scope server-side: head
 *                  office sees all units; branch users see only their unit
 *   @client_codes  caller's client scope (empty TVP = no filter, as everywhere
 *                  else; the endpoint short-circuits denied users first)
 *   @from/@to      INCLUSIVE day bounds (FIX #14 — the legacy window ran
 *                  00:00:01–23:59:59, half-excluding both edge seconds)
 *   @sid           exact trimmed SID; when present the DATES ARE IGNORED
 *                  (FIX #14 — legacy ANDed them, so searching an old SID with
 *                  today's default dates found nothing)
 *   @mcc_id        one client, narrows within scope
 *   @bunit         one business unit code
 *
 * The patient/sample join goes through the TRIMMED vailid at read time —
 * Role B: stored patient_id is a never-healed snapshot, wrong or missing for
 * ~10% of rows, and 3.6% of vailids carry literal tabs/spaces. LEFT joins so
 * orphan (no-workorder) rows survive for unscoped lab users (FIX #13). For
 * client-scoped callers the scope EXISTS necessarily drops orphans — they have
 * no client to match — which is accepted and recorded in the build remainder.
 *
 * NULL gender comes back NULL, not 'F' (FIX #12). Ordered by scan_datetime
 * DESC (FIX #15 — legacy ordered by slno, interleaving unrelated days/units),
 * id DESC as the deterministic tiebreak. Checkpoint columns return usernames
 * AND datetimes (FIX #11 — legacy fetched the datetimes and never showed them,
 * under three columns all captioned "Received1").
 */
CREATE OR ALTER PROCEDURE dbo.usp_inf_inward_list
    @actor_user_id INT,
    -- TRUE only when the caller sees every centre BY ROLE (admin, lab manager,
    -- reporting). Distinct from "no codes": lab staff also arrive with none,
    -- and their scope is the business unit below. See the guard at @scopeless.
    @unrestricted BIT = 0,
    @client_codes dbo.ClientCodeList READONLY,
    @from_date    DATE,
    @to_date      DATE,
    @sid          NVARCHAR(50) = NULL,
    @mcc_id       INT          = NULL,
    @bunit        VARCHAR(50)  = NULL,
    @max_rows     INT          = 500
AS
BEGIN
    SET NOCOUNT ON;
    -- A read of a live table the LIS is writing to; a worklist tolerates a
    -- dirty read better than it tolerates blocking the scanners.
    SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;

    DECLARE @cap INT =
        CASE WHEN @max_rows < 1 THEN 500
             WHEN @max_rows > 10000 THEN 10000   -- the CSV export's ceiling
             ELSE @max_rows END;

    -- Inclusive day bounds: >= from 00:00, < (to + 1 day).
    DECLARE @from DATETIME = CAST(@from_date AS DATETIME);
    DECLARE @to   DATETIME = DATEADD(DAY, 1, CAST(@to_date AS DATETIME));

    -- The SID is cleaned the same way scans are stored: spaces, tabs, CR/LF.
    DECLARE @sidClean VARCHAR(50) = NULLIF(LTRIM(RTRIM(
        REPLACE(REPLACE(REPLACE(ISNULL(@sid, ''), CHAR(9), ''), CHAR(13), ''), CHAR(10), ''))), '');
    DECLARE @bunitClean VARCHAR(50) = NULLIF(LTRIM(RTRIM(ISNULL(@bunit, ''))), '');

    -- Preserve the legacy list scope without trusting a caller-supplied unit:
    -- users assigned to a branch (Business_Unit_id > 1) are locked to that
    -- branch; head office/unassigned users may view all units or narrow with
    -- the optional filter. A broken branch assignment fails closed.
    DECLARE @actorBuId INT, @actorBunit VARCHAR(50);
    SELECT
        @actorBuId = u.Business_Unit_id,
        @actorBunit = NULLIF(LTRIM(RTRIM(b.BusinessUnitCode)), '')
    FROM dbo.tbl_med_user_master u
    LEFT JOIN dbo.tbl_med_business_unit_master b ON b.id = u.Business_Unit_id
    WHERE u.id = @actor_user_id;

    IF @actorBuId > 1
        SET @bunitClean = COALESCE(@actorBunit, '__INVALID_BUSINESS_UNIT__');

    DECLARE @codeCount INT = (SELECT COUNT(*) FROM @client_codes);

    /* The scope guard (D9).
     *
     * Three ways to be legitimately scoped here:
     *   - @unrestricted = 1  — every centre, by role;
     *   - @codeCount > 0     — a client-code scope, narrowed further by the
     *                          unit lock above if the caller has a branch;
     *   - a usable business unit — lab staff, who hold no client mappings by
     *                          design. HO (id 1) sees every unit exactly as the
     *                          legacy page did; a branch is locked above.
     *
     * A caller matching NONE of these has no scope at all, and an empty TVP
     * means "no client filter" — so without this they would see the whole lab.
     * Fail closed instead: an impossible unit yields nothing.
     */
    DECLARE @scopeless BIT =
        CASE WHEN @unrestricted = 0 AND @codeCount = 0 AND ISNULL(@actorBuId, 0) < 1
             THEN 1 ELSE 0 END;

    IF @scopeless = 1
        SET @bunitClean = '__NO_SCOPE__';

    SELECT TOP (@cap)
        t.id,
        t.slno,
        -- The cleaned SID is what the operator scans and searches; the raw
        -- value is kept alongside so a whitespace-damaged legacy row is
        -- recognisable as such rather than invisibly "the same".
        sid            = v.vail_clean,
        sid_raw        = t.vailid,
        scanned_at     = t.scan_datetime,
        -- Legacy rows store "USER- Scan DT:date"; Infinity rows store the bare
        -- username. Display the base name either way (FIX #6, reader half).
        scanned_by     = CASE WHEN CHARINDEX('- Scan DT:', t.scan_by) > 1
                              THEN LEFT(t.scan_by, CHARINDEX('- Scan DT:', t.scan_by) - 1)
                              ELSE t.scan_by END,
        bunit          = t.bunit,
        received_one       = t.received_one,
        received_one_at    = t.received_one_datetime,
        received_two       = t.received_two,
        received_two_at    = t.received_two_datetime,
        received_three     = t.received_three,
        received_three_at  = t.received_three_datetime,
        patient_id     = P.id,
        patient_name   = P.name,
        -- Raw code; NULL stays NULL. The 1='M' mapping happens at the API so
        -- an unknown sex renders as absence, never as 'F' (FIX #12).
        gender         = P.gender,
        client_code    = U.MCCUnitCode,
        tests          = S.testnames,
        sample_status  = S.sample_status,
        total_count    = COUNT(*) OVER()
    FROM dbo.tbl_acc_inward_sample_tracking t
    CROSS APPLY (SELECT vail_clean = LTRIM(RTRIM(
        REPLACE(REPLACE(REPLACE(t.vailid, CHAR(9), ''), CHAR(13), ''), CHAR(10), '')))) v
    -- TOP 1 by id: barcodes are globally unique in Noble, but this is a legacy
    -- table being defended against, not trusted.
    OUTER APPLY (
        SELECT TOP 1 s.patient_id, s.testnames, s.sample_status
        FROM dbo.tbl_med_mcc_patient_samples s
        WHERE s.vailid = v.vail_clean
        ORDER BY s.id
    ) S
    LEFT JOIN dbo.tbl_med_mcc_patient_master P ON P.id = S.patient_id
    LEFT JOIN dbo.tbl_med_mcc_unit_master U ON U.id = P.mcc_code
    WHERE
        (
            -- Exact SID: the dates are ignored (FIX #14). The clean-side match
            -- also reaches whitespace-damaged legacy rows; this branch scans
            -- the table, which for an occasional single-SID lookup on 233k
            -- rows is an accepted cost.
            (@sidClean IS NOT NULL AND v.vail_clean = @sidClean)
         OR (@sidClean IS NULL AND t.scan_datetime >= @from AND t.scan_datetime < @to)
        )
      AND (@bunitClean IS NULL OR t.bunit = @bunitClean)
      -- Narrows WITHIN the scope filter below, never instead of it.
      AND (@mcc_id IS NULL OR U.id = @mcc_id)
      AND (@codeCount = 0
           OR EXISTS (SELECT 1 FROM @client_codes c WHERE c.code = U.MCCUnitCode))
    ORDER BY t.scan_datetime DESC, t.id DESC
    -- Two very different shapes share this procedure — a one-day window and a
    -- dateless SID hunt — and neither should run the other's plan.
    OPTION (RECOMPILE);
END
GO

/* ---- the scan -------------------------------------------------------------
 *
 * One transaction: leg upsert + sample business-unit overwrite + audit row.
 *
 * Outcomes (single result row, column `outcome`):
 *   new_leg       first scan of this vial at this unit — row inserted
 *   checkpoint_1  2nd scan at this unit — received_one filled
 *   checkpoint_2  3rd — received_two
 *   checkpoint_3  4th — received_three
 *   already_full  5th+ — tracking row untouched, said out loud (quirk 2);
 *                 the business-unit overwrite still runs, as in the legacy
 *
 * `no_workorder` rides alongside every outcome: a vial with no matching sample
 * is still LOGGED (KEEP #3 — the vial physically arrived; losing the scan
 * because registration lags would be data loss), and the API paints it red.
 *
 * Concurrency:
 *   - the (vailid, bunit) lookup takes UPDLOCK+HOLDLOCK — via IX_inf_inward_
 *     vailid that is a key-range lock on this one vailid, so two guns racing
 *     the same barcode serialize: the second sees the first's row and becomes
 *     checkpoint_1 instead of a duplicate leg (the legacy dedup was a
 *     Thread.Sleep(1000), which Role B showed produced 434 same-unit duplicate
 *     pairs in 90 days);
 *   - slno = MAX+1 over today's unit rows under the same lock discipline, so
 *     the per-unit per-day 1..N tally holds under simultaneous scanners.
 *
 * Legacy rows with whitespace-damaged vailids: the exact lookup cannot see
 * them (that blindness is precisely how one tabbed barcode collected 100 rows
 * in 2m12s). A bounded fallback re-checks the last 60 days at this unit
 * trim-insensitively — any hit is re-locked BY ID so the range lock stays
 * narrow. Older dirty rows simply get a fresh clean leg, which is no worse
 * than what the legacy page did on every scan.
 */
CREATE OR ALTER PROCEDURE dbo.usp_inf_inward_scan
    @vailid        NVARCHAR(50),
    @actor_user_id INT,
    @actor_ip      VARCHAR(64) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    -- Trim spaces, tabs and scanner-terminator CR/LF on the way in (FIX #7).
    -- varchar deliberately: the tracking column is varchar(50), and a varchar
    -- comparand is what keeps the vailid index seekable.
    DECLARE @vail VARCHAR(50) = LTRIM(RTRIM(
        REPLACE(REPLACE(REPLACE(ISNULL(@vailid, N''), CHAR(9), ''), CHAR(13), ''), CHAR(10), '')));

    IF @vail = ''
    BEGIN
        RAISERROR('A Sample ID is required.', 16, 1);
        RETURN;
    END

    DECLARE @actor_username NVARCHAR(50) =
        (SELECT Username FROM dbo.tbl_med_user_master WHERE id = @actor_user_id);
    IF @actor_username IS NULL
    BEGIN
        RAISERROR('Unknown acting user.', 16, 1);
        RETURN;
    END

    -- The scanner's own unit is what the leg is filed under. The legacy page
    -- NRE'd on a user with no business unit; this says so instead.
    DECLARE @bu_id INT =
        (SELECT Business_Unit_id FROM dbo.tbl_med_user_master WHERE id = @actor_user_id);
    DECLARE @bunit VARCHAR(50) =
        (SELECT BusinessUnitCode FROM dbo.tbl_med_business_unit_master WHERE id = @bu_id);
    IF @bunit IS NULL OR LTRIM(RTRIM(@bunit)) = ''
    BEGIN
        RAISERROR('Your account has no business unit, and an inward scan is filed under one. Ask an administrator to set it.', 16, 1);
        RETURN;
    END
    SET @bunit = LTRIM(RTRIM(@bunit));

    -- The sample, if a workorder exists. These values are populated under the
    -- transaction below so concurrent scans at different units cannot both
    -- audit the same stale old business unit or act on a stale sample status.
    DECLARE @vailN NVARCHAR(50) = @vail;
    DECLARE @sample_id INT, @patient_id INT, @sample_status INT, @old_bu_id INT,
            @tests NVARCHAR(MAX), @patient_name NVARCHAR(200), @gender INT;

    DECLARE @outcome VARCHAR(20), @row_id INT, @slno INT,
            @r1 VARCHAR(50), @r2 VARCHAR(50), @r3 VARCHAR(50);
    DECLARE @old_bunit VARCHAR(50);

    BEGIN TRY
        BEGIN TRANSACTION;

        -- Lock the sample first and derive every response/audit decision from
        -- that locked snapshot. Different-unit scans use different tracking
        -- keys, so the sample row is the common serialization point.
        SELECT TOP 1
            @sample_id = s.id,
            @patient_id = s.patient_id,
            @sample_status = s.sample_status,
            @old_bu_id = s.business_unit_id,
            @tests = s.testnames
        FROM dbo.tbl_med_mcc_patient_samples s WITH (UPDLOCK, HOLDLOCK)
        WHERE s.vailid = @vailN
        ORDER BY s.id;

        IF @patient_id IS NOT NULL
            SELECT @patient_name = p.name, @gender = p.gender
            FROM dbo.tbl_med_mcc_patient_master p
            WHERE p.id = @patient_id;

        SELECT @old_bunit = BusinessUnitCode
        FROM dbo.tbl_med_business_unit_master
        WHERE id = @old_bu_id;

        -- The leg lookup, locked. Range lock on this vailid via the 105 index.
        SELECT TOP 1
            @row_id = t.id, @slno = t.slno,
            @r1 = t.received_one, @r2 = t.received_two, @r3 = t.received_three
        FROM dbo.tbl_acc_inward_sample_tracking t WITH (UPDLOCK, HOLDLOCK)
        WHERE t.vailid = @vail AND t.bunit = @bunit
        ORDER BY t.id;

        -- Whitespace-damaged legacy row? Unlocked probe first (bounded to the
        -- recent window this unit could plausibly still be receiving), then
        -- re-lock the specific row by id so no wide range lock is held.
        IF @row_id IS NULL
        BEGIN
            SELECT TOP 1 @row_id = t.id
            FROM dbo.tbl_acc_inward_sample_tracking t
            WHERE t.bunit = @bunit
              AND t.scan_datetime >= DATEADD(DAY, -60, GETDATE())
              AND t.vailid <> @vail
              AND LTRIM(RTRIM(REPLACE(REPLACE(REPLACE(
                      t.vailid, CHAR(9), ''), CHAR(13), ''), CHAR(10), ''))) = @vail
            ORDER BY t.id;

            IF @row_id IS NOT NULL
                SELECT @slno = t.slno,
                       @r1 = t.received_one, @r2 = t.received_two, @r3 = t.received_three
                FROM dbo.tbl_acc_inward_sample_tracking t WITH (UPDLOCK, HOLDLOCK)
                WHERE t.id = @row_id;
        END

        IF @row_id IS NULL
        BEGIN
            -- New leg. slno: per-unit per-day 1..N (KEEP the meaning — the
            -- operators read it as today's tally), computed race-safely under
            -- the transaction (FIX #8). Midnight bound, not 00:00:00.1.
            DECLARE @day_start DATETIME = CAST(CAST(GETDATE() AS DATE) AS DATETIME);
            DECLARE @day_end   DATETIME = DATEADD(DAY, 1, @day_start);

            SELECT @slno = ISNULL(MAX(t.slno), 0) + 1
            FROM dbo.tbl_acc_inward_sample_tracking t WITH (
                UPDLOCK, HOLDLOCK, INDEX(IX_inf_inward_bunit_scan_datetime))
            WHERE t.bunit = @bunit
              AND t.scan_datetime >= @day_start
              AND t.scan_datetime < @day_end;

            INSERT INTO dbo.tbl_acc_inward_sample_tracking
                (vailid, patient_id, scan_datetime, scan_by, bunit, slno)
            VALUES
                -- patient_id is the legacy snapshot semantics, kept: filled if
                -- the workorder exists NOW, never healed later. Readers join
                -- through vailid and must not trust it (Role B directive 5).
                (@vail, @patient_id, GETDATE(), @actor_username, @bunit, @slno);

            SET @outcome = 'new_leg';
        END
        ELSE IF @r1 IS NULL
        BEGIN
            UPDATE dbo.tbl_acc_inward_sample_tracking
            SET received_one = @actor_username, received_one_datetime = GETDATE()
            WHERE id = @row_id;
            SET @outcome = 'checkpoint_1';
        END
        ELSE IF @r2 IS NULL
        BEGIN
            UPDATE dbo.tbl_acc_inward_sample_tracking
            SET received_two = @actor_username, received_two_datetime = GETDATE()
            WHERE id = @row_id;
            SET @outcome = 'checkpoint_2';
        END
        ELSE IF @r3 IS NULL
        BEGIN
            UPDATE dbo.tbl_acc_inward_sample_tracking
            SET received_three = @actor_username, received_three_datetime = GETDATE()
            WHERE id = @row_id;
            SET @outcome = 'checkpoint_3';
        END
        ELSE
            -- The 4-scan ceiling. No fourth slot is invented (KEEP #1/#2);
            -- the caller is TOLD instead of the legacy silence.
            SET @outcome = 'already_full';

        -- The transit pointer: every scan re-points the sample at the scanning
        -- unit (KEEP #4 — the last scanning unit owns the sample), audited
        -- when it actually moves. modifieddate matches the legacy write;
        -- modifiedby is deliberately left alone as the legacy does — the LIS
        -- shows it as "who accessioned this" and the audit row carries the
        -- actor.
        IF @sample_id IS NOT NULL
        BEGIN
            UPDATE dbo.tbl_med_mcc_patient_samples
            SET business_unit_id = @bu_id,
                modifieddate = GETDATE()
            WHERE id = @sample_id;

            IF ISNULL(@old_bu_id, -1) <> @bu_id
                INSERT INTO dbo.inf_result_audit
                    (vailid, patient_id, action, field, old_value, new_value, reason,
                     actor_user_id, actor_username, actor_ip, source, origin)
                VALUES
                    (@vailN, @patient_id, 'inward', 'business_unit',
                     ISNULL(@old_bunit, CASE WHEN @old_bu_id IS NULL THEN NULL
                                             ELSE CONVERT(NVARCHAR(20), @old_bu_id) END),
                     @bunit,
                     CONCAT(N'inward scan (', @outcome, N')'),
                     @actor_user_id, @actor_username, @actor_ip, 'ui',
                     'inf:' + CONVERT(VARCHAR(20), @actor_user_id));
        END

        COMMIT TRANSACTION;
    END TRY
    BEGIN CATCH
        IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
        THROW;
    END CATCH

    SELECT
        outcome                  = @outcome,
        no_workorder             = CASE WHEN @sample_id IS NULL THEN 1 ELSE 0 END,
        slno                     = @slno,
        patient_id               = @patient_id,
        patient_name             = @patient_name,
        -- Raw; NULL means unknown and must never render as 'F' (FIX #12).
        gender                   = @gender,
        -- The status BEFORE any accession the API may now trigger.
        sample_status            = @sample_status,
        tests                    = @tests,
        old_business_unit        = @old_bunit,
        scanner_business_unit_id = @bu_id,
        scanner_business_unit    = @bunit;
END
GO
