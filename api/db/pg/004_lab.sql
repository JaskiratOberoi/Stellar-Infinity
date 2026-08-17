/*
 * 004_lab.sql — samples, ordered tests, results, status history.
 *
 * This file is where the measured index findings change the design rather
 * than merely translating it. Read the two notes below before altering
 * anything here; both replace a specific, expensive mistake in Noble.
 */
SET search_path = stellar, public;

-- ---------------------------------------------------------------------------
-- Sample (Noble: tbl_med_mcc_patient_samples, 5.5M rows, 13 indexes)
--
-- ── ON CLUSTERING ──────────────────────────────────────────────────────────
-- Noble's clustered index on this table is `_dta_index_…_c_…__K7`: a Database
-- Tuning Advisor artifact keyed on sample_status — a MUTABLE, non-unique
-- column with ten distinct values. The consequences, all measured:
--
--   * A sample's life is a sequence of status transitions, and because
--     physical position is keyed on status, every transition RELOCATES the row
--     within a 2.2 GB clustered index. Roughly five moves per sample, 5.5M
--     samples.
--   * The key is non-unique, so every row carries a hidden 4-byte uniquifier.
--   * All twelve nonclustered indexes embed sample_status as their row
--     locator, making each wider and forcing each to be rewritten on every
--     status change.
--   * 491,988 key lookups into it in 8.2 hours.
--
-- Postgres has no clustered index, which removes the foot-gun by construction:
-- the heap is the heap and `id` is just the PK. status is a plain column, and
-- the worklist index below is PARTIAL — worklist queries only ever ask for
-- open samples, so the index covers only those and stays small while the
-- table grows without bound.
--
-- ── ON sid ─────────────────────────────────────────────────────────────────
-- Noble enforces vial-id uniqueness with trigger_PreventDuplicate: an AFTER
-- INSERT trigger that RAISERRORs and rolls back. A unique index does the same
-- job declaratively, cannot be bypassed, and is used by the planner.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sample (
    id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    noble_id            integer UNIQUE,
    sid                 citext  NOT NULL,      -- Noble's vailid, the barcode
    registration_id     bigint  REFERENCES registration (id),
    specimen_type_id    bigint  REFERENCES specimen_type (id),
    status_id           integer REFERENCES sample_status (id),

    -- Noble denormalises the ordered tests into three parallel delimited
    -- strings on this row (testcodes, testnames, testtypes, varchar(1000)),
    -- which is why "which tests are on this sample" needs string splitting.
    -- The ordered_test table below is the real answer; these are not carried.

    reject_comments     text,
    comments            text,
    clinical_history    text,
    report_type         smallint,
    department_id       text,
    business_unit_id    integer,
    authorised_by_id    bigint REFERENCES lab_user (id),
    signature_id        integer,
    mobile_number       text,

    registered_at       timestamptz,
    last_modified_at    timestamptz,   -- Listec's worksheet header "Report Date"

    origin              write_origin NOT NULL DEFAULT 'sync',
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS sample_sid_key ON sample (sid);
CREATE INDEX IF NOT EXISTS sample_registration_idx ON sample (registration_id);

-- The worklist index. Partial on the OPEN statuses only: 3 is rejected and
-- 7/8/9 are authorised or printed, so everything else is work in progress.
-- On 5.5M samples of which a few thousand are ever open, this is a tiny index
-- answering the query the worksheet runs all day.
CREATE INDEX IF NOT EXISTS sample_open_worklist_idx
    ON sample (status_id, registered_at DESC)
    WHERE status_id IS NOT NULL AND status_id NOT IN (3, 7, 8, 9);

-- The general date-ranged browse, unfiltered.
CREATE INDEX IF NOT EXISTS sample_registered_idx ON sample (registered_at DESC);

-- ---------------------------------------------------------------------------
-- Ordered test (Noble: tbl_med_mcc_patient_tests, 5.0M rows)
-- What was ordered, and at what price — the billing-facing side.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ordered_test (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    noble_id        integer UNIQUE,
    registration_id bigint REFERENCES registration (id),
    test_id         bigint REFERENCES test (id),
    test_code       citext,
    test_name       text,
    test_type       text,
    rate            numeric(12,2),
    amount_checked  boolean NOT NULL DEFAULT false,
    comments        text,
    origin          write_origin NOT NULL DEFAULT 'sync',
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ordered_test_registration_idx ON ordered_test (registration_id);
CREATE INDEX IF NOT EXISTS ordered_test_test_idx ON ordered_test (test_id);

-- ---------------------------------------------------------------------------
-- Result (Noble: tbl_med_mcc_patient_test_result, 68.3M rows, 16 indexes,
--         57.8 GB of index on 21.4 GB of data)
--
-- ── ON INDEXES ─────────────────────────────────────────────────────────────
-- Measured over 8.2 hours of live traffic, Noble's sixteen indexes resolve to
-- very few real access paths:
--
--   * the PK          — 453k seeks, 206k lookups
--   * FOUR near-duplicate indexes all leading on vailid, splitting ONE access
--     pattern between them: 157k, 156k, 39k and 35k seeks across ~14 GB
--   * seven indexes totalling ~15.7 GB served essentially ZERO reads while
--     paying up to 79,000 writes each
--
-- So this table gets the PK and ONE index on sample_id, which is the four
-- vailid indexes collapsed into the thing they were all approximating. Resist
-- adding more without a measurement: Noble's sixteen are what "add an index
-- per slow query, for six years" produces.
--
-- ── ON PARTITIONING ────────────────────────────────────────────────────────
-- RANGE by month on created_at. 68M rows and growing; monthly partitions keep
-- the working set (this month and last) small, let old months be compressed or
-- detached wholesale, and make the inevitable purge a DETACH rather than a
-- 68M-row DELETE.
--
-- The PK must include the partition key — Postgres requires the partition
-- column in every unique constraint — hence (id, created_at).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS result (
    id              bigint GENERATED ALWAYS AS IDENTITY,
    noble_id        integer,
    sample_id       bigint,
    ordered_test_id bigint,
    test_id         bigint,
    test_code       citext,
    test_name       text,
    param_id        integer,
    profile_id      integer,
    master_profile_id integer,
    level_id        integer,
    test_type       text,

    -- Free text, not numeric: a result may be a number, a coded option, or a
    -- page of histopathology prose. Noble's column is nvarchar(max) and that
    -- is correct; numeric interpretation happens at read time against the
    -- reference range.
    value           text,
    unit            text,
    normal_range    text,
    comments        text,

    is_abnormal     boolean NOT NULL DEFAULT false,
    is_authorised   boolean NOT NULL DEFAULT false,
    has_attachment  boolean NOT NULL DEFAULT false,
    has_parameters  boolean NOT NULL DEFAULT false,

    machine_name    text,
    tat             timestamptz,

    entered_by_id   bigint REFERENCES lab_user (id),
    origin          write_origin NOT NULL DEFAULT 'sync',
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- noble_id must be unique for the sync's upsert, and like the PK it has to
-- carry the partition key.
CREATE UNIQUE INDEX IF NOT EXISTS result_noble_key ON result (noble_id, created_at)
    WHERE noble_id IS NOT NULL;

-- THE index. See the note above before adding a second.
CREATE INDEX IF NOT EXISTS result_sample_idx ON result (sample_id);

-- A default partition so an out-of-range insert is never lost while the
-- month-roller is being written. It should stay empty; a non-empty default
-- means the roller has stopped and wants investigating.
CREATE TABLE IF NOT EXISTS result_default PARTITION OF result DEFAULT;

-- Create the partitions covering a window around a given month. Called by the
-- sync service on startup and monthly; creating them lazily at insert time
-- would put DDL in the write path.
CREATE OR REPLACE FUNCTION ensure_result_partitions(months_back int DEFAULT 2,
                                                    months_ahead int DEFAULT 2)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
    m    date := date_trunc('month', now())::date - (months_back || ' months')::interval;
    stop date := date_trunc('month', now())::date + (months_ahead || ' months')::interval;
    part text;
BEGIN
    WHILE m < stop LOOP
        part := format('result_%s', to_char(m, 'YYYYMM'));
        IF to_regclass(format('stellar.%I', part)) IS NULL THEN
            EXECUTE format(
                'CREATE TABLE stellar.%I PARTITION OF stellar.result
                 FOR VALUES FROM (%L) TO (%L)',
                part, m, (m + interval '1 month')::date);
        END IF;
        m := (m + interval '1 month')::date;
    END LOOP;
END $$;

SELECT ensure_result_partitions(2, 2);

-- ---------------------------------------------------------------------------
-- Sample event (Noble: tbl_med_mcc_test_transactions, 5.5M rows)
--
-- Noble's table conflates two things: a status/transaction log AND a running
-- account balance (currentbalance, closingbalance) recomputed per row. The
-- money half belongs in the ledger (005) and is not duplicated here; this is
-- the event stream only.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sample_event (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    noble_id        integer UNIQUE,
    sample_id       bigint REFERENCES sample (id),
    registration_id bigint REFERENCES registration (id),
    centre_id       bigint REFERENCES centre (id),
    actor_id        bigint REFERENCES lab_user (id),
    description     text,
    test_name       text,
    occurred_at     timestamptz,
    origin          write_origin NOT NULL DEFAULT 'sync',
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sample_event_sample_idx ON sample_event (sample_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS sample_event_centre_idx ON sample_event (centre_id, occurred_at DESC);

-- Result attachments (Noble: tbl_med_mcc_patient_test_result_attachment,
-- 7,023 rows / 5.6 GB inline). Bytes go to `document`; this is the link.
CREATE TABLE IF NOT EXISTS result_document (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    noble_id        integer UNIQUE,
    sample_id       bigint REFERENCES sample (id),
    result_noble_id integer,     -- the result row, which is partitioned; see note
    document_id     bigint NOT NULL REFERENCES document (id),
    created_at      timestamptz NOT NULL DEFAULT now()
);
-- Deliberately no FK to `result`: a foreign key into a partitioned table must
-- reference its full primary key (id, created_at), and the attachment does not
-- know the result's timestamp. Joining on (result_noble_id, sample_id) is
-- sufficient and avoids carrying a redundant date on every attachment.
CREATE INDEX IF NOT EXISTS result_document_sample_idx ON result_document (sample_id);

SELECT attach_touch_triggers();
