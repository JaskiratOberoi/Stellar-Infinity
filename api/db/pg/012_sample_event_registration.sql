/*
 * 012_sample_event_registration.sql
 *
 * sample_event links to a REGISTRATION, not to a sample.
 *
 * 009 staged sample_event.sample_vailid on the assumption that Noble's
 * tbl_med_mcc_test_transactions.vailid column contained a vial id. It does
 * not — it contains the patient's name ('PRIYA W/O MOHIT', 'RAMWATI'). The
 * evidence was unambiguous once the load ran: 4.9M rows staged, zero resolved.
 *
 * The column that actually references the rest of the schema is `patientid`,
 * a registration id. sample_vailid is kept rather than dropped: it is a
 * patient name as recorded at the time of the event, which is occasionally
 * useful evidence, and dropping a populated column to tidy up is how you lose
 * the only copy of something.
 */
SET search_path = stellar, public;

ALTER TABLE sample_event ADD COLUMN IF NOT EXISTS registration_noble_id integer;

COMMENT ON COLUMN sample_event.sample_vailid IS
'Misnamed in Noble: this is the PATIENT NAME at the time of the event, not a
vial id. Do not join it to sample.sid — it never matches.';

CREATE INDEX IF NOT EXISTS sample_event_reg_noble_idx
    ON sample_event (registration_noble_id) WHERE registration_id IS NULL;

-- The old staging index served a join that can never match.
DROP INDEX IF EXISTS sample_event_vailid_idx;

-- Force a re-snapshot: every existing row was loaded with the wrong link.
UPDATE stellar.sync_watermark
SET snapshot_completed_at = NULL, last_version = 0, rows_applied = 0
WHERE noble_table = 'tbl_med_mcc_test_transactions';

TRUNCATE stellar.sample_event;
