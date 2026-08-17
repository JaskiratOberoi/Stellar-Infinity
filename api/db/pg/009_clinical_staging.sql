/*
 * 009_clinical_staging.sql — staging columns for the clinical tables.
 *
 * Same pattern as 007: Noble's raw key is kept beside the resolved surrogate
 * so a row whose parent has not arrived (or no longer exists) still lands.
 *
 * Results and sample events reference a sample by VAILID, not by the samples
 * table's id — Noble's own foreign key is the barcode string. So the staging
 * column is text here rather than an integer, and the resolver joins on
 * sample.sid.
 */
SET search_path = stellar, public;

ALTER TABLE result       ADD COLUMN IF NOT EXISTS sample_vailid text;
ALTER TABLE result       ADD COLUMN IF NOT EXISTS test_noble_id integer;
ALTER TABLE result       ADD COLUMN IF NOT EXISTS ordered_test_noble_id integer;

-- Partial: only rows still awaiting resolution are ever scanned, so this stays
-- small even against 68M results, and empties itself as the backlog clears.
CREATE INDEX IF NOT EXISTS result_sample_vailid_idx
    ON result (sample_vailid) WHERE sample_id IS NULL;
CREATE INDEX IF NOT EXISTS result_test_noble_idx
    ON result (test_noble_id) WHERE test_id IS NULL;
CREATE INDEX IF NOT EXISTS sample_event_vailid_idx
    ON sample_event (sample_vailid) WHERE sample_id IS NULL;
