/*
 * 143_usp_inf_report_mark_printed.sql
 *
 * A report download marks the sample Printed — the legacy LIS's
 * ChangeSampleStatus (MedCis.Business/Pcc/WorksheetClass.cs:2405), ported as
 * an AUDITED state transition rather than a side effect of rendering.
 *
 * What the legacy does, verified in its source:
 *   • Fires on the explicit "With Header" / "Without Header" click on
 *     Pcc/WebForm2.aspx — the click IS the PDF download. Merely viewing the
 *     report does nothing; the QR copy (g.aspx) and the e-mail button do
 *     nothing. Lab side and client portal share the page, so both mark.
 *   • 6 (Partially Authorised) → 8 (Partially Printed); 7 (Authorised) → 9
 *     (Printed); 8 stays 8; everything else (1–5, 9, 10) is untouched. There
 *     is no print count, no print date and no modifiedby/modifieddate touch.
 *   • Writes one TBL_MED_USER_ACTIVITY_LOG row, "Printed <from>-<to>", with
 *     the user and the SID (or the PID for a patient-level print) — and no IP.
 *   • Marks BEFORE the export runs, so a failed export still marks.
 *
 * What this procedure does differently, and why:
 *   • The API calls it AFTER the PDF bytes are in hand (rendered or served
 *     from cache), so a failed render never marks — contract G16.
 *   • The transition is written to inf_result_audit (action 'status', field
 *     'status', old → new, actor, IP, agent, origin), so the sample's history
 *     tab and the audit feed both show who took the report out and when —
 *     with the download channel in `reason` for the reader. The download
 *     itself (report.pdf, with role and paper) goes to inf_audit_log from the
 *     API, every time, transition or not.
 *   • modifieddate is deliberately NOT touched: the worksheet and reporting
 *     lists window on it, and a download must not move a sample between
 *     days. lastmodified_date is stamped, as usp_inf_result_save stamps it.
 *   • Idempotent and race-safe: the sample row is read under UPDLOCK, so two
 *     downloads at once produce one transition and one audit row.
 *
 * Caller: ReportPrintRepository.MarkPrintedAsync, from the single-SID and
 * bulk PDF routes. Returns status_before / status_after (NULL, NULL for an
 * unknown SID).
 */
CREATE OR ALTER PROCEDURE dbo.usp_inf_report_mark_printed
    @sid             NVARCHAR(50),
    @actor_user_id   INT,
    @actor_username  NVARCHAR(100) = NULL,
    @actor_ip        NVARCHAR(64)  = NULL,
    @actor_agent     NVARCHAR(400) = NULL,
    @channel         VARCHAR(20)   = 'pdf'    -- 'pdf' (single) | 'bulk' (merged / PID)
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE @origin NVARCHAR(50) = CONCAT(N'inf:', @actor_user_id);
    DECLARE @sample_id INT, @patient_id INT, @before INT, @after INT;

    BEGIN TRANSACTION;

    -- Newest wins on a duplicated SID, as the report lookup (77) resolves it.
    SELECT TOP (1)
           @sample_id  = s.id,
           @patient_id = s.patient_id,
           @before     = s.sample_status
    FROM dbo.tbl_med_mcc_patient_samples s WITH (UPDLOCK, ROWLOCK)
    WHERE s.vailid = @sid
    ORDER BY s.id DESC;

    IF @sample_id IS NULL
    BEGIN
        ROLLBACK TRANSACTION;
        SELECT CONVERT(INT, NULL) AS status_before, CONVERT(INT, NULL) AS status_after;
        RETURN;
    END

    SET @after = CASE @before
                     WHEN 6 THEN 8     -- Partially Authorised → Partially Printed
                     WHEN 7 THEN 9     -- Authorised → Printed
                     ELSE @before      -- 8 and 9 stay; nothing else is a report
                 END;

    IF @after <> @before
    BEGIN
        UPDATE dbo.tbl_med_mcc_patient_samples
        SET sample_status     = @after,
            lastmodified_date = GETDATE()
        WHERE id = @sample_id;

        INSERT INTO dbo.inf_result_audit
            (result_id, vailid, patient_id, action, field, old_value, new_value, reason,
             actor_user_id, actor_username, actor_ip, actor_user_agent, source, origin)
        VALUES
            (NULL, @sid, @patient_id, 'status', 'status',
             CONVERT(NVARCHAR(10), @before), CONVERT(NVARCHAR(10), @after),
             CONCAT('Report downloaded (', @channel, ')'),
             @actor_user_id, @actor_username, @actor_ip, @actor_agent, 'ui', @origin);
    END

    COMMIT TRANSACTION;

    SELECT @before AS status_before, @after AS status_after;
END
GO
