/*
 * 151_custom_lines_reach_the_client_account.sql
 *
 * A custom line — the Smart Report, Medicare's external glucose and blood
 * gas — was billed but never reached the referring centre's account. The
 * account is charged at accessioning, per LIS test row on the sample, and
 * a custom line has neither a test row nor a sample; a custom-only order is
 * never accessioned at all. Found 2026-09-21: three booklets and 108
 * Medicare lines (₹31,117) billed with no account movement.
 *
 * Three parts, in order:
 *   1. telo_custom_line_charge — the charge-once latch.
 *   2. usp_telo_charge_custom_lines — posts a patient's uncharged lines to
 *      the account exactly as accessioning posts a test.
 *   3. The two shared procedures, full bodies from Telo's 60_/65_-style
 *      sources (68_ and 60_), each with one call added: accessioning
 *      charges the patient's extras when any sample is first registered
 *      (④b); placement charges them at once for a custom-only order (⑤c).
 *
 * Telo's copies carry the same change (its 115_ script and its 68_/60_).
 * Historical lines are NOT charged by this script; see
 * api/db/data/custom-line-charge-backfill-20260921.sql.
 */
SET QUOTED_IDENTIFIER ON;
SET ANSI_NULLS ON;
GO
/*
 * The charge-once latch for custom lines. Keyed on (bill, custom test) rather
 * than on the custom order row: usp_telo_edit_bill_tests deletes and
 * re-inserts those rows on every bill edit, so a latch on them would be
 * lost — and the line charged again — the first time a clerk corrected a
 * name. A bill edit that changes a line's quantity after it was charged is
 * not re-priced here; that is a manual adjustment, as it is for tests.
 */
IF OBJECT_ID('dbo.telo_custom_line_charge') IS NULL
BEGIN
    CREATE TABLE dbo.telo_custom_line_charge (
        bill_id        INT           NOT NULL,
        custom_test_id INT           NOT NULL,
        code           NVARCHAR(50)  NULL,
        amount         INT           NOT NULL,
        mccid          INT           NOT NULL,     -- the ACCOUNT charged (parent, for a sub-franchise)
        txn_id         INT           NULL,         -- tbl_med_mcc_test_transactions.id
        charged_at     DATETIME      NOT NULL CONSTRAINT DF_telo_custom_line_charge_at DEFAULT (GETDATE()),
        charged_by     NVARCHAR(100) NULL,
        CONSTRAINT PK_telo_custom_line_charge PRIMARY KEY (bill_id, custom_test_id)
    );
    PRINT 'Created dbo.telo_custom_line_charge.';
END
GO

/*
 * usp_telo_charge_custom_lines — charge a patient's billed-but-unperformed
 * extras (the Smart Report, an external glucose) to the referring centre's
 * account, once each, exactly the way usp_telo_accession_samples charges a
 * test: the same sub-franchise rule for WHICH account, the same
 * sp_mcc_test_account_101 row in tbl_med_mcc_test_transactions, the same
 * running-balance update on tbl_med_mcc_account_master. What differs is
 * the amount — a custom line has one price, the one on the order — and the
 * latch, which is telo_custom_line_charge rather than amount_checked.
 *
 * Called from usp_telo_accession_samples (④b) when any of the patient's
 * samples is first registered, and from usp_telo_create_order (⑤c) at
 * placement for a custom-only order, which has nothing to register.
 * Idempotent: a line already in the latch is skipped. Runs inside the
 * caller's transaction. Emits no result set.
 */
CREATE OR ALTER PROCEDURE dbo.usp_telo_charge_custom_lines
    @userId       INT,
    @patientId    INT,
    @origin       NVARCHAR(20) = N'telo:',
    @charged      INT = 0 OUTPUT,
    @charge_total INT = 0 OUTPUT
AS
BEGIN
    SET NOCOUNT ON;
    SET @charged = 0; SET @charge_total = 0;

    DECLARE @lines TABLE (seq INT IDENTITY(1,1) PRIMARY KEY, bill_id INT, custom_test_id INT,
                          code NVARCHAR(50), tname NVARCHAR(100), amount INT);
    INSERT INTO @lines (bill_id, custom_test_id, code, tname, amount)
    SELECT c.bill_id, c.custom_test_id, c.code,
           LEFT(CASE WHEN c.qty > 1 THEN CONCAT(c.name, N' x', c.qty) ELSE c.name END, 100),
           c.unit_amount * c.qty
    FROM dbo.telo_custom_test_order c
    WHERE c.patient_id = @patientId AND c.bill_id > 0 AND c.unit_amount * c.qty > 0
      AND NOT EXISTS (SELECT 1 FROM dbo.telo_custom_line_charge l
                      WHERE l.bill_id = c.bill_id AND l.custom_test_id = c.custom_test_id)
    ORDER BY c.id;
    IF NOT EXISTS (SELECT 1 FROM @lines) RETURN;

    /* Which account: the parent's when a user maps this centre as its
       sub_pcc (LIS: mccAccount keyed on objSubFrUserMaster.PCC_Id), with the
       child's code recorded on the row. Same rule as accessioning. */
    DECLARE @mcc INT, @acctMcc INT, @sub NVARCHAR(50), @patName NVARCHAR(50);
    SELECT @mcc = p.mcc_code, @patName = LEFT(ISNULL(p.name, N''), 49)
    FROM dbo.tbl_med_mcc_patient_master p WHERE p.id = @patientId;
    IF @mcc IS NULL RETURN;
    SELECT TOP 1
           @acctMcc = ISNULL(su.PCC_Id, @mcc),
           @sub = CASE WHEN su.PCC_Id IS NULL THEN N'' ELSE LEFT(ISNULL(cu.MCCUnitCode, N''), 50) END
    FROM (SELECT 1 AS x) d
    OUTER APPLY (SELECT TOP 1 u.PCC_Id FROM dbo.tbl_med_user_master u
                 WHERE u.sub_pcc_id = @mcc AND u.PCC_Id IS NOT NULL ORDER BY u.id) su
    LEFT JOIN dbo.tbl_med_mcc_unit_master cu ON cu.id = @mcc;

    IF NOT EXISTS (SELECT 1 FROM dbo.tbl_med_mcc_account_master WHERE mcccode = @acctMcc)
        INSERT INTO dbo.tbl_med_mcc_account_master (mcccode, currentbalance, totaldeposited)
        VALUES (@acctMcc, 0, 0);

    DECLARE @i INT = 1, @n INT = (SELECT COUNT(*) FROM @lines);
    DECLARE @billId INT, @ctId INT, @code NVARCHAR(50), @tname NVARCHAR(100), @amt INT,
            @bal INT, @closing INT, @now DATETIME, @txn INT;
    WHILE @i <= @n
    BEGIN
        SELECT @billId = bill_id, @ctId = custom_test_id, @code = code, @tname = tname, @amt = amount
        FROM @lines WHERE seq = @i;

        /* Re-assert the latch inside the loop: two registrations of the same
           visit in the same second must still charge once. */
        IF NOT EXISTS (SELECT 1 FROM dbo.telo_custom_line_charge
                       WHERE bill_id = @billId AND custom_test_id = @ctId)
        BEGIN
            SELECT @bal = ISNULL(currentbalance, 0)
            FROM dbo.tbl_med_mcc_account_master WHERE mcccode = @acctMcc;
            SET @now = GETDATE();
            SET @closing = @bal - @amt;

            EXEC dbo.sp_mcc_test_account_101
                 @USERID = @userId, @MCCID = @acctMcc, @TDATE = @now,
                 @CBALANCE = @bal, @TESTCHARGES = @amt,
                 @CLOSINGBALANCE = @closing,
                 @tname = @tname,
                 @vailid = @patName,        -- LIS stores the PATIENT NAME here
                 @patientid = @patientId, @SUBFRANCHISE = @sub;

            /* The row the LIS procedure just wrote — it returns nothing, and
               SCOPE_IDENTITY does not cross a procedure boundary. Same
               transaction, so the latest row for this account + patient +
               moment is ours. */
            SELECT @txn = MAX(id) FROM dbo.tbl_med_mcc_test_transactions
            WHERE mccid = @acctMcc AND patientid = @patientId AND transdate = @now;

            UPDATE dbo.tbl_med_mcc_account_master
            SET currentbalance = @closing
            WHERE mcccode = @acctMcc;

            INSERT INTO dbo.telo_custom_line_charge
                (bill_id, custom_test_id, code, amount, mccid, txn_id, charged_at, charged_by)
            VALUES (@billId, @ctId, @code, @amt, @acctMcc, @txn, @now, CONCAT(@origin, @userId));

            SET @charged += 1;
            SET @charge_total += @amt;
        END
        SET @i += 1;
    END
END
GO

/*
 * 67_usp_telo_accession_samples.sql — Telo-side "Register" (accessioning).
 *
 * A faithful T-SQL port of the LIS Accession screen's Register action:
 *   MedCis.UI/Worksheet/Accession.aspx.cs      btnSave_Click  (chkRegister)
 *   MedCis.Business/Pcc/WorksheetClass.cs      GetTestsBySampleId
 *                                              LoadTestByVailId
 *                                              LoadProfileTestsByVailId
 *                                              GetTestNormalRanges / GetTestUnits
 *                                              UpdateSampleStatus
 *
 * WHAT REGISTER DOES (per SID), in the LIS's own order:
 *   ① If the SID has NO result rows yet, build the "empty result skeleton" by
 *      walking the sample's testtypes/testcodes CSVs POSITIONALLY:
 *        'p' | 'mp' -> profile expansion   (Profile head + Head/Param/Test rows)
 *        't' | 'mt' -> single test         (Head + Param rows, or one Test row)
 *      Normal ranges and units are resolved PER PATIENT (age band + gender).
 *   ② Flip the sample to sample_status = 2 ('Sample Registered'), stamp
 *      modifiedby/modifieddate, set the patient master Status = 2, and derive
 *      report_type from the generated test names.
 * Only then does the sample clear the worksheet SP's `sample_status > 1` gate.
 *
 * DELIBERATE FIDELITY NOTES (these mirror LIS quirks — do not "fix" them):
 *  - `mobile_number` on a result row holds GET_SAMPLE_VALUE (a machine default
 *    value), NOT a phone number. The LIS overloads the column; the report
 *    reader depends on it.
 *  - A parameter row's `testid` is the PARAM's `TestCode` column, which is the
 *    parent test master's id (not a test code string).
 *  - 'Head'/'Profile' rows carry auth = 1; real result rows carry auth = 0.
 *  - Head rows have testcode = '' (empty string, not NULL).
 *  - Units are taken from the FIRST normal-range row with a non-empty unit,
 *    ignoring age/gender — unlike the range itself.
 *
 * Idempotent per SID: a SID that already has result rows keeps them (the LIS
 * short-circuits the same way), and a SID not at status 1 is skipped.
 *
 * Returns: status row { ok, error_code, message, registered, skipped }
 *          detail rows { vailid, outcome, result_rows }
 */
