/* QUOTED_IDENTIFIER is baked in at creation time; see script 70. */
SET QUOTED_IDENTIFIER ON;
GO
/*
 * 82_usp_inf_invoice_config.sql
 *
 * Phase 4d: the branding on a client's invoice.
 *
 * telo_mcc_invoice_config is Telo's sidecar table and is read as-is. It holds
 * what the printed document says about the LAB — name, address, contact — plus
 * three toggles that change the document's meaning rather than its appearance.
 *
 * ── THE THREE TOGGLES ARE TRI-STATE, AND THAT MATTERS ──────────────────────
 * on_behalf_mode, show_disclaimer and show_signatory are all NULLABLE, and NULL
 * does not mean "off". It means "not decided", and the default depends on the
 * client:
 *
 *   MDCARE      -> billed on behalf of Qugen, no disclaimer, signatory shown
 *   every other -> billed in the client's own name, disclaimer shown, no
 *                  signatory
 *
 * Reading NULL as false would silently drop the disclaimer from every invoice
 * that has never been configured — which is most of them — and that disclaimer
 * is the line saying the tests have been BILLED, not performed. So the
 * procedure returns the stored value untouched and the resolution happens in
 * one place in the API, where the rule can be stated once.
 *
 * ── WHY THE LETTERHEAD FALLS BACK TO THE LIS ───────────────────────────────
 * Two of about three and a half thousand centres have a config row. Reading
 * the address from the config alone would print a nameless, addressless
 * letterhead for everyone else, so each field falls back to what the LIS
 * already knows about the centre — which is where its address has been all
 * along. Telo does the same; the fallback is here rather than in the API so
 * both systems get it from one place.
 *
 * Read-only.
 */
CREATE OR ALTER PROCEDURE dbo.usp_inf_invoice_config
    @mcc INT
AS
BEGIN
    SET NOCOUNT ON;
    SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;

    SELECT
        mccId       = u.id,
        clientCode  = u.MCCUnitCode,
        -- The config may override the display name; fall back to the LIS's.
        clientName  = u.MCCUnitName,
        -- NULLIF on the config side: a row saved with an empty string is a
        -- field someone cleared, not a field they set to blank, and it must
        -- still fall through to the LIS rather than blanking the letterhead.
        labName     = NULLIF(LTRIM(RTRIM(c.lab_name)), ''),
        address     = COALESCE(NULLIF(LTRIM(RTRIM(c.address)), ''), NULLIF(LTRIM(RTRIM(u.address)), '')),
        city        = COALESCE(NULLIF(LTRIM(RTRIM(c.city)), ''),    NULLIF(LTRIM(RTRIM(u.city)), '')),
        -- stateid is a foreign key, so the LIS has no state STRING to fall
        -- back to; the config's free-text value is the only source.
        state       = NULLIF(LTRIM(RTRIM(c.state)), ''),
        pincode     = COALESCE(NULLIF(LTRIM(RTRIM(c.pincode)), ''), NULLIF(LTRIM(RTRIM(u.zip)), '')),
        phone       = COALESCE(NULLIF(LTRIM(RTRIM(c.phone)), ''),   NULLIF(LTRIM(RTRIM(u.phone)), '')),
        email       = COALESCE(NULLIF(LTRIM(RTRIM(c.email)), ''),   NULLIF(LTRIM(RTRIM(u.email)), '')),
        -- Deliberately NOT coalesced. NULL is "not decided" and the caller
        -- resolves it against the client; see the header.
        onBehalfMode  = c.on_behalf_mode,
        showDisclaimer = c.show_disclaimer,
        showSignatory  = c.show_signatory,
        preparedBy    = NULLIF(LTRIM(RTRIM(c.prepared_by)), ''),
        hasConfig   = CAST(CASE WHEN c.mcc_id IS NULL THEN 0 ELSE 1 END AS BIT),

        -- ── THE SAME FIELDS, UNRESOLVED ────────────────────────────────────
        -- Everything above is what the INVOICE prints: config value, else the
        -- LIS's. The editor cannot bind to those. Showing a resolved address
        -- in a text box presents the LIS's own value as though somebody had
        -- typed it, and the next Save writes it into the config row — pinning
        -- a copy that then stops tracking the LIS, silently, for every field
        -- the operator never touched.
        --
        -- So the raw stored values travel too, and the form binds to these
        -- while showing the resolved ones as placeholders.
        cfgLabName    = NULLIF(LTRIM(RTRIM(c.lab_name)), ''),
        cfgAddress    = NULLIF(LTRIM(RTRIM(c.address)), ''),
        cfgCity       = NULLIF(LTRIM(RTRIM(c.city)), ''),
        cfgState      = NULLIF(LTRIM(RTRIM(c.state)), ''),
        cfgPincode    = NULLIF(LTRIM(RTRIM(c.pincode)), ''),
        cfgPhone      = NULLIF(LTRIM(RTRIM(c.phone)), ''),
        cfgEmail      = NULLIF(LTRIM(RTRIM(c.email)), ''),
        cfgPreparedBy = NULLIF(LTRIM(RTRIM(c.prepared_by)), '')
    FROM dbo.tbl_med_mcc_unit_master u
    LEFT JOIN dbo.telo_mcc_invoice_config c ON c.mcc_id = u.id
    WHERE u.id = @mcc;
END
GO
