/*
 * Is this barcode already used?
 *
 * The order form now collects Sample IDs at booking time, and a barcode that is
 * already on another tube is the one mistake worth catching before the operator
 * finishes typing the patient. Without this the first they hear of it is the
 * create procedure rejecting the whole order.
 *
 * ── WHY THIS IS NOT SCOPED TO THE CALLER'S CENTRES ─────────────────────────
 * Telo's equivalent read offers both a global and a scoped variant, and its own
 * comment recommends the scoped one so that a signed-in user cannot probe for
 * sample IDs belonging to centres they do not own. That reasoning is sound for
 * a read that RETURNS data. It is the wrong trade here, because the constraint
 * this check is predicting is global: vailid is unique across the whole LIS and
 * trigger_PreventDuplicate enforces it regardless of who owns the row. A scoped
 * check would answer "available" for a barcode used by another centre, the
 * operator would get a green light, and the order would then be rejected at
 * submit. A check that is wrong in exactly the case it exists to catch is worse
 * than no check, because it converts a caught error into a trusted one.
 *
 * So this returns a single bit and nothing else — no patient, no centre, no
 * date. It confirms a collision the caller is about to cause; it does not
 * describe it. Enumeration costs one authenticated request per candidate
 * barcode and yields one bit each, which is a poor oracle and a fair price for
 * feedback that is actually correct.
 *
 * ADVISORY ONLY. The create procedure and the trigger remain the guarantee — a
 * race between two open forms still ends in a clean rejection at write time.
 *
 * @vailid is NVARCHAR(50) to match the column exactly. Widening it to NVARCHAR
 * (MAX) or narrowing to VARCHAR would make the predicate non-sargable and turn
 * a seek on IX_patient_samples_vailid into a scan of every sample ever taken.
 */
CREATE OR ALTER PROCEDURE dbo.usp_inf_sid_taken
    @vailid NVARCHAR(50)
AS
BEGIN
    SET NOCOUNT ON;
    SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;

    DECLARE @v NVARCHAR(50) = NULLIF(LTRIM(RTRIM(@vailid)), N'');

    -- Blank is not taken. The caller does not ask about blanks, but answering
    -- "taken" for one would be a confusing way to fail.
    SELECT taken =
        CASE WHEN @v IS NOT NULL
              AND EXISTS (SELECT 1
                          FROM dbo.tbl_med_mcc_patient_samples s
                          WHERE s.vailid = @v)
             THEN CAST(1 AS BIT) ELSE CAST(0 AS BIT) END;
END
GO
