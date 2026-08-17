/*
 * 006_sync.sql — the sync service's own bookkeeping.
 *
 * State that belongs to the pipeline rather than to the lab. Kept in the same
 * database as the data it describes, so a restore can never resurrect rows
 * alongside a watermark that disagrees with them.
 */
SET search_path = stellar, public;

-- ---------------------------------------------------------------------------
-- Per-table watermark
--
-- One row per Noble table being tracked. `last_version` is the Change
-- Tracking version already applied; the next poll asks
-- CHANGETABLE(CHANGES <table>, last_version).
--
-- WHY min_valid_version MATTERS: Change Tracking retains changes for 7 days.
-- If the sync is down longer than that, Noble discards the intervening
-- versions and CHANGETABLE returns an error rather than silently skipping —
-- the correct behaviour, because a gap would mean permanent divergence. The
-- service compares its watermark against
-- CHANGE_TRACKING_MIN_VALID_VERSION() on every poll and refuses to proceed if
-- it has fallen behind, escalating to a re-snapshot instead of guessing.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sync_watermark (
    noble_table         text PRIMARY KEY,
    last_version        bigint NOT NULL DEFAULT 0,
    -- Set once when the initial bulk load completes; until then the tailer
    -- must not run for this table.
    snapshot_completed_at timestamptz,
    last_polled_at      timestamptz,
    last_change_at      timestamptz,
    rows_applied        bigint NOT NULL DEFAULT 0,
    -- Populated when a poll fails, cleared when one succeeds. A non-null value
    -- here is the alerting condition.
    last_error          text,
    last_error_at       timestamptz,
    updated_at          timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Run log — one row per poll cycle, for latency and throughput history
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sync_run (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    started_at      timestamptz NOT NULL DEFAULT now(),
    finished_at     timestamptz,
    tables_polled   integer NOT NULL DEFAULT 0,
    rows_applied    integer NOT NULL DEFAULT 0,
    -- Wall-clock gap between the newest Noble change applied and when this run
    -- finished: the number that answers "how stale is the replica right now".
    lag_seconds     integer,
    error           text
);
CREATE INDEX IF NOT EXISTS sync_run_started_idx ON sync_run (started_at DESC);

-- ---------------------------------------------------------------------------
-- Write-through outbox
--
-- Infinity writes shared entities through Noble's stored procedures
-- SYNCHRONOUSLY, inside the user's request — see the modernization doc for why
-- generic row-level writeback is refused. This table is not a queue for those
-- writes; it is the RECORD of them, so that when Change Tracking reflects the
-- write back seconds later the sync can recognise its own echo and avoid
-- clobbering a locally-enriched row with the thinner Noble version.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sync_echo (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    noble_table     text   NOT NULL,
    noble_id        integer NOT NULL,
    written_at      timestamptz NOT NULL DEFAULT now(),
    written_by      write_origin NOT NULL,
    -- Cleared by the sync once the corresponding change has come back and been
    -- reconciled. Rows older than an hour that are still unmatched mean a
    -- write that never reached Noble, which is worth alerting on.
    matched_at      timestamptz
);
CREATE INDEX IF NOT EXISTS sync_echo_lookup_idx
    ON sync_echo (noble_table, noble_id) WHERE matched_at IS NULL;

-- ---------------------------------------------------------------------------
-- Seed the watermarks for the 18 tables Change Tracking was enabled on in
-- phase 1 (api/db/sync/01_enable_change_tracking.sql). Version 0 and a NULL
-- snapshot timestamp together mean "not yet loaded".
-- ---------------------------------------------------------------------------
INSERT INTO sync_watermark (noble_table) VALUES
    ('tbl_med_mcc_unit_master'),
    ('tbl_med_user_master'),
    ('tbl_med_test_master'),
    ('tbl_med_mcc_doctors'),
    ('tbl_med_mcc_customer'),
    ('tbl_med_sample_master'),
    ('tbl_med_mcc_patient_samples_status_master'),
    ('tbl_billing_patient_detail'),
    ('tbl_billing_patient_test_detail'),
    ('tbl_billing_patient_amount_receipt'),
    ('tbl_med_mcc_account_detail'),
    ('tbl_med_mcc_patient_test_result_attachment'),
    ('tbl_med_mcc_patient_clinicaldata'),
    ('tbl_med_mcc_patient_tests'),
    ('tbl_med_mcc_test_transactions'),
    ('tbl_med_mcc_patient_master'),
    ('tbl_med_mcc_patient_samples'),
    ('tbl_med_mcc_patient_test_result')
ON CONFLICT (noble_table) DO NOTHING;

-- Replica staleness, as one number. The sync service exposes this on its
-- health endpoint and the dashboard can surface it.
CREATE OR REPLACE VIEW sync_health AS
SELECT
    count(*)                                                      AS tables_tracked,
    count(*) FILTER (WHERE snapshot_completed_at IS NOT NULL)     AS tables_loaded,
    count(*) FILTER (WHERE last_error IS NOT NULL)                AS tables_erroring,
    min(last_polled_at)                                           AS oldest_poll,
    sum(rows_applied)                                             AS total_rows
FROM sync_watermark;

SELECT attach_touch_triggers();
