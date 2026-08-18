SET QUOTED_IDENTIFIER ON;
GO
/*
 * 119_table_inf_patient_dob.sql
 *
 * A date of birth for a patient — which the LIS does not keep.
 *
 * ---------------------------------------------------------------------------
 * WHY A SIDECAR
 *
 * tbl_med_mcc_patient_master stores `age` and `age_type` (years / months /
 * days) and nothing else about when a patient was born. The order form has
 * always asked for a date of birth, but only to DERIVE that age; the date
 * itself was thrown away at submit. There is no column in the LIS to put it in,
 * and adding one to a table the live LIS and Listec also write would be a
 * schema change to a shared production object for a field only Infinity fills.
 *
 * So the DOB lives here, in an Infinity-owned sidecar keyed by the LIS patient
 * id, exactly as the other inf_* / telo_* sidecars do. The report reads it with
 * a LEFT JOIN and shows it when present; a patient booked before this existed
 * simply has no row, and the report prints without a DOB — the same way it
 * already handles a passport nobody entered.
 *
 * Additive and safe: a new table plus one upsert procedure. Nothing existing
 * reads or writes it until the code that does ships.
 * ---------------------------------------------------------------------------
 */

IF OBJECT_ID('dbo.inf_patient_dob', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.inf_patient_dob
    (
        -- The LIS patient id (tbl_med_mcc_patient_master.id). One DOB per
        -- patient, so the id is the whole key.
        patient_id  INT           NOT NULL
            CONSTRAINT PK_inf_patient_dob PRIMARY KEY,
        dob         DATE          NOT NULL,
        updated_at  DATETIME2(0)  NOT NULL
            CONSTRAINT DF_inf_patient_dob_updated DEFAULT SYSUTCDATETIME(),
        -- 'inf:<userId>', the same origin marker the rest of Infinity stamps,
        -- so a DOB can be traced to the account that captured it.
        updated_by  NVARCHAR(100) NULL
    );
END
GO

/*
 * Upsert one patient's DOB.
 *
 * Called after an order is created, once usp_telo_create_order has returned the
 * patient id. Newest wins — a patient correcting their DOB on a later visit
 * overwrites the old one. A NULL date is a no-op rather than a delete: "no date
 * entered this time" must not erase a date captured earlier.
 */
CREATE OR ALTER PROCEDURE dbo.usp_inf_set_patient_dob
    @patient_id INT,
    @dob        DATE,
    @actor      NVARCHAR(100) = NULL
AS
BEGIN
    SET NOCOUNT ON;

    IF @patient_id IS NULL OR @patient_id <= 0 OR @dob IS NULL
        RETURN;

    MERGE dbo.inf_patient_dob AS t
    USING (SELECT @patient_id AS patient_id) AS s
        ON t.patient_id = s.patient_id
    WHEN MATCHED THEN
        UPDATE SET dob = @dob, updated_at = SYSUTCDATETIME(), updated_by = @actor
    WHEN NOT MATCHED THEN
        INSERT (patient_id, dob, updated_by) VALUES (@patient_id, @dob, @actor);
END
GO
