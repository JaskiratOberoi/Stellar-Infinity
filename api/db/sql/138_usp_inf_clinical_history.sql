/* =============================================================================
 * Per-sample clinical-history PDF, attached AFTER the order exists.
 *
 * The LIS's Sample Status screen (Pcc/SampleStatus.aspx) lets a collection
 * centre attach a clinical-history PDF to a sample it already sent; the lab
 * tech opens it from the worksheet (Worksheet/clihis.ashx?id=<sid>). Storage
 * is dbo.tbl_med_mcc_patient_clinicaldata with
 *
 *     filene   = the SID  (yes — the FILENAME column holds the sample id)
 *     filetype = 'HISTORY'
 *     binary_data, patient_id, ADDEDDATE
 *
 * ── QUIRK #27, DO NOT WIDEN THESE PREDICATES ──────────────────────────────
 * The same table stores report QR codes with the two columns SWAPPED:
 * filene = 'QRCODE', filetype = <sid>. Every statement here must key on
 * filene = @sid AND filetype = 'HISTORY' exactly, or it will read or delete
 * QR rows. (The order form's own PDF goes in patient-keyed with the original
 * FILENAME in filene — usp_telo_create_order ①b — and is untouched here.)
 *
 * Replace = delete-then-insert inside one transaction, exactly what the LIS
 * screen does with its "delete previous file" box ticked, minus the step
 * where the operator can forget to tick it.
 * ========================================================================== */

SET QUOTED_IDENTIFIER ON;
GO

CREATE OR ALTER PROCEDURE dbo.usp_inf_clinical_history_set
    @sid   NVARCHAR(50),
    @pdf   VARBINARY(MAX),
    @actor INT
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE @patientId INT, @status INT;
    SELECT TOP 1 @patientId = patient_id, @status = sample_status
    FROM dbo.tbl_med_mcc_patient_samples
    WHERE vailid = @sid ORDER BY id DESC;

    IF @patientId IS NULL
    BEGIN
        SELECT ok = CAST(0 AS BIT), error = N'Unknown sample.';
        RETURN;
    END

    /* The LIS locks a sample once its report is signed out —
       WorksheetClass.CheckSampleEnable refuses status 7 (Authorised) and 9
       (Printed). 8 (Partially Printed) sits BETWEEN those two in the flow and
       its omission there is a gap, not a rule, so the whole authorised-and-
       beyond set closes the history here: what a signatory signed against
       must not change under them. */
    IF @status IN (7, 8, 9)
    BEGIN
        SELECT ok = CAST(0 AS BIT),
               error = N'This sample''s report is authorised — the clinical history is closed.';
        RETURN;
    END

    IF @pdf IS NULL OR DATALENGTH(@pdf) = 0
    BEGIN
        SELECT ok = CAST(0 AS BIT), error = N'The file is empty.';
        RETURN;
    END

    BEGIN TRAN;

    DELETE FROM dbo.tbl_med_mcc_patient_clinicaldata
    WHERE filene = @sid AND filetype = 'HISTORY';

    INSERT INTO dbo.tbl_med_mcc_patient_clinicaldata
        (binary_data, filene, filetype, patient_id, ADDEDDATE)
    VALUES
        (@pdf, @sid, 'HISTORY', @patientId, GETDATE());

    COMMIT TRAN;

    SELECT ok = CAST(1 AS BIT), error = CAST(NULL AS NVARCHAR(100));
END
GO

CREATE OR ALTER PROCEDURE dbo.usp_inf_clinical_history_delete
    @sid   NVARCHAR(50),
    @actor INT
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    -- Same lock as the set: once the report is signed out, the history it was
    -- signed against stays put.
    IF EXISTS (SELECT 1 FROM dbo.tbl_med_mcc_patient_samples
               WHERE vailid = @sid AND sample_status IN (7, 8, 9))
    BEGIN
        SELECT ok = CAST(0 AS BIT),
               error = N'This sample''s report is authorised — the clinical history is closed.';
        RETURN;
    END

    DELETE FROM dbo.tbl_med_mcc_patient_clinicaldata
    WHERE filene = @sid AND filetype = 'HISTORY';

    SELECT ok = CAST(1 AS BIT), error = CAST(NULL AS NVARCHAR(200));
END
GO
