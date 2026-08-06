/* QUOTED_IDENTIFIER is baked in at creation time; see script 70. */
SET QUOTED_IDENTIFIER ON;
GO
/*
 * 83_usp_inf_invoice_config_save.sql
 *
 * Editing what a client's invoice says about the lab.
 *
 * ── THIS WRITES A TABLE TELO PRINTS FROM ───────────────────────────────────
 * telo_mcc_invoice_config is not Infinity's. Saving here changes the document
 * Telo produces for the same client, immediately, with no deploy. That is the
 * intent — one branding record, two front ends, no drift while both are live —
 * but it is why this procedure is narrow in two specific ways.
 *
 * FIRST: it touches ten columns and no others. The table also carries the
 * logo bytes and the header layout (top_right_logo_bytes, its mime,
 * noble_logo_position, noble_logo_visible, custom_logo_visible). Infinity has
 * no logo editor and its invoice does not render one, so a save from here must
 * leave that block exactly as Telo left it. An UPDATE listing every column
 * would blank a client's uploaded logo the first time somebody corrected a
 * phone number, and nobody would connect the two events.
 *
 * SECOND: NULL means "auto", and the caller always sends all ten. There is no
 * "leave this one alone" — the editor posts the whole managed set every time,
 * so a NULL arriving here is a deliberate choice of the MDCARE-aware default,
 * never an omission. Telo needs per-field submitted flags because its form
 * posts partial data; making that distinction explicit in the contract instead
 * removes the class of bug where a missing field silently means two things.
 *
 * Empty and whitespace-only strings are stored as NULL. "Cleared" and "never
 * set" must read identically at print time or the letterhead fallback in
 * script 82 would not fire for a field somebody blanked.
 */
CREATE OR ALTER PROCEDURE dbo.usp_inf_invoice_config_save
    @mcc              INT,
    @lab_name         NVARCHAR(200) = NULL,
    @address          NVARCHAR(500) = NULL,
    @city             NVARCHAR(120) = NULL,
    @state            NVARCHAR(120) = NULL,
    @pincode          NVARCHAR(20)  = NULL,
    @phone            NVARCHAR(50)  = NULL,
    @email            NVARCHAR(200) = NULL,
    @prepared_by      NVARCHAR(120) = NULL,
    -- NULL = auto (MDCARE-aware default). Anything other than 'qugen' or
    -- 'client' is rejected rather than coerced: billing in the wrong entity's
    -- name is the expensive direction to be wrong in, so a typo must fail
    -- loudly instead of quietly resolving to something plausible.
    @on_behalf_mode   VARCHAR(12)   = NULL,
    @show_disclaimer  BIT           = NULL,
    @show_signatory   BIT           = NULL
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    IF @on_behalf_mode IS NOT NULL AND LOWER(LTRIM(RTRIM(@on_behalf_mode))) NOT IN ('client', 'qugen')
    BEGIN
        RAISERROR (N'on_behalf_mode must be ''client'', ''qugen'', or NULL for auto.', 16, 1);
        RETURN;
    END

    IF NOT EXISTS (SELECT 1 FROM dbo.tbl_med_mcc_unit_master WHERE id = @mcc)
    BEGIN
        RAISERROR (N'No centre with that id.', 16, 1);
        RETURN;
    END

    DECLARE @obm VARCHAR(12) = LOWER(LTRIM(RTRIM(@on_behalf_mode)));

    -- Blank is NULL: see the header.
    SELECT
        @lab_name    = NULLIF(LTRIM(RTRIM(@lab_name)), ''),
        @address     = NULLIF(LTRIM(RTRIM(@address)), ''),
        @city        = NULLIF(LTRIM(RTRIM(@city)), ''),
        @state       = NULLIF(LTRIM(RTRIM(@state)), ''),
        @pincode     = NULLIF(LTRIM(RTRIM(@pincode)), ''),
        @phone       = NULLIF(LTRIM(RTRIM(@phone)), ''),
        @email       = NULLIF(LTRIM(RTRIM(@email)), ''),
        @prepared_by = NULLIF(LTRIM(RTRIM(@prepared_by)), ''),
        @obm         = NULLIF(@obm, '');

    BEGIN TRANSACTION;

    -- UPDLOCK + HOLDLOCK on the probe is what makes this upsert safe under
    -- concurrency: without it two simultaneous first-time saves for the same
    -- centre both miss, both insert, and the second dies on the primary key.
    IF EXISTS (SELECT 1 FROM dbo.telo_mcc_invoice_config WITH (UPDLOCK, HOLDLOCK) WHERE mcc_id = @mcc)
    BEGIN
        -- Note what is absent: the logo and layout columns. See the header.
        UPDATE dbo.telo_mcc_invoice_config
        SET lab_name        = @lab_name,
            address         = @address,
            city            = @city,
            state           = @state,
            pincode         = @pincode,
            phone           = @phone,
            email           = @email,
            prepared_by     = @prepared_by,
            on_behalf_mode  = @obm,
            show_disclaimer = @show_disclaimer,
            show_signatory  = @show_signatory,
            updated_at      = SYSUTCDATETIME()
        WHERE mcc_id = @mcc;
    END
    ELSE
    BEGIN
        INSERT INTO dbo.telo_mcc_invoice_config
            (mcc_id, lab_name, address, city, state, pincode, phone, email,
             prepared_by, on_behalf_mode, show_disclaimer, show_signatory,
             created_at, updated_at)
        VALUES
            (@mcc, @lab_name, @address, @city, @state, @pincode, @phone, @email,
             @prepared_by, @obm, @show_disclaimer, @show_signatory,
             SYSUTCDATETIME(), SYSUTCDATETIME());
    END

    COMMIT TRANSACTION;
END
GO
