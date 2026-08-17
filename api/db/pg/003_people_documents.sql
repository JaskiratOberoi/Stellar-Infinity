/*
 * 003_people_documents.sql — the person/registration split, and blob storage.
 *
 * THE ONE STRUCTURAL CHANGE THAT IS NOT A TRANSLATION
 *
 * Noble's tbl_med_mcc_patient_master holds 3.4M rows and is described as
 * "patients". It is not: it is 3.4M REGISTRATIONS. The same human walking in
 * twice is two rows with no link between them, so the LIS cannot answer "show
 * me this patient's history" without matching on name and hoping. Every
 * delta-check and trend feature is built on that hope.
 *
 * Here a `registration` is still one visit and still mirrors Noble 1:1 — the
 * sync stays simple and nothing about existing behaviour changes. `person` is
 * added ABOVE it, and registrations are linked to a person by the matcher in
 * the sync service. person_id is NULLABLE on purpose: an unmatched
 * registration is normal and harmless, and a wrong match is worse than none,
 * so the matcher is allowed to abstain.
 */
SET search_path = stellar, public;

-- ---------------------------------------------------------------------------
-- Document — every binary, out of the transactional tables
--
-- Noble inlines 28 GB of PDFs and images as varbinary(max) inside
-- patient_clinicaldata and result_attachment, so every clinical query, backup
-- and log record drags them along. Here the bytes live outside the database
-- (filesystem or object store) and the row carries a locator plus a hash.
--
-- content_hash is UNIQUE: the same requisition form uploaded against five
-- samples is one blob and five references. Given the size of the corpus this
-- is expected to reclaim a meaningful fraction of the 28 GB outright.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS document (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    content_hash    text    NOT NULL,          -- sha256 of the bytes
    storage_key     text    NOT NULL,          -- path or object key
    byte_size       bigint  NOT NULL,
    media_type      text,
    file_name       text,
    origin          write_origin NOT NULL DEFAULT 'sync',
    created_at      timestamptz  NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS document_hash_key ON document (content_hash);

-- ---------------------------------------------------------------------------
-- Person — the identity layer Noble does not have
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS person (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    full_name       text NOT NULL,
    sex             sex  NOT NULL DEFAULT 'unknown',
    date_of_birth   date,
    mobile_number   text,
    email           text,
    -- How this person came to exist. 'matched' means the sync's matcher linked
    -- registrations together; 'manual' means a human confirmed or corrected
    -- it. A manual decision must never be silently overwritten by the matcher.
    is_manual       boolean NOT NULL DEFAULT false,
    origin          write_origin NOT NULL DEFAULT 'system',
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS person_mobile_idx ON person (mobile_number)
    WHERE mobile_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS person_name_trgm ON person USING gin (full_name gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- Registration — one visit. Mirrors Noble's patient_master 1:1.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS registration (
    id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    noble_id            integer UNIQUE,       -- Listec calls this the "Reg No"
    person_id           bigint REFERENCES person (id),
    centre_id           bigint REFERENCES centre (id),

    title               text,                 -- Mr / Mrs / Baby of …
    name                text,
    sex                 sex NOT NULL DEFAULT 'unknown',
    -- Noble stores age as a number plus a 1/2/3 unit code, NOT a date of
    -- birth. Keep both as given — converting to a DOB would invent precision
    -- that was never collected — and let `person` carry a real DOB when one
    -- is ever known. age drives reference-range selection, so it is not
    -- cosmetic.
    age                 integer,
    age_unit            age_unit,

    mobile_number       text,
    email               text,
    clinical_history    text,

    referring_doctor_id   bigint REFERENCES referrer (id),
    referring_customer_id bigint REFERENCES referrer (id),
    -- The free-text fallbacks, kept because most of the long tail of referrers
    -- never becomes a master row.
    referring_doctor_other   text,
    referring_customer_other text,

    sample_collected_at timestamptz,
    order_number        text,
    bill_number_text    text,   -- Noble reuses this column for SRF/MRN ids
    mrn_id              text,
    status              integer,

    origin              write_origin NOT NULL DEFAULT 'sync',
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS registration_person_idx ON registration (person_id);
CREATE INDEX IF NOT EXISTS registration_centre_idx ON registration (centre_id, created_at DESC);
CREATE INDEX IF NOT EXISTS registration_mobile_idx ON registration (mobile_number)
    WHERE mobile_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS registration_name_trgm ON registration USING gin (name gin_trgm_ops);

-- Clinical documents attached to a registration
-- (Noble: tbl_med_mcc_patient_clinicaldata, 568,840 rows / 21.9 GB).
CREATE TABLE IF NOT EXISTS registration_document (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    noble_id        integer UNIQUE,
    registration_id bigint NOT NULL REFERENCES registration (id),
    document_id     bigint NOT NULL REFERENCES document (id),
    kind            text,          -- Noble's 'HISTORY' tag and friends
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS registration_document_reg_idx
    ON registration_document (registration_id);

SELECT attach_touch_triggers();
