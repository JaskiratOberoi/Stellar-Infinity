/* QUOTED_IDENTIFIER is baked into every procedure and index at creation
   time, not taken from the caller. See script 70 for the failure mode this
   line prevents. */
SET QUOTED_IDENTIFIER ON;
GO
/*
 * 121_table_inf_lab_site.sql
 *
 * Registry of remote lab sites running the Stellar Synapse middleware.
 *
 * A site is not a person and not an analyser: it is a whole remote lab whose
 * agent pushes status reports about ITS instruments. It authenticates with a
 * per-site API key (X-Site-Code + X-Site-Key), mirroring the instrument
 * credential design in script 70 — only the key HASH is stored (pbkdf2-sha256,
 * the same primitive as the instrument keys and the auto-auth unlock secret),
 * so a leaked database yields no working site credential, and a lost key is
 * rotated rather than recovered.
 *
 * business_unit_id ties the site to dbo.tbl_med_business_unit_master, which is
 * what lets the interfaced-vs-manual result counts be attributed to the same
 * lab the site reports for.
 *
 * lab_name / lab_location are what the AGENT reports about itself, kept apart
 * from name / location, which are what the ADMIN registered. The two drifting
 * is information — a key installed at the wrong lab shows up as the mismatch.
 *
 * Idempotent.
 */
SET NOCOUNT ON;

IF OBJECT_ID('dbo.inf_lab_site', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.inf_lab_site (
        id               INT IDENTITY(1,1) NOT NULL
                         CONSTRAINT PK_inf_lab_site PRIMARY KEY,

        -- Short stable identifier, e.g. 'AGRA-01'. Matches the width of the
        -- instrument code for the same reason: a header value someone types
        -- into a config file should be short and unambiguous.
        code             NVARCHAR(20)   NOT NULL,
        name             NVARCHAR(200)  NOT NULL,
        location         NVARCHAR(200)  NULL,
        business_unit_id INT            NULL,

        -- pbkdf2-sha256$<iterations>$<salt>$<key>. Never the key itself.
        api_key_hash     NVARCHAR(200)  NOT NULL,
        -- First characters of the key, so an operator can tell which key is
        -- installed at which site without being able to reconstruct it.
        api_key_hint     NVARCHAR(8)    NOT NULL,

        -- What the agent reports about itself on every /report.
        agent_version    NVARCHAR(32)   NULL,
        lab_name         NVARCHAR(200)  NULL,
        lab_location     NVARCHAR(200)  NULL,

        is_active        BIT            NOT NULL CONSTRAINT DF_inf_lab_site_active DEFAULT 1,

        created_at       DATETIMEOFFSET NOT NULL CONSTRAINT DF_inf_lab_site_created DEFAULT SYSDATETIMEOFFSET(),
        created_by       INT            NULL,
        last_seen_at     DATETIMEOFFSET NULL,

        CONSTRAINT UQ_inf_lab_site_code UNIQUE (code)
    );

    PRINT 'Created dbo.inf_lab_site.';
END
ELSE
BEGIN
    PRINT 'dbo.inf_lab_site already present.';
END
GO
