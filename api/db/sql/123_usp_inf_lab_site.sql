/* QUOTED_IDENTIFIER is baked in at creation time; see script 70. */
SET QUOTED_IDENTIFIER ON;
GO
/*
 * 123_usp_inf_lab_site.sql
 *
 * Lab-site registry management and the lookup the site authenticator uses.
 * Mirrors the instrument procedures in script 73: same ok/error_code/message
 * envelope, same "NULL hash means keep the current key" rotation contract.
 */

-- ---------------------------------------------------------------- upsert ----
CREATE OR ALTER PROCEDURE dbo.usp_inf_lab_site_upsert
    @id               INT           = NULL,   -- NULL = create
    @code             NVARCHAR(20),
    @name             NVARCHAR(200),
    @location         NVARCHAR(200) = NULL,
    @business_unit_id INT           = NULL,
    @is_active        BIT           = 1,
    @api_key_hash     NVARCHAR(200) = NULL,   -- NULL leaves an existing key alone
    @api_key_hint     NVARCHAR(8)   = NULL,
    @actor_user_id    INT
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE @clean NVARCHAR(20) = LTRIM(RTRIM(ISNULL(@code, N'')));

    IF @clean = N'' OR @name IS NULL OR LTRIM(RTRIM(@name)) = N''
    BEGIN
        SELECT ok = CAST(0 AS BIT), error_code = 'VALIDATION',
               message = N'A code and name are required.';
        RETURN;
    END

    IF @business_unit_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM dbo.tbl_med_business_unit_master WHERE id = @business_unit_id)
    BEGIN
        SELECT ok = CAST(0 AS BIT), error_code = 'VALIDATION',
               message = N'Unknown business unit.';
        RETURN;
    END

    IF @id IS NULL AND @api_key_hash IS NULL
    BEGIN
        SELECT ok = CAST(0 AS BIT), error_code = 'VALIDATION',
               message = N'A new site needs an API key.';
        RETURN;
    END

    IF @id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM dbo.inf_lab_site WHERE id = @id)
    BEGIN
        SELECT ok = CAST(0 AS BIT), error_code = 'VALIDATION',
               message = N'No such site.';
        RETURN;
    END

    -- The code is the credential's public half; two sites sharing one would
    -- make the key lookup ambiguous. Checked here for a readable message; the
    -- unique constraint remains the real guarantee under a race.
    IF EXISTS (SELECT 1 FROM dbo.inf_lab_site WHERE code = @clean AND (@id IS NULL OR id <> @id))
    BEGIN
        SELECT ok = CAST(0 AS BIT), error_code = 'VALIDATION',
               message = N'That site code is already in use.';
        RETURN;
    END

    BEGIN TRY
        IF @id IS NULL
        BEGIN
            INSERT INTO dbo.inf_lab_site
                (code, name, location, business_unit_id, api_key_hash, api_key_hint, is_active, created_by)
            VALUES
                (@clean, @name, @location, @business_unit_id, @api_key_hash, @api_key_hint, @is_active, @actor_user_id);
            SET @id = SCOPE_IDENTITY();
        END
        ELSE
        BEGIN
            UPDATE dbo.inf_lab_site
            SET code             = @clean,
                name             = @name,
                location         = @location,
                business_unit_id = @business_unit_id,
                -- A null hash means "keep the current key"; rotation is explicit.
                api_key_hash     = ISNULL(@api_key_hash, api_key_hash),
                api_key_hint     = CASE WHEN @api_key_hash IS NULL THEN api_key_hint ELSE @api_key_hint END,
                is_active        = @is_active
            WHERE id = @id;
        END

        SELECT ok = CAST(1 AS BIT), error_code = CAST(NULL AS VARCHAR(20)),
               message = CAST(NULL AS NVARCHAR(200)),
               s.id, s.code, s.name, s.location, s.business_unit_id,
               business_unit_name = bu.BusinessUnitName,
               s.api_key_hint, s.is_active,
               s.agent_version, s.lab_name, s.lab_location,
               s.created_at, s.last_seen_at,
               instrument_count = (SELECT COUNT(*) FROM dbo.inf_lab_instrument_status i
                                   WHERE i.site_id = s.id)
        FROM dbo.inf_lab_site s
        LEFT JOIN dbo.tbl_med_business_unit_master bu ON bu.id = s.business_unit_id
        WHERE s.id = @id;
    END TRY
    BEGIN CATCH
        SELECT ok = CAST(0 AS BIT), error_code = 'INTERNAL',
               message = LEFT(ERROR_MESSAGE(), 200);
    END CATCH
END
GO

-- ------------------------------------------------------------------ list ----
CREATE OR ALTER PROCEDURE dbo.usp_inf_lab_site_list
AS
BEGIN
    SET NOCOUNT ON;

    SELECT
        s.id, s.code, s.name, s.location, s.business_unit_id,
        business_unit_name = bu.BusinessUnitName,
        s.api_key_hint, s.is_active,
        s.agent_version, s.lab_name, s.lab_location,
        s.created_at, s.last_seen_at,
        instrument_count = (SELECT COUNT(*) FROM dbo.inf_lab_instrument_status i
                            WHERE i.site_id = s.id)
    FROM dbo.inf_lab_site s
    LEFT JOIN dbo.tbl_med_business_unit_master bu ON bu.id = s.business_unit_id
    ORDER BY s.is_active DESC, s.code;
END
GO

-- ---------------------------------------------------------- authentication --
/*
 * Look up a site by code, returning the stored key hash for the API to
 * verify. The hash is never compared in SQL: the comparison must be the
 * constant-time one in PasswordHash.Verify, and doing it here would also mean
 * the plaintext key travelled to the database. Mirrors usp_inf_instrument_by_code.
 */
CREATE OR ALTER PROCEDURE dbo.usp_inf_lab_site_by_code
    @code NVARCHAR(20)
AS
BEGIN
    SET NOCOUNT ON;
    SELECT s.id, s.code, s.name, s.location, s.api_key_hash, s.is_active
    FROM dbo.inf_lab_site s
    WHERE s.code = LTRIM(RTRIM(@code));
END
GO

PRINT 'Created/updated usp_inf_lab_site_upsert, usp_inf_lab_site_list, usp_inf_lab_site_by_code.';
GO