CREATE OR ALTER PROCEDURE dbo.usp_telo_accession_samples
    @userId  INT,
    @user    NVARCHAR(50),      -- LIS username, stamped into modifiedby
    @vailids dbo.TeloVailidList READONLY
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE @out TABLE (
        vailid NVARCHAR(50), outcome VARCHAR(20), result_rows INT
    );

    IF NOT EXISTS (SELECT 1 FROM @vailids)
    BEGIN
        SELECT ok = CAST(0 AS BIT), error_code = 'VALIDATION',
               message = N'No Sample IDs supplied', registered = 0, skipped = 0,
               charged = 0, charge_total = 0;
        SELECT * FROM @out;
        RETURN;
    END

    /* Resolve the batch to real, still-unregistered samples. */
    DECLARE @work TABLE (
        vailid NVARCHAR(50) PRIMARY KEY, sample_id INT, patient_id INT,
        testcodes NVARCHAR(1000), testtypes NVARCHAR(500),
        modifieddate DATETIME, age INT, age_type INT, gender INT
    );
    INSERT INTO @work
    SELECT DISTINCT s.vailid, s.id, s.patient_id, s.testcodes, s.testtypes,
           s.modifieddate, p.age, p.age_type, p.gender
    FROM @vailids v
    JOIN dbo.tbl_med_mcc_patient_samples s ON s.vailid = v.vailid
    JOIN dbo.tbl_med_mcc_patient_master p ON p.id = s.patient_id
    WHERE s.sample_status = 1;      -- LIS: only 'Sample Sent' is registerable

    /* Anything not picked up is reported back rather than silently dropped. */
    INSERT INTO @out (vailid, outcome, result_rows)
    SELECT v.vailid, 'skipped', 0
    FROM (SELECT DISTINCT vailid FROM @vailids) v
    WHERE NOT EXISTS (SELECT 1 FROM @work w WHERE w.vailid = v.vailid);

    IF NOT EXISTS (SELECT 1 FROM @work)
    BEGIN
        SELECT ok = CAST(1 AS BIT), error_code = CAST(NULL AS VARCHAR(20)),
               message = N'Nothing to register — already accessioned or not found',
               registered = 0, skipped = (SELECT COUNT(*) FROM @out),
               charged = 0, charge_total = 0;
        SELECT * FROM @out;
        RETURN;
    END

    /* ── Positional split of the testcodes/testtypes CSV pair ─────────────
       OPENJSON preserves ordinal position ([key]); STRING_SPLIT did not
       guarantee order on this server's compat level. The two CSVs are written
       in lockstep by usp_telo_create_order / usp_telo_add_sids. */
    DECLARE @items TABLE (
        vailid NVARCHAR(50), pos INT, code NVARCHAR(100), ttype VARCHAR(10)
    );
    INSERT INTO @items (vailid, pos, code, ttype)
    SELECT w.vailid, c.[key], LTRIM(RTRIM(c.value)), LTRIM(RTRIM(t.value))
    FROM @work w
    CROSS APPLY OPENJSON('["' + REPLACE(REPLACE(w.testcodes, '"', ''), ',', '","') + '"]') c
    CROSS APPLY OPENJSON('["' + REPLACE(REPLACE(w.testtypes, '"', ''), ',', '","') + '"]') t
    WHERE t.[key] = c.[key]
      AND LTRIM(RTRIM(c.value)) <> '';

    /* Skeleton rows are staged here, then inserted in display order. */
    DECLARE @rows TABLE (
        seq INT IDENTITY(1,1) PRIMARY KEY,
        vailid NVARCHAR(50), patientid INT, sortkey INT, sub INT,
        testid INT, paramid INT, testcode VARCHAR(50), testname NVARCHAR(400),
        testtype VARCHAR(10), testnormal_range VARCHAR(1000), testunit VARCHAR(50),
        auth BIT, attachment BIT, profile_id INT, updateddate DATETIME,
        machine_value NVARCHAR(400)
    );

    /* ═══ ① 't' / 'mt' — a single test ═══════════════════════════════════ */

    /* 1a. Parameterised test -> one 'Head' row, then its parameter rows. */
    INSERT INTO @rows (vailid, patientid, sortkey, sub, testid, paramid, testcode,
                       testname, testtype, testnormal_range, testunit, auth,
                       attachment, profile_id, updateddate, machine_value)
    SELECT w.vailid, w.patient_id, i.pos, 0,
           tm.id, NULL, '',                       -- LIS: Head testcode = ''
           tm.ReportTestname, 'Head', NULL, NULL, 1,
           tm.Has_graph, NULL,
           DATEADD(HOUR, CASE WHEN tm.TAT > 0 THEN tm.TAT ELSE 5 END, w.modifieddate),
           NULL
    FROM @work w
    JOIN @items i ON i.vailid = w.vailid AND i.ttype IN ('t', 'mt')
    CROSS APPLY (
        SELECT TOP 1 * FROM dbo.tbl_med_test_master m
        WHERE m.TestCode = i.code ORDER BY m.id
    ) tm
    WHERE tm.Has_Parameters = 1;

    INSERT INTO @rows (vailid, patientid, sortkey, sub, testid, paramid, testcode,
                       testname, testtype, testnormal_range, testunit, auth,
                       attachment, profile_id, updateddate, machine_value)
    SELECT w.vailid, w.patient_id, i.pos, pm.Orderno,
           pm.TestCode,                            -- LIS: param's TestCode = test master id
           pm.id, tm.TestCode, pm.Name,
           CASE WHEN pm.shortname IN ('Param', 'Head') THEN pm.shortname ELSE 'Param' END,
           dbo.ufn_telo_param_normal_range(pm.id, w.age, w.age_type, w.gender),
           dbo.ufn_telo_param_unit(pm.TestCode, pm.id),
           0, NULL, NULL, NULL,
           dbo.ufn_telo_sample_value(pm.TestCode, pm.id)
    FROM @work w
    JOIN @items i ON i.vailid = w.vailid AND i.ttype IN ('t', 'mt')
    CROSS APPLY (
        SELECT TOP 1 * FROM dbo.tbl_med_test_master m
        WHERE m.TestCode = i.code ORDER BY m.id
    ) tm
    JOIN dbo.tbl_med_parameter_master pm
      ON pm.TestCode = tm.id AND pm.IsActive = 1
    WHERE tm.Has_Parameters = 1;

    /* 1b. Plain test -> a single 'Test' row. */
    INSERT INTO @rows (vailid, patientid, sortkey, sub, testid, paramid, testcode,
                       testname, testtype, testnormal_range, testunit, auth,
                       attachment, profile_id, updateddate, machine_value)
    SELECT w.vailid, w.patient_id, i.pos, 1,
           tm.id, NULL, tm.TestCode, tm.ReportTestname, 'Test',
           dbo.ufn_telo_test_normal_range(tm.id, w.age, w.age_type, w.gender),
           dbo.ufn_telo_test_unit(tm.id),
           0, tm.Has_graph, NULL,
           DATEADD(HOUR, CASE WHEN tm.TAT > 0 THEN tm.TAT ELSE 5 END, w.modifieddate),
           dbo.ufn_telo_sample_value(tm.id, NULL)
    FROM @work w
    JOIN @items i ON i.vailid = w.vailid AND i.ttype IN ('t', 'mt')
    JOIN dbo.tbl_med_test_master tm ON tm.TestCode = i.code
    WHERE ISNULL(tm.Has_Parameters, 0) = 0;

    /* ═══ ② 'p' / 'mp' — a profile ═══════════════════════════════════════ */

    /* Resolve profile code -> profile id, and its constituent tests. */
    DECLARE @prof TABLE (
        vailid NVARCHAR(50), pos INT, profileid INT, testid INT, orderno INT,
        firstprofileid INT, firsttestid INT
    );
    INSERT INTO @prof
    SELECT w.vailid, i.pos, pm.id, pp.testid, ISNULL(tmm.OrderNo, 0),
           pm.id,
           (SELECT TOP 1 pp2.testid FROM dbo.tbl_med_test_profile_param pp2
            WHERE pp2.profileid = pm.id ORDER BY pp2.id)
    FROM @work w
    JOIN @items i ON i.vailid = w.vailid AND i.ttype IN ('p', 'mp')
    JOIN dbo.tbl_med_test_profile_master pm ON pm.Profile_Code = i.code
    JOIN dbo.tbl_med_test_profile_param pp ON pp.profileid = pm.id
    LEFT JOIN dbo.tbl_med_test_master tmm ON tmm.id = pp.testid;

    /* 2a. Parameterised constituent -> 'Head' + its parameter rows. */
    INSERT INTO @rows (vailid, patientid, sortkey, sub, testid, paramid, testcode,
                       testname, testtype, testnormal_range, testunit, auth,
                       attachment, profile_id, updateddate, machine_value)
    SELECT w.vailid, w.patient_id, pr.pos, pr.orderno * 1000,
           pr.testid, NULL, '', tm.ReportTestname, 'Head', NULL, NULL, 1,
           NULL, pr.firstprofileid,
           DATEADD(HOUR, CASE WHEN tm.TAT > 0 THEN tm.TAT ELSE 5 END, w.modifieddate),
           NULL
    FROM @work w
    JOIN @prof pr ON pr.vailid = w.vailid
    JOIN dbo.tbl_med_test_master tm ON tm.id = pr.testid
    WHERE tm.Has_Parameters = 1;

    INSERT INTO @rows (vailid, patientid, sortkey, sub, testid, paramid, testcode,
                       testname, testtype, testnormal_range, testunit, auth,
                       attachment, profile_id, updateddate, machine_value)
    SELECT w.vailid, w.patient_id, pr.pos, pr.orderno * 1000 + pm.Orderno + 1,
           pm.TestCode, pm.id, tm.TestCode, pm.Name,
           CASE WHEN pm.shortname IN ('Param', 'Head') THEN pm.shortname ELSE 'Param' END,
           dbo.ufn_telo_param_normal_range(pm.id, w.age, w.age_type, w.gender),
           dbo.ufn_telo_param_unit(pm.TestCode, pm.id),
           0, NULL, pr.firstprofileid, NULL,
           dbo.ufn_telo_sample_value(pm.TestCode, pm.id)
    FROM @work w
    JOIN @prof pr ON pr.vailid = w.vailid
    JOIN dbo.tbl_med_test_master tm ON tm.id = pr.testid
    JOIN dbo.tbl_med_parameter_master pm
      ON pm.TestCode = tm.id AND pm.IsActive = 1
    WHERE tm.Has_Parameters = 1;

    /* 2b. Plain constituent -> a single 'Test' row. */
    INSERT INTO @rows (vailid, patientid, sortkey, sub, testid, paramid, testcode,
                       testname, testtype, testnormal_range, testunit, auth,
                       attachment, profile_id, updateddate, machine_value)
    SELECT w.vailid, w.patient_id, pr.pos, pr.orderno * 1000,
           tm.id, NULL, tm.TestCode, tm.ReportTestname, 'Test',
           dbo.ufn_telo_test_normal_range(tm.id, w.age, w.age_type, w.gender),
           dbo.ufn_telo_test_unit(tm.id),
           0, tm.Has_graph, pr.firstprofileid,
           DATEADD(HOUR, CASE WHEN tm.TAT > 0 THEN tm.TAT ELSE 5 END, w.modifieddate),
           dbo.ufn_telo_sample_value(tm.id, NULL)
    FROM @work w
    JOIN @prof pr ON pr.vailid = w.vailid
    JOIN dbo.tbl_med_test_master tm ON tm.id = pr.testid
    WHERE ISNULL(tm.Has_Parameters, 0) = 0;

    /* 2c. Profile header — only when the profile produced Test/Param rows
           (LIS: `lsttests > 0`). sub = -1 sorts it above its own block. */
    INSERT INTO @rows (vailid, patientid, sortkey, sub, testid, paramid, testcode,
                       testname, testtype, testnormal_range, testunit, auth,
                       attachment, profile_id, updateddate, machine_value)
    SELECT DISTINCT w.vailid, w.patient_id, pr.pos, -1,
           pr.firsttestid, NULL, NULL, pfm.Profile_Name, 'Profile',
           NULL, NULL, 1, NULL, pr.firstprofileid, NULL, NULL
    FROM @work w
    JOIN @prof pr ON pr.vailid = w.vailid
    JOIN dbo.tbl_med_test_profile_master pfm ON pfm.id = pr.profileid
    WHERE EXISTS (
        SELECT 1 FROM @rows r
        WHERE r.vailid = w.vailid AND r.sortkey = pr.pos
          AND r.testtype IN ('Test', 'Param')
    );

    /* ═══ ③ Persist ══════════════════════════════════════════════════════ */
    BEGIN TRY
        BEGIN TRAN;

        /* Skeleton — only for SIDs with no existing result rows (LIS
           short-circuits when any row already exists for the vailid). */
        INSERT INTO dbo.tbl_med_mcc_patient_test_result
            (patientid, vailid, testid, paramid, testcode, testname, testtype,
             testnormal_range, testunit, auth, attachment, profile_id,
             addeddate, updateddate, mobile_number)
        SELECT r.patientid, r.vailid, r.testid, r.paramid, r.testcode, r.testname,
               r.testtype, r.testnormal_range, r.testunit, r.auth, r.attachment,
               r.profile_id, GETDATE(), r.updateddate, r.machine_value
        FROM @rows r
        WHERE NOT EXISTS (
            SELECT 1 FROM dbo.tbl_med_mcc_patient_test_result x
            WHERE x.vailid = r.vailid
        )
        ORDER BY r.vailid, r.sortkey, r.sub, r.seq;

        /* Sample -> 'Sample Registered', plus the LIS's report_type rule. */
        UPDATE s
        SET s.sample_status = 2,
            s.modifiedby = @user,
            s.modifieddate = GETDATE(),
            s.lastmodified_date = GETDATE(),
            s.report_type = CASE
                WHEN EXISTS (SELECT 1 FROM dbo.tbl_med_mcc_patient_test_result r
                             WHERE r.vailid = s.vailid
                               AND UPPER(r.testname) LIKE '%THYROID PROFILE I%') THEN 1
                WHEN EXISTS (SELECT 1 FROM dbo.tbl_med_mcc_patient_test_result r
                             WHERE r.vailid = s.vailid
                               AND UPPER(r.testname) LIKE '%ANTIBIOGRAM%') THEN 2
                ELSE s.report_type END
        FROM dbo.tbl_med_mcc_patient_samples s
        JOIN @work w ON w.vailid = s.vailid
        WHERE s.sample_status = 1;

        /* Patient master follows the sample (LIS: patient_master.Status = 2). */
        UPDATE p
        SET p.Status = 2
        FROM dbo.tbl_med_mcc_patient_master p
        JOIN (SELECT DISTINCT patient_id FROM @work) w ON w.patient_id = p.id;

        /* ═══ ④ Client-account charges — port of CheckTransCash ═══════════
           Registering is ALSO when the referring client is billed: each test
           on the sample is charged at that client's contracted rate, written
           to the tbl_med_mcc_test_transactions ledger via the LIS's own
           sp_mcc_test_account_101, and deducted from their running balance.
           Omitting this would put samples on the worksheet for free — silent
           lost revenue — so it lives in the SAME transaction as the status
           flip: either both happen or neither does.

           `amount_checked` on the patient's test row is the charge-once latch
           (the LIS filters on `amount_checked == null`), so a test is never
           billed twice even across re-runs or multi-sample orders. */
        DECLARE @charges TABLE (
            seq INT IDENTITY(1,1) PRIMARY KEY,
            patientTestId INT, acctMcc INT, subCode NVARCHAR(50),
            amount INT, tname NVARCHAR(100), patName NVARCHAR(50), patientId INT
        );

        INSERT INTO @charges (patientTestId, acctMcc, subCode, amount, tname, patName, patientId)
        SELECT DISTINCT pt.id, acct.acctMcc, acct.subCode, rate.amount,
               LEFT(ISNULL(pt.test_name, ''), 100), LEFT(ISNULL(p.name, ''), 49), p.id
        FROM @work w
        JOIN dbo.tbl_med_mcc_patient_master p ON p.id = w.patient_id
        CROSS APPLY (
            /* Sub-franchise: when a user maps this centre as its sub_pcc, the
               money comes off the PARENT's account (LIS: mccAccount keyed on
               objSubFrUserMaster.PCC_Id), and the child's code is recorded. */
            SELECT TOP 1
                   acctMcc = ISNULL(su.PCC_Id, p.mcc_code),
                   subCode = CASE WHEN su.PCC_Id IS NULL THEN N''
                                  ELSE LEFT(ISNULL(cu.MCCUnitCode, N''), 50) END
            FROM (SELECT 1 AS x) d
            OUTER APPLY (
                SELECT TOP 1 u.PCC_Id FROM dbo.tbl_med_user_master u
                WHERE u.sub_pcc_id = p.mcc_code AND u.PCC_Id IS NOT NULL
                ORDER BY u.id
            ) su
            LEFT JOIN dbo.tbl_med_mcc_unit_master cu ON cu.id = p.mcc_code
        ) acct
        JOIN dbo.tbl_med_mcc_patient_tests pt
          ON pt.patient_id = w.patient_id
         AND pt.amount_checked IS NULL
         AND (
              /* Direct test / profile match this sample by code. A master's
                 CSV carries its CHILD codes, so it can only be matched by
                 kind — same as the LIS, which ignores the code there. */
              (pt.test_type IN ('t', 'Test') AND EXISTS (
                  SELECT 1 FROM @items i WHERE i.vailid = w.vailid
                    AND i.ttype = 't' AND i.code = pt.test_code))
           OR (pt.test_type IN ('p', 'Profile') AND EXISTS (
                  SELECT 1 FROM @items i WHERE i.vailid = w.vailid
                    AND i.ttype = 'p' AND i.code = pt.test_code))
           OR (pt.test_type = 'Master' AND EXISTS (
                  SELECT 1 FROM @items i WHERE i.vailid = w.vailid
                    AND i.ttype IN ('mt', 'mp')))
         )
        CROSS APPLY (
            /* An MCC special rate always wins over the rate list, and the rate
               list is keyed on the ACCOUNT centre's RateType. */
            SELECT amount = ISNULL(
                (SELECT TOP 1 sr.rate FROM dbo.tbl_med_mcc_test_special_rates sr
                  WHERE sr.mcccode = p.mcc_code AND sr.testid = pt.test_id
                    AND sr.testtype = CASE WHEN pt.test_type IN ('t','Test') THEN 'T'
                                           WHEN pt.test_type IN ('p','Profile') THEN 'P'
                                           ELSE 'M' END
                  ORDER BY sr.id),
                CASE
                  WHEN pt.test_type IN ('t','Test') THEN
                    (SELECT TOP 1 r.Price FROM dbo.tbl_med_test_rates_with_pcc_type r
                      WHERE r.TestCode = pt.test_id AND r.RateTypeId = au.RateType ORDER BY r.id)
                  WHEN pt.test_type IN ('p','Profile') THEN
                    (SELECT TOP 1 r.Price FROM dbo.tbl_med_profile_rates_with_pcc_types r
                      WHERE r.profilecode = pt.test_id AND r.RateTypeId = au.RateType ORDER BY r.id)
                  ELSE
                    (SELECT TOP 1 r.Price FROM dbo.tbl_med_master_profile_rates_with_pcc_types r
                      WHERE r.master_profile_code = pt.test_id AND r.RateTypeId = au.RateType ORDER BY r.id)
                END)
            FROM dbo.tbl_med_mcc_unit_master au WHERE au.id = acct.acctMcc
        ) rate
        WHERE rate.amount IS NOT NULL;   -- no configured rate -> charge nothing

        /* Post each charge against a RUNNING balance, so the ledger's
           opening/closing columns chain exactly as the LIS's do. */
        DECLARE @ci INT = 1, @cn INT = (SELECT COUNT(*) FROM @charges);
        DECLARE @cPt INT, @cMcc INT, @cSub NVARCHAR(50), @cAmt INT,
                @cTname NVARCHAR(100), @cPat NVARCHAR(50), @cPid INT,
                @bal INT, @closing INT, @now DATETIME;
        WHILE @ci <= @cn
        BEGIN
            SELECT @cPt = patientTestId, @cMcc = acctMcc, @cSub = subCode,
                   @cAmt = amount, @cTname = tname, @cPat = patName, @cPid = patientId
            FROM @charges WHERE seq = @ci;

            /* Re-assert the latch inside the loop: never double-charge. */
            IF EXISTS (SELECT 1 FROM dbo.tbl_med_mcc_patient_tests
                       WHERE id = @cPt AND amount_checked IS NULL)
            BEGIN
                IF NOT EXISTS (SELECT 1 FROM dbo.tbl_med_mcc_account_master
                               WHERE mcccode = @cMcc)
                    INSERT INTO dbo.tbl_med_mcc_account_master
                        (mcccode, currentbalance, totaldeposited)
                    VALUES (@cMcc, 0, 0);

                SELECT @bal = ISNULL(currentbalance, 0)
                FROM dbo.tbl_med_mcc_account_master WHERE mcccode = @cMcc;
                SET @now = GETDATE();
                /* T-SQL forbids an expression as an EXEC argument — the
                   closing balance must be materialised first. */
                SET @closing = @bal - @cAmt;

                EXEC dbo.sp_mcc_test_account_101
                     @USERID = @userId, @MCCID = @cMcc, @TDATE = @now,
                     @CBALANCE = @bal, @TESTCHARGES = @cAmt,
                     @CLOSINGBALANCE = @closing,
                     @tname = @cTname,
                     @vailid = @cPat,       -- LIS stores the PATIENT NAME here
                     @patientid = @cPid, @SUBFRANCHISE = @cSub;

                UPDATE dbo.tbl_med_mcc_account_master
                SET currentbalance = @closing
                WHERE mcccode = @cMcc;

                UPDATE dbo.tbl_med_mcc_patient_tests
                SET amount_checked = 1, updateddate = GETDATE()
                WHERE id = @cPt;
            END
            SET @ci += 1;
        END

        /* ④b Custom lines — the billed-but-not-performed extras (the Smart
           Report, an external glucose) have no test row and no sample, so
           the loop above never sees them, and until 2026-09-21 they were
           billed to the patient and never charged to the centre. They are
           charged to the same account, once, the first time any of the
           patient's samples is registered — the lab's own signal that the
           visit is real — through usp_telo_charge_custom_lines, which posts
           exactly as the loop above does. */
        DECLARE @cpPid INT, @cpCharged INT, @cpTotal INT,
                @customCharged INT = 0, @customTotal INT = 0;
        DECLARE cp CURSOR LOCAL FAST_FORWARD FOR SELECT DISTINCT patient_id FROM @work;
        OPEN cp; FETCH NEXT FROM cp INTO @cpPid;
        WHILE @@FETCH_STATUS = 0
        BEGIN
            EXEC dbo.usp_telo_charge_custom_lines
                 @userId = @userId, @patientId = @cpPid,
                 @charged = @cpCharged OUTPUT, @charge_total = @cpTotal OUTPUT;
            SET @customCharged += ISNULL(@cpCharged, 0);
            SET @customTotal   += ISNULL(@cpTotal, 0);
            FETCH NEXT FROM cp INTO @cpPid;
        END
        CLOSE cp; DEALLOCATE cp;

        INSERT INTO @out (vailid, outcome, result_rows)
        SELECT w.vailid, 'registered',
               (SELECT COUNT(*) FROM dbo.tbl_med_mcc_patient_test_result r
                WHERE r.vailid = w.vailid)
        FROM @work w;

        COMMIT;

        SELECT ok = CAST(1 AS BIT), error_code = CAST(NULL AS VARCHAR(20)),
               message = CAST(NULL AS NVARCHAR(400)),
               registered = (SELECT COUNT(*) FROM @out WHERE outcome = 'registered'),
               skipped    = (SELECT COUNT(*) FROM @out WHERE outcome = 'skipped'),
               charged      = @cn + @customCharged,
               charge_total = ISNULL((SELECT SUM(amount) FROM @charges), 0) + @customTotal;
        SELECT * FROM @out;
    END TRY
    BEGIN CATCH
        IF @@TRANCOUNT > 0 ROLLBACK;
        SELECT ok = CAST(0 AS BIT), error_code = 'INTERNAL',
               message = LEFT(ERROR_MESSAGE(), 400), registered = 0,
               skipped = (SELECT COUNT(*) FROM @out),
               charged = 0, charge_total = 0;
        SELECT * FROM @out;
    END CATCH
