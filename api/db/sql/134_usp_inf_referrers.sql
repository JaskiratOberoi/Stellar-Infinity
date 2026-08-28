/*
 * 134_usp_inf_referrers.sql — referrer roster management, on the LIS's own
 * master tables.
 *
 * The rosters are ALIVE in the LIS — 800 doctors created in the last year,
 * one this morning — and they are per-centre: the misleadingly named
 * pcc_code on tbl_med_mcc_doctors / tbl_med_mcc_customer is the owning
 * tbl_med_mcc_unit_master.id. The legacy management screens (Pcc/Doctors.aspx,
 * Pcc/Customers.aspx) kept exactly four live fields — code, name, centre,
 * active — with everything else commented out years ago, so that is the
 * surface these procedures manage. Rows written here are indistinguishable
 * from rows the legacy screens write, and both platforms keep working off the
 * same roster. Same doctrine as MRF.
 *
 * NO DELETE, deliberately. The legacy screen hard-deletes, which throws on
 * any referrer with billing history and swallows the error into a generic
 * message; deactivation is the operation that actually works, so it is the
 * only one offered.
 */
SET QUOTED_IDENTIFIER ON;
SET ANSI_NULLS ON;
GO

/*
 * Both rosters for one centre, INCLUDING inactive rows — a management screen
 * that hides what it deactivated cannot reactivate it.
 */
CREATE OR ALTER PROCEDURE dbo.usp_inf_referrer_list
    @mcc INT
AS
BEGIN
    SET NOCOUNT ON;

    SELECT d.id,
           LTRIM(RTRIM(ISNULL(d.doctor_code, '')))  AS code,
           LTRIM(RTRIM(ISNULL(d.doctor_name, '')))  AS name,
           CAST(ISNULL(d.IsActive, 1) AS BIT)       AS is_active,
           d.createddate                            AS created_at,
           d.createdby                              AS created_by
    FROM dbo.tbl_med_mcc_doctors d
    WHERE d.pcc_code = @mcc
    ORDER BY d.doctor_name;

    SELECT c.id,
           LTRIM(RTRIM(ISNULL(c.customer_code, ''))) AS code,
           LTRIM(RTRIM(ISNULL(c.customer_name, ''))) AS name,
           CAST(ISNULL(c.IsActive, 1) AS BIT)        AS is_active,
           c.createddate                             AS created_at,
           c.createdby                               AS created_by
    FROM dbo.tbl_med_mcc_customer c
    WHERE c.pcc_code = @mcc
    ORDER BY c.customer_name;
END
GO

/*
 * Create or update one referrer. @id NULL creates; otherwise the row must
 * already belong to @mcc — the centre guard lives here at the data level, so
 * no API mistake can move a doctor between centres or edit another centre's
 * row.
 *
 * Column truths (live schema): doctor_code / customer_code are nvarchar(50),
 * doctor_name / customer_name nvarchar(100) — the legacy screen let 100-char
 * codes at a 50-char column; this one refuses instead of truncating.
 */
