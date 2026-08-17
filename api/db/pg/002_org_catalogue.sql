/*
 * 002_org_catalogue.sql — centres, users, referrers, and the test catalogue.
 *
 * The slow-moving reference data. Every table follows the two conventions from
 * 001: a surrogate `id`, and `noble_id` holding the legacy PK so the sync can
 * find its counterpart. `noble_id` is UNIQUE, not just indexed — it is the
 * join key for every upsert the sync performs, and a duplicate would mean two
 * local rows silently competing for one Noble row.
 */
SET search_path = stellar, public;

-- ---------------------------------------------------------------------------
-- Collection centre (Noble: tbl_med_mcc_unit_master, 3,620 rows)
--
-- "MCC" throughout Noble; called a client or centre by everyone who works
-- here. Named `centre` because that is what it is, with the legacy code kept
-- as `code` — the string operators actually type and read (ABC01, HLD0516).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS centre (
    id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    noble_id            integer UNIQUE,
    code                citext  NOT NULL,
    name                text    NOT NULL,
    short_name          text,
    address             text,
    area                text,
    city                text,
    state_id            integer,
    country             text,
    zip                 text,
    phone               text,
    email               text,
    contact_person      text,
    business_unit_id    integer,
    -- Two distinct rate tiers, both plain ints in Noble with the meaning in
    -- application code: which rate list applies to work sent IN, and which
    -- applies when this centre is billed.
    rate_type           integer,
    rate_type_billing   integer,
    credit_limit        numeric(14,2),
    is_active           boolean NOT NULL DEFAULT true,
    needs_header        boolean,
    needs_date_time     boolean,
    sms_enabled         boolean,
    origin              write_origin NOT NULL DEFAULT 'sync',
    created_at          timestamptz  NOT NULL DEFAULT now(),
    updated_at          timestamptz  NOT NULL DEFAULT now()
);
-- Unique on code: Noble has no such constraint, but the whole platform treats
-- a centre code as an identifier — scope filtering, rate resolution and
-- invoice branding all key on it.
CREATE UNIQUE INDEX IF NOT EXISTS centre_code_key ON centre (code);
CREATE INDEX IF NOT EXISTS centre_active_idx ON centre (is_active) WHERE is_active;

-- ---------------------------------------------------------------------------
-- Lab user (Noble: tbl_med_user_master, 4,023 rows)
--
-- password is deliberately NOT replicated. Noble stores it in an
-- nvarchar(50) column; copying that into a second system doubles the exposure
-- of a credential store we are trying to leave behind. Authentication stays
-- against Noble until Infinity owns identity outright, at which point this
-- gains a proper password_hash and nothing is migrated.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lab_user (
    id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    noble_id            integer UNIQUE,
    username            citext  NOT NULL,
    first_name          text,
    last_name           text,
    email               text,
    phone               text,
    employee_id         text,
    usertype_id         integer,
    business_unit_id    integer,
    centre_id           bigint REFERENCES centre (id),
    is_active           boolean NOT NULL DEFAULT true,
    origin              write_origin NOT NULL DEFAULT 'sync',
    created_at          timestamptz  NOT NULL DEFAULT now(),
    updated_at          timestamptz  NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS lab_user_username_key ON lab_user (username);

-- ---------------------------------------------------------------------------
-- Referrers (Noble: tbl_med_mcc_doctors 1,459 / tbl_med_mcc_customer 328)
--
-- Two tables in Noble with byte-identical column lists. One table with a kind
-- discriminator here: every consumer treats them the same way (a dropdown
-- plus a free-text fallback), and keeping them apart doubles every query and
-- every form that touches referral.
-- ---------------------------------------------------------------------------
DO $$ BEGIN
    CREATE TYPE referrer_kind AS ENUM ('doctor', 'customer');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS referrer (
    id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    kind                referrer_kind NOT NULL,
    -- Not globally unique: doctor 12 and customer 12 are different rows, so
    -- the sync key is the PAIR. Enforced by the index below.
    noble_id            integer,
    code                text,
    name                text NOT NULL,
    address             text,
    area                text,
    city                text,
    state_id            integer,
    country             text,
    zip                 text,
    phone               text,
    email               text,
    contact_person      text,
    centre_id           bigint REFERENCES centre (id),
    is_active           boolean NOT NULL DEFAULT true,
    origin              write_origin NOT NULL DEFAULT 'sync',
    created_at          timestamptz  NOT NULL DEFAULT now(),
    updated_at          timestamptz  NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS referrer_noble_key ON referrer (kind, noble_id)
    WHERE noble_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS referrer_name_trgm ON referrer USING gin (name gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- Specimen type (Noble: tbl_med_sample_master, 150 rows) — "WB - EDTA" etc.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS specimen_type (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    noble_id    integer UNIQUE,
    name        text NOT NULL,
    is_active   boolean NOT NULL DEFAULT true,
    origin      write_origin NOT NULL DEFAULT 'sync',
    created_at  timestamptz  NOT NULL DEFAULT now(),
    updated_at  timestamptz  NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Sample status (Noble: tbl_med_mcc_patient_samples_status_master, 10 rows)
--
-- A lookup table, not an enum: the sync copies Noble's rows verbatim, and an
-- enum would need a migration every time the LIS adds a status. The codes are
-- load-bearing (3 = rejected, 7/8/9 = authorised or printed) and are asserted
-- against in worksheet editability rules.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sample_status (
    id          integer PRIMARY KEY,          -- Noble's id, used directly
    name        text NOT NULL,
    description text,
    -- Derived once here rather than re-derived in every consumer.
    is_terminal boolean NOT NULL DEFAULT false,
    updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Test catalogue (Noble: tbl_med_test_master, 1,823 rows)
--
-- Money becomes numeric. Noble stores prices as int (whole rupees) — correct
-- for this business today, but int is a decision that cannot be revisited
-- without a migration, and numeric costs nothing at this row count.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS test (
    id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    noble_id            integer UNIQUE,
    code                citext  NOT NULL,
    name                text    NOT NULL,
    report_name         text,
    short_name          text,
    cap_code            text,
    department_id       integer,
    specimen_type_id    bigint REFERENCES specimen_type (id),
    method              text,
    tat_hours           integer,
    price_ct            numeric(12,2),
    mrp                 numeric(12,2),
    order_no            integer,
    report_type_id      integer,
    has_parameters      boolean NOT NULL DEFAULT false,
    has_graph           boolean NOT NULL DEFAULT false,
    nabl_logo           boolean NOT NULL DEFAULT false,
    interpretation      text,
    report_normal_ranges text,
    is_active           boolean NOT NULL DEFAULT true,
    origin              write_origin NOT NULL DEFAULT 'sync',
    created_at          timestamptz  NOT NULL DEFAULT now(),
    updated_at          timestamptz  NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS test_code_key ON test (code);
CREATE INDEX IF NOT EXISTS test_name_trgm ON test USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS test_active_idx ON test (is_active) WHERE is_active;

SELECT attach_touch_triggers();