END
GO

/*
 * 60_usp_telo_create_order.sql  —  THE atomic order write.
 *
 * ⚠ SHARED PROCEDURE — Telo is NOT the only caller.
 *
 * Stellar Infinity calls dbo.usp_telo_create_order too, and does not keep a
 * copy of it: this file is the definition of record for BOTH products. A
 * deploy from this repo (npm run deploy:sp, with or without a file argument —
 * no-arg walks all of db/sql/) CREATE-OR-ALTERs the live procedure, so
 * anything Infinity added and this file lacks is silently destroyed.
 *
 * That has already come close once: Infinity added @priceAtClientRate in prod
 * on 2026-08-18, and a Telo redeploy of this file would have removed it and
 * broken their B2B ordering. Before editing, diff this file against the
 * deployed definition (sys.sql_modules) and carry over anything you find.
 *
 * Parameters exist here that Telo never passes and must not remove:
 *   @origin            — origin marker prefix; Infinity passes 'inf:'
 *   @priceAtClientRate — price at the client rate while still tagging b2b
 */
/*
 * 60_usp_telo_create_order.sql — order-write details follow.
 *
 * One transaction across the LIS order chain:
 *   ① tbl_med_mcc_patient_master   (create patient, or reuse @patientId)
 *   ② tbl_med_mcc_patient_tests    (one row per line — UNbilled: amount_checked
 *                                   / updateddate stay NULL until the LIS
 *                                   Accession "Register" bills them)
 *   ③ tbl_med_mcc_patient_samples  (N rows — ONE per distinct sample type)
 *   ④ tbl_billing_patient_detail   (Telo bill header, generated bill_number)
 *   ⑤ tbl_billing_patient_test_detail (one row per line)
 *   ⑥ tbl_billing_patient_amount_receipt (one row per payment line — split
 *                                   payments supported; none if paid ₹0)
 *
 * The franchise wallet is NOT debited here. The LIS debits it when the order
 * is moved Accessioning → Worksheet (Accession "Register" → CheckTransCash) —
 * doing it here too would double-debit. ④⑤⑥ are Telo-internal bill records
 * and are invisible to the LIS sales/ledger reports.
 *
 * MULTI-SID MODEL: matches the legacy LIS. Tests that share a physical sample
 * type share one SID; tests requiring different sample types each get their
 * own SID. All SIDs link to ONE patient (PID). The caller supplies one
 * (sampleTypeId, vailid) pair per distinct sample type via @sids; the SP
 * recomputes the required group set server-side and never trusts the caller's
 * grouping decision — only their SID assignments.
 *
 * @sids is OPTIONAL: an order may be registered with no SIDs (deferred) or a
 * partial set. The lab technician accessions the remaining SIDs later via
 * dbo.usp_telo_add_sids. Only sample rows for the supplied SIDs are written.
 *
 * Rate is ALWAYS re-resolved here (3-tier, MCC RateType) and test code/name
 * resolved from masters — client values are never trusted. Pass @patientId=0
 * to create a new patient.
 *
 * Returns:
 *   - status row: { ok, error_code, message, patient_id, bill_id,
 *                   bill_number, total, sample_count }
 *   - secondary recordset (samples): one row per issued sample
 *                 { sample_id, vailid, sample_type_id, sample_type_name }
 */