CREATE OR ALTER PROCEDURE dbo.usp_inf_referrer_save
    @kind   VARCHAR(10),          -- 'doctor' | 'customer'
    @id     INT = NULL,           -- NULL = create
    @mcc    INT,
    @code   NVARCHAR(100),
    @name   NVARCHAR(200),
    @active BIT,
    @actor  INT
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    SET @code = LTRIM(RTRIM(ISNULL(@code, '')));
    SET @name = LTRIM(RTRIM(ISNULL(@name, '')));

    IF @kind NOT IN ('doctor', 'customer')
    BEGIN
        SELECT ok = CAST(0 AS BIT), error_code = 'BAD_KIND',
               message = N'kind must be doctor or customer.', id = CAST(NULL AS INT);
        RETURN;
    END
    IF @name = N''
    BEGIN
        SELECT ok = CAST(0 AS BIT), error_code = 'NO_NAME',
               message = N'A name is required.', id = CAST(NULL AS INT);
        RETURN;
    END
    IF LEN(@name) > 100
    BEGIN
        SELECT ok = CAST(0 AS BIT), error_code = 'NAME_LONG',
               message = N'The name can be at most 100 characters.', id = CAST(NULL AS INT);
        RETURN;
    END
    IF LEN(@code) > 50
    BEGIN
        SELECT ok = CAST(0 AS BIT), error_code = 'CODE_LONG',
               message = N'The code can be at most 50 characters.', id = CAST(NULL AS INT);
        RETURN;
    END
    IF NOT EXISTS (SELECT 1 FROM dbo.tbl_med_mcc_unit_master u WHERE u.id = @mcc)
    BEGIN
        SELECT ok = CAST(0 AS BIT), error_code = 'NO_CENTRE',
               message = N'Unknown collection centre.', id = CAST(NULL AS INT);
        RETURN;
    END

    /*
     * A blank code gets one minted the way Telo's order-time upsert mints
     * them, so every row stays searchable by code whichever door it came in:
     * {MCCUnitCode}-INF-{initials}.
     */
    IF @code = N''
    BEGIN
        DECLARE @unit NVARCHAR(50) =
            (SELECT TOP 1 MCCUnitCode FROM dbo.tbl_med_mcc_unit_master WHERE id = @mcc);
        DECLARE @initials NVARCHAR(10) = N'', @i INT = 1, @word NVARCHAR(100);
        DECLARE @sp INT;
        -- First letter of up to three words of the name.
        DECLARE @rest NVARCHAR(200) = @name;
        WHILE @i <= 3 AND LEN(@rest) > 0
        BEGIN
            SET @word = LEFT(@rest, 1);
            IF @word LIKE N'[A-Za-z]' SET @initials = @initials + UPPER(@word);
            SET @sp = CHARINDEX(N' ', @rest);
            IF @sp = 0 BREAK;
            SET @rest = LTRIM(SUBSTRING(@rest, @sp + 1, 200));
            SET @i = @i + 1;
        END
        SET @code = LEFT(CONCAT(@unit, N'-INF-', @initials), 50);
    END

    DECLARE @by NVARCHAR(100) = CONCAT(N'inf:', @actor);
    DECLARE @now DATETIME = GETDATE();
    DECLARE @outId INT = @id;

    IF @kind = 'doctor'
    BEGIN
        IF @id IS NULL
        BEGIN
            INSERT INTO dbo.tbl_med_mcc_doctors
                (doctor_code, doctor_name, pcc_code, IsActive, country, createdby, createddate)
            VALUES (@code, @name, @mcc, @active, N'India', @by, @now);
            SET @outId = SCOPE_IDENTITY();
        END
        ELSE
        BEGIN
            UPDATE dbo.tbl_med_mcc_doctors
            SET doctor_code = @code, doctor_name = @name, IsActive = @active,
                updatedby = @by, updatedDate = @now
            WHERE id = @id AND pcc_code = @mcc;
            IF @@ROWCOUNT = 0
            BEGIN
                SELECT ok = CAST(0 AS BIT), error_code = 'NOT_FOUND',
                       message = N'No such doctor at this centre.', id = CAST(NULL AS INT);
                RETURN;
            END
        END
    END
    ELSE
    BEGIN
        IF @id IS NULL
        BEGIN
            INSERT INTO dbo.tbl_med_mcc_customer
                (customer_code, customer_name, pcc_code, IsActive, country, createdby, createddate)
            VALUES (@code, @name, @mcc, @active, N'India', @by, @now);
            SET @outId = SCOPE_IDENTITY();
        END
        ELSE
        BEGIN
            UPDATE dbo.tbl_med_mcc_customer
            SET customer_code = @code, customer_name = @name, IsActive = @active,
                updatedby = @by, updatedDate = @now
            WHERE id = @id AND pcc_code = @mcc;
            IF @@ROWCOUNT = 0
            BEGIN
                SELECT ok = CAST(0 AS BIT), error_code = 'NOT_FOUND',
                       message = N'No such customer at this centre.', id = CAST(NULL AS INT);
                RETURN;
            END
        END
    END

    SELECT ok = CAST(1 AS BIT), error_code = CAST(NULL AS VARCHAR(20)),
           message = CAST(NULL AS NVARCHAR(200)), id = @outId;
END
GO

/*
 * Referrer-wise business for one centre and window — the live half of the
 * LIS's "Doctor Referred Amount" screen (menu 57) plus Telo's top-referrers
 * rollup, in one call. Bills carry only the master IDs (free-text referrers
 * are dropped at billing by the LIS itself), so this is exactly the set the
 * legacy report could see. The no-referrer bucket is included: on some
 * centres most bills name nobody, and hiding that row would make the named
 * rows read as the whole business.
 */
CREATE OR ALTER PROCEDURE dbo.usp_inf_referrer_stats
    @mcc  INT,
    @from DATE,
    @to   DATE
AS
BEGIN
    SET NOCOUNT ON;

    SELECT
        d.id,
        name = COALESCE(d.doctor_name, N'No referring doctor'),
        bills = COUNT(*),
        charges = ISNULL(SUM(b.amount), 0)
    FROM dbo.tbl_billing_patient_detail b
    LEFT JOIN dbo.tbl_med_mcc_doctors d ON d.id = b.ref_doctor
    WHERE b.mcc_code = @mcc
      AND b.bill_date >= CAST(@from AS DATE)
      AND b.bill_date <  DATEADD(DAY, 1, CAST(@to AS DATE))
    GROUP BY d.id, d.doctor_name
    ORDER BY SUM(b.amount) DESC;

    SELECT
        c.id,
        name = COALESCE(c.customer_name, N'No referring customer'),
        bills = COUNT(*),
        charges = ISNULL(SUM(b.amount), 0)
    FROM dbo.tbl_billing_patient_detail b
    LEFT JOIN dbo.tbl_med_mcc_customer c ON c.id = b.ref_customer
    WHERE b.mcc_code = @mcc
      AND b.bill_date >= CAST(@from AS DATE)
      AND b.bill_date <  DATEADD(DAY, 1, CAST(@to AS DATE))
    GROUP BY c.id, c.customer_name
    ORDER BY SUM(b.amount) DESC;
END
GO