CREATE OR ALTER PROCEDURE dbo.usp_telo_create_order
    @userId           INT,
    @mcc              INT,
    @sids             dbo.TeloSampleSid READONLY,
    @patientId        INT            = 0,
    @name             NVARCHAR(200)  = NULL,
    @initial          NVARCHAR(10)   = NULL,
    @age              INT            = NULL,
    @gender           INT            = NULL,
    @ageType          INT            = NULL,
    @mobile           VARCHAR(20)    = NULL,
    @email            VARCHAR(100)   = NULL,
    @clinicalHistory  VARCHAR(500)   = NULL,
    @clinicalFile     VARBINARY(MAX) = NULL,
    @clinicalFileName VARCHAR(100)   = NULL,
    @mrnId            VARCHAR(50)    = NULL,
    @refDoctor        INT            = NULL,
    @refCustomer      INT            = NULL,
    @newRefDoctorName   NVARCHAR(200) = NULL,
    @newRefCustomerName NVARCHAR(200) = NULL,
    @items            dbo.TeloTestList READONLY,
    @discountAmount   INT            = 0,
    @paymentType      VARCHAR(50)    = NULL,
    @payMode          INT            = NULL,
    @receiptAmount    INT            = 0,
    @billAtMrp        BIT            = 0,
    @paymentRef       VARCHAR(100)   = NULL,
    -- B2C Gold Card: when @goldCard=1 (and card details supplied) the whole
    -- bill is charged at 50% — every line rate is halved at the source so the
    -- header amount, line items and LIS-facing test rows are all consistent.
    -- Ignored in B2B (@billAtMrp=1). The card is recorded in dbo.telo_gold_card.
    @goldCard         BIT            = 0,
    @goldCardNumber   NVARCHAR(50)   = NULL,
    @goldCardHolder   NVARCHAR(200)  = NULL,
    -- Split payments: one row per payment line (₹500 Cash + ₹500 UPI). When
    -- supplied (and non-empty) it SUPERSEDES the @paymentType/@receiptAmount/
    -- @paymentRef scalars, which are kept only for older single-payment callers.
    @payments         dbo.TeloPayment READONLY,
    -- Telo-only ("custom") lines: billed but NOT performed on our LIS. Each
    -- becomes a tbl_billing_patient_test_detail line + a telo_custom_test_order
    -- log row ONLY — never a tbl_med_mcc_patient_tests / _samples row — so it
    -- stays out of the LIS lab workflow, worksheets and reports entirely.
    @customLines      dbo.TeloCustomLine READONLY,
    -- MRD free-text snapshot (the operator's "MRD + visit" field) recorded on
    -- each custom line for traceability. Required when a custom line's
    -- definition marks requires_mrd = 1 (enforced below).
    @mrdText          NVARCHAR(200)  = NULL,
    -- Origin marker prefix stamped into addedby/createdby/receivedby, as
    -- '<origin><userId>'. Defaulted to 'telo:' so every existing Telo caller
    -- behaves exactly as before and needs no change.
    --
    -- Stellar Infinity is taking over the ordering pipeline and passes 'inf:'.
    -- Parameterised rather than forked: this procedure is ~1,000 lines of
    -- pricing, gold-card, split-payment and custom-test rules, and a second
    -- copy of it writing to the same tables would drift the first time either
    -- side fixed a bug.
    @origin           NVARCHAR(20)   = N'telo:',
    /* Price the basket at the CLIENT'S RATE while still tagging the order
       b2b. @billAtMrp alone cannot express that: it decides the price AND is
       what writes dbo.telo_order_kind, so an Infinity B2B order wanting rate
       pricing would have had to drop the tag and vanish from the B2B worklist.

       Noble bills a collection centre what the centre owes the LAB. MRP is
       what the centre charges its own patient and stays in the order form for
       margin only. This also makes the bill agree with the wallet, which
       usp_telo_accession_samples has always debited at the client rate.

       LAST in the list and DEFAULT 0 so no existing caller - Telo above all,
       whose call sites are not in this repo - changes behaviour or argument
       position. */
    @priceAtClientRate BIT           = 0
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE @pid INT, @billId INT, @billNo INT,
            @total INT = 0, @customTotal INT = 0,
            @rateTypeId INT, @buCode INT, @pname NVARCHAR(200),
            @o BIT, @ec VARCHAR(20), @sampleCount INT = 0,
            @txn VARCHAR(24);

    /* addedby/createdby/receivedby is stamped '<@origin><userId>' — 'telo:1234'
       by default, 'inf:1234' when Stellar Infinity is the caller. This is an
       INTENTIONAL origin marker, not a defect: every Telo read path
       (the New-Order/pending-accession worklist in orders.ts, the ledger and
       receipts reports, the txn backfill) finds Telo orders with
       `addedby LIKE 'telo:%'`. It does NOT break the LIS report download — that
       failure was caused by NULL initial/MRNID (fixed below); hundreds of
       thousands of normal LIS rows carry a non-Username addedby and print fine.
       Keep the marker so each platform can identify its own orders.

       NOTE for anyone adding a read path that filters on the marker: while both
       platforms are live, "created by our software" means telo: OR inf:. The
       mobile-allowance gate below is the one place in this procedure that reads
       it back, and it counts both — see the comment there for why. */

    /* Salutation kept in patient_master.initial (separate from name) — the LIS
       report download dereferences it, so it must never be NULL (an empty
       string is fine; the crash was NULL only).
         - @initial IS NULL  -> truly missing: fall back to a gender-derived
           title (the historic defensive behaviour).
         - @initial = N''     -> the operator's explicit "Other" / no-salutation
           choice: store an empty (non-NULL) initial so nothing prints before
           the name. Must NOT be turned into Mr/Ms.
         - otherwise          -> the chosen title, trimmed. */
    DECLARE @initialFinal NVARCHAR(10) =
        CASE
            WHEN @initial IS NULL
                THEN CASE @gender WHEN 1 THEN N'Mr' WHEN 2 THEN N'Ms' ELSE N'Mr' END
            ELSE LTRIM(RTRIM(@initial))
        END;

    /* ---- declared variable for SID-validation messaging ------------------- */
    DECLARE @extraTypes NVARCHAR(200), @dupVailids NVARCHAR(400);

    /* Empty-result samples table for early-return paths so callers always
       see two recordsets (status + samples). */
    DECLARE @emptySamples TABLE (
        sample_id INT, vailid NVARCHAR(50),
        sample_type_id INT, sample_type_name NVARCHAR(100)
    );

    /* =================== validation ====================================== */
    /* Existence only — NOT IsActive.
       tbl_med_mcc_unit_master.IsActive is not a liveness flag in this
       deployment: over 1,700 codes carry IsActive = 0 while trading daily, and
       the LIS itself ignores it for client codes (both "PCC" pickers in
       MedCis.Business/Utilities.cs carry a commented-out IsActive filter).
       Telo's readers stopped trusting it in v1.85; this gate was the last
       place that still did, and it hard-blocked ordering for any centre the
       LIS had flagged inactive — MDCARE included, which is ~99% of Telo's
       order volume. See db/read/mccUnits.ts for the full rationale. */
    IF NOT EXISTS (SELECT 1 FROM dbo.tbl_med_mcc_unit_master
                   WHERE id = @mcc)
    BEGIN
        SELECT ok = CAST(0 AS BIT), error_code = 'VALIDATION',
               message = N'Unknown collection centre',
               patient_id = NULL, bill_id = NULL, bill_number = NULL,
               total = 0, sample_count = 0;
        SELECT * FROM @emptySamples;
        RETURN;
    END
    /* An order needs at least one line — a normal LIS test/profile (@items) OR
       a Telo-only custom line (@customLines). A custom-only order is valid. */
    IF NOT EXISTS (SELECT 1 FROM @items) AND NOT EXISTS (SELECT 1 FROM @customLines)
    BEGIN
        SELECT ok = CAST(0 AS BIT), error_code = 'VALIDATION',
               message = N'No test/profile lines supplied',
               patient_id = NULL, bill_id = NULL, bill_number = NULL,
               total = 0, sample_count = 0;
        SELECT * FROM @emptySamples;
        RETURN;
    END
    /* MRD gate: a custom line whose definition requires an MRD cannot be billed
       without one. The MRD is captured via the ref_customer field — an existing
       id (@refCustomer) or a fresh name (@newRefCustomerName, the typed MRD).
       Authoritative gate; registerOrder blocks the submit too. */
    IF EXISTS (SELECT 1 FROM @customLines WHERE requiresMrd = 1)
       AND @refCustomer IS NULL
       AND (@newRefCustomerName IS NULL OR LTRIM(RTRIM(@newRefCustomerName)) = N'')
    BEGIN
        SELECT ok = CAST(0 AS BIT), error_code = 'VALIDATION',
               message = N'An MRD number is required for this order.',
               patient_id = NULL, bill_id = NULL, bill_number = NULL,
               total = 0, sample_count = 0;
        SELECT * FROM @emptySamples;
        RETURN;
    END
    /* @sids is OPTIONAL — an order may be registered with no SIDs (the lab
       technician accessions them later via usp_telo_add_sids). A partial set
       is also fine. Any row that IS supplied must carry a non-empty vailid. */
    IF EXISTS (SELECT 1 FROM @sids WHERE vailid IS NULL OR LTRIM(RTRIM(vailid)) = N'')
    BEGIN
        SELECT ok = CAST(0 AS BIT), error_code = 'VALIDATION',
               message = N'Every sample type needs a non-empty Sample ID',
               patient_id = NULL, bill_id = NULL, bill_number = NULL,
               total = 0, sample_count = 0;
        SELECT * FROM @emptySamples;
        RETURN;
    END
    /* Duplicate vailids within the submitted set */
    SELECT @dupVailids = STRING_AGG(vailid, ', ')
    FROM (SELECT vailid FROM @sids GROUP BY vailid HAVING COUNT(*) > 1) d;
    IF @dupVailids IS NOT NULL
    BEGIN
        SELECT ok = CAST(0 AS BIT), error_code = 'CONFLICT',
               message = CONCAT(N'Duplicate Sample IDs within this order: ', @dupVailids),
               patient_id = NULL, bill_id = NULL, bill_number = NULL,
               total = 0, sample_count = 0;
        SELECT * FROM @emptySamples;
        RETURN;
    END
    /* Vailids already in Noble (pre-check; trigger is the hard guarantee) */
    DECLARE @existingVailids NVARCHAR(400) =
        (SELECT STRING_AGG(s.vailid, ', ')
         FROM @sids s
         WHERE EXISTS (SELECT 1 FROM dbo.tbl_med_mcc_patient_samples ps
                       WHERE ps.vailid = s.vailid));
    IF @existingVailids IS NOT NULL
    BEGIN
        SELECT ok = CAST(0 AS BIT), error_code = 'CONFLICT',
               message = CONCAT(N'Sample ID(s) already exist: ', @existingVailids),
               patient_id = NULL, bill_id = NULL, bill_number = NULL,
               total = 0, sample_count = 0;
        SELECT * FROM @emptySamples;
        RETURN;
    END
    /* A mobile number may belong to at most 4 self-registered patients. The
       form and registerOrder pre-check this live; this is the authoritative
       gate. Only rows OUR software created count (native LIS patients don't
       consume the allowance) and only a NEW patient row can consume a slot
       (@patientId reuse adds no patient).

       Counts telo: AND inf: deliberately. The allowance is a property of the
       mobile number, not of whichever front end happened to take the booking —
       so while both platforms are live it has to be ONE shared allowance.
       Counting only the caller's own marker would let a number reach four in
       Telo and four again in Infinity, silently doubling a limit that exists
       to stop one number being used to register a whole village. */
    IF (@patientId IS NULL OR @patientId = 0)
       AND @mobile IS NOT NULL AND LTRIM(RTRIM(@mobile)) <> ''
    BEGIN
        DECLARE @mobileUses INT =
            (SELECT COUNT(*) FROM dbo.tbl_med_mcc_patient_master
             WHERE mobile_number = @mobile
               AND (addedby LIKE 'telo:%' OR addedby LIKE 'inf:%'));
        IF @mobileUses >= 4
        BEGIN
            SELECT ok = CAST(0 AS BIT), error_code = 'CONFLICT',
                   message = CONCAT(N'This mobile number is already used by ',
                                    @mobileUses,
                                    N' patients — the limit is 4 patients per number.'),
                   patient_id = NULL, bill_id = NULL, bill_number = NULL,
                   total = 0, sample_count = 0;
            SELECT * FROM @emptySamples;
            RETURN;
        END
    END

    SELECT @rateTypeId = RateType, @buCode = BusinessUnitCode
    FROM dbo.tbl_med_mcc_unit_master WHERE id = @mcc;

    /* =================== rate-resolved @lines (per user-selected item) ==== */
    /* One row per user-selected item. A master profile bills as a SINGLE line
       (test_type 'Master') — its children are NOT billed individually; they
       only drive sample grouping below. itemKind: 0=test 1=profile 2=master. */
    DECLARE @lines TABLE (
        rn           INT IDENTITY(1,1),
        testMasterId INT,
        itemKind     TINYINT,
        code         NVARCHAR(50),
        name         NVARCHAR(200),
        testtype     CHAR(1),
        rate         INT
    );

    INSERT INTO @lines (testMasterId, itemKind, code, name, testtype, rate)
    SELECT
        i.testMasterId, i.itemKind,
        CASE i.itemKind
          WHEN 0 THEN (SELECT t.TestCode FROM dbo.tbl_med_test_master t
                         WHERE t.id = i.testMasterId AND t.IsActive = 1)
          WHEN 1 THEN (SELECT pm.Profile_Code FROM dbo.tbl_med_test_profile_master pm
                         WHERE pm.id = i.testMasterId AND pm.IsActive = 1)
          ELSE (SELECT mp.Master_Profile_Code FROM dbo.tbl_med_test_master_profile_master mp
                  WHERE mp.id = i.testMasterId AND mp.IsActive = 1)
        END,
        CASE i.itemKind
          WHEN 0 THEN (SELECT t.Testname FROM dbo.tbl_med_test_master t
                         WHERE t.id = i.testMasterId AND t.IsActive = 1)
          WHEN 1 THEN (SELECT pm.Profile_Name FROM dbo.tbl_med_test_profile_master pm
                         WHERE pm.id = i.testMasterId AND pm.IsActive = 1)
          ELSE (SELECT mp.Master_Profile_Name FROM dbo.tbl_med_test_master_profile_master mp
                  WHERE mp.id = i.testMasterId AND mp.IsActive = 1)
        END,
        CASE i.itemKind WHEN 1 THEN 'p' WHEN 2 THEN 'm' ELSE 't' END,
        -- Rate MUST mirror usp_telo_resolve_rate so the billed price equals the
        -- price previewed in the order form:
        --   tier 0: per-MCC special rate (tbl_med_mcc_test_special_rates) — the
        --           LIS always prefers this over the rate list (CheckTransCash).
        --   tier 1: rate-list Price for @rateTypeId
        --   tier 2: catalogue MRP
        --   tier 3: 0 (never NULL — billing line needs a number)
        COALESCE(
          CASE WHEN @billAtMrp = 1 AND @priceAtClientRate = 0 THEN NULL ELSE (SELECT sr.rate FROM dbo.tbl_med_mcc_test_special_rates sr
             WHERE sr.mcccode = @mcc
               AND sr.testtype = CASE i.itemKind WHEN 0 THEN 'T' WHEN 1 THEN 'P' ELSE 'M' END
               AND sr.testid = i.testMasterId) END,
          CASE WHEN @billAtMrp = 1 AND @priceAtClientRate = 0 THEN NULL ELSE CASE i.itemKind
            WHEN 0 THEN (SELECT r.Price FROM dbo.tbl_med_test_rates_with_pcc_type r
                           WHERE r.TestCode = i.testMasterId
                             AND r.RateTypeId = @rateTypeId AND r.IsActive = 1)
            WHEN 1 THEN (SELECT r.Price FROM dbo.tbl_med_profile_rates_with_pcc_types r
                           WHERE r.profilecode = i.testMasterId
                             AND r.RateTypeId = @rateTypeId AND r.IsActive = 1)
            ELSE (SELECT r.Price FROM dbo.tbl_med_master_profile_rates_with_pcc_types r
                    WHERE r.master_profile_code = i.testMasterId
                      AND r.RateTypeId = @rateTypeId AND r.IsActive = 1)
          END END,
          CASE i.itemKind
            WHEN 0 THEN (SELECT t.MRP FROM dbo.tbl_med_test_master t WHERE t.id = i.testMasterId)
            WHEN 1 THEN (SELECT pm.MRP FROM dbo.tbl_med_test_profile_master pm WHERE pm.id = i.testMasterId)
            ELSE (SELECT mp.MRP FROM dbo.tbl_med_test_master_profile_master mp WHERE mp.id = i.testMasterId)
          END,
          0)
    FROM @items i;

    IF EXISTS (SELECT 1 FROM @lines WHERE code IS NULL OR name IS NULL)
    BEGIN
        DECLARE @bad NVARCHAR(400) =
            (SELECT STRING_AGG(CONCAT(CASE itemKind WHEN 1 THEN 'profile#' WHEN 2 THEN 'master#' ELSE 'test#' END,
                                      testMasterId), ', ')
             FROM @lines WHERE code IS NULL OR name IS NULL);
        SELECT ok = CAST(0 AS BIT), error_code = 'VALIDATION',
               message = CONCAT(N'Unknown or inactive test/profile/master id(s): ', @bad),
               patient_id = NULL, bill_id = NULL, bill_number = NULL,
               total = 0, sample_count = 0;
        SELECT * FROM @emptySamples;
        RETURN;
    END

    /* Gold Card (B2C only): halve EVERY line so the whole bill is 50% off.
       Done at the source so @total, the billing line items (⑤) and the
       LIS-facing test rows (②) are all consistently halved. Ignored in B2B
       (@billAtMrp=1) and when card details are missing. ROUND(…/2.0) matches
       the client preview + server floor check (round half up). */
    DECLARE @goldApplied BIT = 0;
    IF @goldCard = 1 AND @billAtMrp = 0
       AND NULLIF(LTRIM(RTRIM(@goldCardNumber)), N'') IS NOT NULL
       AND NULLIF(LTRIM(RTRIM(@goldCardHolder)), N'') IS NOT NULL
    BEGIN
        UPDATE @lines SET rate = CAST(ROUND(rate / 2.0, 0) AS INT);
        SET @goldApplied = 1;
        -- The Gold Card IS the discount (50%). No manual discount may stack on
        -- top of it — force it to zero here so even a hand-crafted caller that
        -- bypasses the server action can never apply an extra reduction.
        SET @discountAmount = 0;
    END

    SELECT @total = ISNULL(SUM(rate), 0) FROM @lines;

    /* Telo-only custom lines add to the bill total (unitAmount × qty each) but
       drive NO sample grouping and NO LIS test rows. They are NEVER halved by a
       Gold Card — they're a pass-through of an externally-performed charge. */
    SELECT @customTotal = ISNULL(SUM(unitAmount * qty), 0) FROM @customLines;
    SET @total = @total + @customTotal;

    /* =================== compute required sample groups =================== */
    /* Mirror the preview SP exactly so the SP is self-contained and the form
       can never desync the grouping. */
    /* `selection` flattens every TVP row to one or more (effId, isProfile)
       entries: tests/profiles pass through; a master (itemKind=2) expands to
       its child profiles + child tests. fromMaster marks master-derived rows
       so the sample codeType is tagged 'mp'/'mt' (the LIS Master tags) instead
       of 'p'/'t'. The test/profile path is byte-for-byte the prior logic. */
    ;WITH selection AS (
        SELECT i.testMasterId AS effId, CAST(0 AS BIT) AS isProfile,
               i.code AS effCode, i.name AS effName, CAST(0 AS BIT) AS fromMaster,
               CAST(NULL AS INT) AS masterId, CAST(NULL AS NVARCHAR(200)) AS masterName,
               CAST(NULL AS INT) AS masterSeq
        FROM @items i WHERE i.itemKind = 0
        UNION ALL
        SELECT i.testMasterId, CAST(1 AS BIT), i.code, i.name, CAST(0 AS BIT),
               CAST(NULL AS INT), CAST(NULL AS NVARCHAR(200)), CAST(NULL AS INT)
        FROM @items i WHERE i.itemKind = 1
        UNION ALL
        /* A package's children come from its DEFINITION, active or not,
           in the definition's own row order and under the definition's own
           names — exactly as the LIS books it (PatientWorkOrder.aspx.cs
           walks GetListofProfileinMaster / GetListofTestsInMaster with no
           active filter, no sort, and takes profile_name / test_name from
           the member row). The IsActive filter this replaced silently
           dropped Thyroid Profile II (inactive, yet a member of HEALTH
           SCREEN 3 and nine other live packages) and with it FT3, FT4 and
           TSH from every Infinity booking of those packages; 2026-09-19. */
        SELECT mpp.profileid, CAST(1 AS BIT),
               pmf.Profile_Code, ISNULL(NULLIF(mpp.profile_name, N''), pmf.Profile_Name), CAST(1 AS BIT),
               i.testMasterId, i.name, mpp.id
        FROM @items i
        JOIN dbo.tbl_med_test_master_profile_param mpp ON mpp.master_profileid = i.testMasterId
        JOIN dbo.tbl_med_test_profile_master pmf ON pmf.id = mpp.profileid
        WHERE i.itemKind = 2
        UNION ALL
        SELECT mtp.testid, CAST(0 AS BIT),
               CONVERT(NVARCHAR(50), tmf.TestCode), ISNULL(NULLIF(mtp.test_name, N''), tmf.Testname), CAST(1 AS BIT),
               i.testMasterId, i.name, mtp.id
        FROM @items i
        JOIN dbo.tbl_med_test_master_test_param mtp ON mtp.master_profileid = i.testMasterId
        JOIN dbo.tbl_med_test_master tmf ON tmf.id = mtp.testid
        WHERE i.itemKind = 2
    ),
    item_resolution AS (
        SELECT s.effId AS originId, s.isProfile, s.fromMaster,
               s.effCode AS originCode, s.effName AS originName,
               t.id AS testMasterId, t.TestCode AS testCode,
               t.Testname AS testName, t.SampleId AS sampleTypeId,
               s.masterId, s.masterName, s.masterSeq
        FROM selection s
        JOIN dbo.tbl_med_test_master t ON t.id = s.effId AND (t.IsActive = 1 OR s.fromMaster = 1)
        WHERE s.isProfile = 0
        UNION ALL
        SELECT s.effId AS originId, s.isProfile, s.fromMaster,
               s.effCode AS originCode, s.effName AS originName,
               t.id AS testMasterId, t.TestCode AS testCode,
               t.Testname AS testName, t.SampleId AS sampleTypeId,
               s.masterId, s.masterName, s.masterSeq
        FROM selection s
        JOIN dbo.tbl_med_test_profile_param pp ON pp.profileid = s.effId
        /* A profile's members come from its definition, active or not —
           ordered directly or through a package — as the LIS expands it
           (ProfileMasterClass.GetTestsByProfileID has no active filter).
           Only a test ordered as its own line must be active; 2026-09-19. */
        JOIN dbo.tbl_med_test_master t ON t.id = pp.testid
        WHERE s.isProfile = 1
    ),
    profile_span AS (
        SELECT originId, COUNT(DISTINCT ISNULL(sampleTypeId, -1)) AS span
        FROM item_resolution WHERE isProfile = 1 GROUP BY originId
    ),
    /* codeType is the LIS per-code sample-row type — CheckTransCash routes each
       sample code to its bucket by this: 't'/'p' for direct test/profile,
       'mt'/'mp' for codes that came from a master profile. A one-sample-type
       profile keeps the profile code; a split profile contributes test codes. */
    bucketed AS (
        SELECT ISNULL(ir.sampleTypeId, -1) AS sampleTypeId,
               ir.testCode AS code, ir.testName AS name,
               CASE WHEN ir.fromMaster = 1 THEN 'mt' ELSE 't' END AS codeType,
               ir.masterId, ir.masterName, ir.masterSeq
        FROM item_resolution ir WHERE ir.isProfile = 0
        UNION ALL
        SELECT DISTINCT ISNULL(ir.sampleTypeId, -1), ir.originCode,
               ir.originName,
               CASE WHEN ir.fromMaster = 1 THEN 'mp' ELSE 'p' END,
               ir.masterId, ir.masterName, ir.masterSeq
        FROM item_resolution ir
        JOIN profile_span ps ON ps.originId = ir.originId
        WHERE ir.isProfile = 1 AND ps.span = 1
        UNION ALL
        SELECT ISNULL(ir.sampleTypeId, -1), ir.testCode, ir.testName,
               CASE WHEN ir.fromMaster = 1 THEN 'mt' ELSE 't' END,
               ir.masterId, ir.masterName, ir.masterSeq
        FROM item_resolution ir
        JOIN profile_span ps ON ps.originId = ir.originId
        WHERE ir.isProfile = 1 AND ps.span > 1
    ),
    /* The tube's CSVs as the LIS writes them: a package's profiles first,
       then its tests, each in the package definition's row order, then
       anything ordered directly (by code, as before); and the package's
       name tagged onto its LAST profile and its LAST test — last across the
       whole package, so at most two tubes carry the tag, which is what the
       legacy Sample Worksheet keys on to show the package a tube belongs
       to. Mirrors PatientWorkOrder.aspx.cs, which tags lstSample.Last()
       once after the profile loop and once after the test loop. */
    ordered AS (
        SELECT b.*,
               sortKey = CASE b.codeType WHEN 'mp' THEN 0 WHEN 'mt' THEN 1 WHEN 'p' THEN 2 ELSE 3 END,
               tagRank = CASE WHEN b.masterId IS NULL THEN NULL ELSE ROW_NUMBER() OVER (
                   PARTITION BY b.masterId, CASE WHEN b.codeType = 'mp' THEN 0 ELSE 1 END
                   ORDER BY b.masterSeq DESC, b.code DESC) END
        FROM bucketed b
    )
    SELECT
        o.sampleTypeId,
        ISNULL(sm.Sampletype, N'Unspecified') AS sampleTypeName,
        STRING_AGG(CONVERT(NVARCHAR(MAX), o.code), N',')
            WITHIN GROUP (ORDER BY o.sortKey, o.masterSeq, o.code) AS csvCodes,
        STRING_AGG(CONVERT(NVARCHAR(MAX),
            CASE WHEN o.tagRank = 1
                 THEN o.name + N'&nbsp;<i><b>[' + o.masterName + N']</b></i>'
                 ELSE o.name END), N',')
            WITHIN GROUP (ORDER BY o.sortKey, o.masterSeq, o.code) AS csvNames,
        STRING_AGG(CONVERT(NVARCHAR(MAX), o.codeType), N',')
            WITHIN GROUP (ORDER BY o.sortKey, o.masterSeq, o.code) AS csvTypes
    INTO #groups
    FROM ordered o
    LEFT JOIN dbo.tbl_med_sample_master sm ON sm.id = o.sampleTypeId
    GROUP BY o.sampleTypeId, sm.Sampletype;

    /* SIDs are optional/partial — a missing sample type is NOT rejected (the
       lab tech accessions it later). We only reject SIDs for a sample type
       this order does not need. */
    SELECT @extraTypes = STRING_AGG(CONVERT(NVARCHAR(20), s.sampleTypeId), ', ')
    FROM @sids s
    WHERE NOT EXISTS (SELECT 1 FROM #groups g WHERE g.sampleTypeId = s.sampleTypeId);
    IF @extraTypes IS NOT NULL
    BEGIN
        SELECT ok = CAST(0 AS BIT), error_code = 'VALIDATION',
               message = CONCAT(N'Sample IDs supplied for unused sample type(s): ', @extraTypes),
               patient_id = NULL, bill_id = NULL, bill_number = NULL,
               total = @total, sample_count = 0;
        SELECT * FROM @emptySamples;
        RETURN;
    END

    /* sample_count reflects the rows actually being written now (the SIDs
       supplied that match a required group) — may be 0 for a deferred order. */
    SELECT @sampleCount = COUNT(*)
    FROM @sids s JOIN #groups g ON g.sampleTypeId = s.sampleTypeId;

    /* =================== the write ======================================= */
    /* OUTPUT cannot contain subqueries, so we capture identity only and
       enrich with the sample-type name from #groups in the final SELECT. */
    DECLARE @insertedSamples TABLE (
        sample_id INT, vailid NVARCHAR(50), sampleid_db INT
    );

    BEGIN TRY
        BEGIN TRAN;

        /* ⓪ resolve new Ref. doctor / customer names → master ids.
           Runs inside the order transaction so abandoned forms never
           pollute the master. Existing-id paths (positive @refDoctor /
           @refCustomer) are untouched. */
        IF @newRefDoctorName IS NOT NULL AND LTRIM(RTRIM(@newRefDoctorName)) <> N''
        BEGIN
            DECLARE @newDocId INT;
            EXEC dbo.usp_telo_upsert_doctor
                @name = @newRefDoctorName,
                @mcc = @mcc,
                @userId = @userId,
                @id = @newDocId OUTPUT;
            IF @newDocId IS NOT NULL SET @refDoctor = @newDocId;
        END
        IF @newRefCustomerName IS NOT NULL AND LTRIM(RTRIM(@newRefCustomerName)) <> N''
        BEGIN
            DECLARE @newCustId INT;
            EXEC dbo.usp_telo_upsert_customer
                @name = @newRefCustomerName,
                @mcc = @mcc,
                @userId = @userId,
                @id = @newCustId OUTPUT;
            IF @newCustId IS NOT NULL SET @refCustomer = @newCustId;
        END

        /* ① patient */
        IF @patientId IS NULL OR @patientId = 0
        BEGIN
            INSERT INTO dbo.tbl_med_mcc_patient_master
                (mcc_code, name, initial, age, gender, age_type, sample_date,
                 sample_time, ref_doctor, ref_customer, Status,
                 Clinical_History, mobile_number, order_number, email,
                 MRNID, addedby, addeddate)
            VALUES
                (@mcc, @name, @initialFinal, @age, @gender, @ageType,
                 CAST(GETDATE() AS DATE),
                 GETDATE(), @refDoctor, @refCustomer, 1,
                 @clinicalHistory, @mobile, '', @email,
                 @mrnId, CONCAT(@origin, @userId), GETDATE());
            SET @pid = SCOPE_IDENTITY();
            SET @pname = @name;

            /* Mirror the LIS order form: MRNID is never blank — when the form
               supplied none, it backfills the patient id. The report download
               path dereferences MRNID, so a NULL here is what crashed Telo
               reports. */
            IF @mrnId IS NULL OR LTRIM(RTRIM(@mrnId)) = ''
                UPDATE dbo.tbl_med_mcc_patient_master
                SET MRNID = CONVERT(VARCHAR(50), @pid)
                WHERE id = @pid;
        END
        ELSE
        BEGIN
            SELECT @pname = name FROM dbo.tbl_med_mcc_patient_master
            WHERE id = @patientId AND mcc_code = @mcc;
            IF @pname IS NULL
            BEGIN
                IF @@TRANCOUNT > 0 ROLLBACK;
                SELECT ok = CAST(0 AS BIT), error_code = 'OUT_OF_SCOPE',
                       message = N'Patient not found in this collection centre',
                       patient_id = NULL, bill_id = NULL, bill_number = NULL,
                       total = @total, sample_count = 0;
                SELECT * FROM @emptySamples;
                RETURN;
            END
            SET @pid = @patientId;
        END

        /* ①b optional clinical-history PDF — mirrors the LIS, which stores
           the attachment in tbl_med_mcc_patient_clinicaldata with the literal
           filetype tag 'HISTORY', keyed by patient_id. */
        IF @clinicalFile IS NOT NULL AND DATALENGTH(@clinicalFile) > 0
            INSERT INTO dbo.tbl_med_mcc_patient_clinicaldata
                (binary_data, filene, filetype, patient_id, ADDEDDATE)
            VALUES
                (@clinicalFile, LEFT(ISNULL(@clinicalFileName, N'clinical-history.pdf'), 100),
                 'HISTORY', @pid, GETDATE());

        /* ② per-test rows (one per user-selected line).
           amount_checked / updateddate are deliberately left NULL — the order
           is NOT a sale yet. The LIS bills it when an operator clicks
           "Register" on the Accession screen (CheckTransCash sets
           amount_checked + updateddate and debits the franchise wallet).
           test_type uses the LIS enum ('Profile'/'Test'/'Master') so
           CheckTransCash — which matches those exact strings — recognises
           Telo's tests. A master profile is ONE row (test_type='Master',
           test_code=Master_Profile_Code, test_id=master id) billed once; its
           children are expanded only into sample rows below.
           @lines.testtype stays 'p'/'t'/'m' for the billing line items. */
        INSERT INTO dbo.tbl_med_mcc_patient_tests
            (patient_id, test_id, test_code, test_name, test_rate,
             test_type, addedby, addeddate, mobile_number)
        SELECT @pid, l.testMasterId, l.code, l.name, l.rate,
               CASE l.testtype WHEN 'p' THEN 'Profile' WHEN 'm' THEN 'Master' ELSE 'Test' END,
               CONCAT(@origin, @userId), GETDATE(), LEFT(@mobile, 12)
        FROM @lines l;

        /* ③ sample rows — ONE per distinct sample type.
           testtypes is the per-code type CSV ('t'/'p'), positionally aligned
           with testcodes — the LIS CheckTransCash uses it to route each code
           to its Test/Profile bucket when the order is Registered. */
        INSERT INTO dbo.tbl_med_mcc_patient_samples
            (patient_id, sampleid, testcodes, testnames, testtypes,
             vailid, sample_status, addedby, addeddate, modifieddate,
             lastmodified_date, business_unit_id, mobile_number)
        OUTPUT inserted.id, inserted.vailid, inserted.sampleid
            INTO @insertedSamples (sample_id, vailid, sampleid_db)
        SELECT @pid,
               NULLIF(g.sampleTypeId, -1) AS sampleid,  -- store NULL for Unspecified
               LEFT(g.csvCodes, 1000),
               LEFT(g.csvNames, 1000),
               LEFT(g.csvTypes, 500),
               s.vailid, 1, CONCAT(@origin, @userId), GETDATE(), GETDATE(),
               GETDATE(), @buCode, LEFT(@mobile, 12)
        FROM #groups g
        JOIN @sids s ON s.sampleTypeId = g.sampleTypeId;

        /* ④ bill header */
        EXEC dbo.usp_telo_next_bill_number
            @mcc = @mcc, @bill_number = @billNo OUTPUT,
            @ok = @o OUTPUT, @error_code = @ec OUTPUT;
        IF @o <> 1
        BEGIN
            IF @@TRANCOUNT > 0 ROLLBACK;
            SELECT ok = CAST(0 AS BIT), error_code = ISNULL(@ec,'INTERNAL'),
                   message = N'Could not reserve bill number',
                   patient_id = @pid, bill_id = NULL, bill_number = NULL,
                   total = @total, sample_count = @sampleCount;
            SELECT * FROM @emptySamples;
            RETURN;
        END

        /* ---- payment lines: prefer the @payments TVP (split payments);
           fall back to the legacy single scalar set for older callers. ----- */
        DECLARE @pay TABLE (
            seq    INT IDENTITY(1,1),
            method VARCHAR(50),
            amount INT,
            ref    NVARCHAR(50)
        );
        IF EXISTS (SELECT 1 FROM @payments)
            INSERT INTO @pay (method, amount, ref)
            SELECT COALESCE(NULLIF(LTRIM(RTRIM(method)), ''), 'Cash'),
                   amount,
                   NULLIF(LTRIM(RTRIM(ref)), N'')
            FROM @payments
            WHERE ISNULL(amount, 0) > 0;
        ELSE IF ISNULL(@receiptAmount, 0) > 0
            INSERT INTO @pay (method, amount, ref)
            VALUES (@paymentType, @receiptAmount, NULLIF(LTRIM(RTRIM(@paymentRef)), N''));

        DECLARE @paidTotal INT = (SELECT ISNULL(SUM(amount), 0) FROM @pay);
        DECLARE @methodCount INT = (SELECT COUNT(DISTINCT method) FROM @pay);
        /* The bill header has a single payment_type column the legacy LIS
           reads. Show the real method when one was used, 'Mixed' when the
           patient split across methods, else the legacy scalar (NULL when
           nothing was collected). Each individual receipt row below keeps its
           own real method. */
        DECLARE @headerPayType VARCHAR(50) =
            CASE WHEN @paidTotal = 0   THEN @paymentType
                 WHEN @methodCount > 1 THEN 'Mixed'
                 ELSE (SELECT TOP 1 method FROM @pay ORDER BY seq) END;

        DECLARE @balance INT = @total - ISNULL(@discountAmount,0) - @paidTotal;

        INSERT INTO dbo.tbl_billing_patient_detail
            (bill_number, bill_date, mcc_code, patientname, age, gender,
             medid, amount, discount_amount, amount_paid, Balance, payment_type,
             paymode, ref_doctor, ref_customer, mobile_number, email,
             age_type, noofpatients, addedby, addeddate)
        VALUES
            -- medid carries the patient_id for Telo orders so getOrder can
            -- join bill → patient → samples deterministically (medid is the
            -- LIS schema field for medical-record id; we repurpose it).
            (@billNo, GETDATE(), @mcc, LEFT(@pname,100), @age, @gender,
             CONVERT(VARCHAR(50), @pid),
             @total, ISNULL(@discountAmount,0), @paidTotal,
             @balance, @headerPayType, @payMode, @refDoctor, @refCustomer,
             LEFT(@mobile,10), LEFT(@email,50),
             CONVERT(VARCHAR(10), @ageType), 1,
             CONCAT(@origin, @userId), GETDATE());
        SET @billId = SCOPE_IDENTITY();

        /* Gold Card sidecar (Telo-level): records which card slashed this bill
           by 50%. One row per bill (unique index on bill_id). */
        IF @goldApplied = 1
            INSERT INTO dbo.telo_gold_card
                (bill_id, card_number, card_holder, discount_pct, created_by)
            VALUES
                (@billId,
                 LEFT(LTRIM(RTRIM(@goldCardNumber)), 50),
                 LEFT(LTRIM(RTRIM(@goldCardHolder)), 200),
                 50, CONCAT(@origin, @userId));

        /* ⑤ billing line items */
        INSERT INTO dbo.tbl_billing_patient_test_detail
            (billid, mcccode, testcode, testname, testamount, testtype)
        SELECT @billId, @mcc, LEFT(l.code,10), l.name, l.rate, l.testtype
        FROM @lines l;

        /* ⑤b Telo-only custom lines — a billing line ONLY (no LIS test/sample
           row was ever written for them). One row per custom line; the amount is
           unitAmount × qty and the name carries the count so the bill reads e.g.
           "Glucose - External ×3". testtype 't' keeps it a plain billing line
           for the invoice reader (it is not, and must not resolve to, an LIS
           test). */
        IF EXISTS (SELECT 1 FROM @customLines)
        BEGIN
            INSERT INTO dbo.tbl_billing_patient_test_detail
                (billid, mcccode, testcode, testname, testamount, testtype)
            SELECT @billId, @mcc, LEFT(c.code,10),
                   LEFT(CASE WHEN c.qty > 1 THEN CONCAT(c.name, N' x', c.qty) ELSE c.name END, 200),
                   c.unitAmount * c.qty, 't'
            FROM @customLines c;

            /* Traceability log: keeps these billed-but-not-performed charges
               queryable (with the MRD snapshot) without ever touching the LIS
               test tables. */
            INSERT INTO dbo.telo_custom_test_order
                (bill_id, patient_id, custom_test_id, code, name,
                 unit_amount, qty, mrd, mcc_code, created_by)
            SELECT @billId, @pid, c.customTestId, c.code, c.name,
                   c.unitAmount, c.qty,
                   NULLIF(LTRIM(RTRIM(@mrdText)), N''), @mcc,
                   CONCAT(@origin, @userId)
            FROM @customLines c;

            /* ⑤c A custom-only order has nothing to accession, so its
               extras are charged to the centre's account NOW, the way a
               registered sample charges its tests; an order with tests is
               charged when its first sample is registered (④b in
               usp_telo_accession_samples). Until 2026-09-21 neither
               happened: 111 such lines were billed and never charged. */
            IF NOT EXISTS (SELECT 1 FROM @items)
                EXEC dbo.usp_telo_charge_custom_lines
                     @userId = @userId, @patientId = @pid, @origin = @origin;
        END

        /* ⑥ receipts — ONE row per payment line (split payments supported:
           e.g. ₹500 Cash + ₹500 UPI = two receipt rows). Each receipt mints
           its own telo_txn id. */
        SET @txn = NULL;
        IF EXISTS (SELECT 1 FROM @pay)
        BEGIN
            -- card_number holds the operator-entered payment reference (UPI ref,
            -- cheque no., card auth code) for non-cash payments — same column the
            -- offline "record receipt" flow uses, so the ledger surfaces it.
            -- card_number is varchar(50); the ref is already trimmed to 50 in
            -- @pay, LEFT() again as belt-and-braces so a long ref can never
            -- throw a truncation error and fail the whole order.
            DECLARE @newReceipts TABLE (rid INT);
            INSERT INTO dbo.tbl_billing_patient_amount_receipt
                (bill_id, recd_date, amount, receivedby, receive_status, pay_mode,
                 card_number)
            OUTPUT inserted.id INTO @newReceipts (rid)
            SELECT @billId, GETDATE(), p.amount,
                   CONCAT(@origin, @userId), '1', p.method,
                   LEFT(p.ref, 50)
            FROM @pay p;

            -- One unique txn id per receipt. NEXT VALUE FOR in an INSERT…SELECT
            -- yields a distinct sequence value for each row.
            INSERT INTO dbo.telo_txn (receipt_id, bill_id, txn_id)
            SELECT nr.rid, @billId,
                   CONCAT(N'TXN',
                          RIGHT(CONCAT(N'00000000',
                                       CONVERT(VARCHAR(20), NEXT VALUE FOR dbo.telo_txn_seq)), 8))
            FROM @newReceipts nr;

            -- Status row returns the first txn id (preserves the prior single
            -- -receipt contract for callers that read txn_id).
            SELECT TOP 1 @txn = txn_id FROM dbo.telo_txn
            WHERE bill_id = @billId ORDER BY receipt_id;
        END

        /* NO franchise-wallet posting here. The LIS debits the franchise
           account when the order is moved Accessioning → Worksheet via the
           Accession screen's "Register" button (CheckTransCash). Posting it
           here too would double-debit. The bill header / line items / receipt
           above are Telo-internal records and are invisible to the LIS
           sales/ledger reports. */

        /* Tag B2B orders (billed at MRP) so the B2B worklist can list its own
           order type separately from New orders. Telo sidecar; regular orders
           stay untagged and are treated as 'new'. */
        IF @billAtMrp = 1
            INSERT INTO dbo.telo_order_kind (bill_id, kind) VALUES (@billId, N'b2b');

        COMMIT;

        SELECT ok = CAST(1 AS BIT), error_code = CAST(NULL AS VARCHAR(20)),
               message = CAST(NULL AS NVARCHAR(400)),
               patient_id = @pid, bill_id = @billId, bill_number = @billNo,
               total = @total, sample_count = @sampleCount, txn_id = @txn;
        SELECT
            ins.sample_id,
            ins.vailid,
            sids.sampleTypeId AS sample_type_id,
            ISNULL(g.sampleTypeName, N'Unspecified') AS sample_type_name
        FROM @insertedSamples ins
        JOIN @sids sids ON sids.vailid = ins.vailid
        LEFT JOIN #groups g ON g.sampleTypeId = sids.sampleTypeId
        ORDER BY sids.sampleTypeId;
    END TRY
    BEGIN CATCH
        IF @@TRANCOUNT > 0 ROLLBACK;
        DECLARE @msg NVARCHAR(2048) = ERROR_MESSAGE();
        DECLARE @code VARCHAR(20) =
            CASE WHEN @msg LIKE '%DUPLICATES PREVENTED%' THEN 'CONFLICT'
                 ELSE 'INTERNAL' END;
        SELECT ok = CAST(0 AS BIT), error_code = @code,
               message = LEFT(@msg, 400),
               patient_id = CAST(NULL AS INT),
               bill_id = CAST(NULL AS INT),
               bill_number = CAST(NULL AS INT),
               total = @total, sample_count = 0;
        SELECT * FROM @emptySamples;
    END CATCH
END
GO
