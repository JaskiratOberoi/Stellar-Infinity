/*
 * 007_fk_staging.sql — keep Noble's raw foreign key alongside the resolved one.
 *
 * The sync writes rows in dependency order, but "in order" is not the same as
 * "the parent exists": Noble has no foreign key on several of these columns
 * and genuinely contains references to rows that were deleted years ago. A
 * sync that dropped those rows would replicate less than the LIS holds.
 *
 * So each FK becomes two columns. `<x>_noble_id` is what Noble said, copied
 * verbatim and never null-checked. `<x>_id` is the resolved surrogate, set by
 * a single UPDATE ... FROM after each batch and left NULL when the parent is
 * genuinely absent. Queries join on the resolved column; the raw one is the
 * evidence for why a join came back empty, which is otherwise unanswerable
 * once the original value has been discarded.
 *
 * Resolving after the batch rather than per row also turns N lookups into one
 * hash join — the difference is visible at 5M rows.
 */
SET search_path = stellar, public;

ALTER TABLE test     ADD COLUMN IF NOT EXISTS specimen_noble_id integer;
ALTER TABLE lab_user ADD COLUMN IF NOT EXISTS centre_noble_id   integer;

-- The clinical tables, added here so the later table mappers have them ready.
ALTER TABLE registration ADD COLUMN IF NOT EXISTS centre_noble_id           integer;
ALTER TABLE registration ADD COLUMN IF NOT EXISTS ref_doctor_noble_id       integer;
ALTER TABLE registration ADD COLUMN IF NOT EXISTS ref_customer_noble_id     integer;
ALTER TABLE sample       ADD COLUMN IF NOT EXISTS registration_noble_id     integer;
ALTER TABLE sample       ADD COLUMN IF NOT EXISTS specimen_noble_id         integer;
ALTER TABLE sample       ADD COLUMN IF NOT EXISTS authorised_by_noble_id    integer;
ALTER TABLE ordered_test ADD COLUMN IF NOT EXISTS registration_noble_id     integer;
ALTER TABLE ordered_test ADD COLUMN IF NOT EXISTS test_noble_id             integer;
ALTER TABLE bill         ADD COLUMN IF NOT EXISTS centre_noble_id           integer;
ALTER TABLE bill         ADD COLUMN IF NOT EXISTS registration_noble_id     integer;
ALTER TABLE bill_line    ADD COLUMN IF NOT EXISTS bill_noble_id             integer;
ALTER TABLE receipt      ADD COLUMN IF NOT EXISTS bill_noble_id             integer;
ALTER TABLE account_entry ADD COLUMN IF NOT EXISTS centre_noble_id          integer;
ALTER TABLE sample_event ADD COLUMN IF NOT EXISTS sample_vailid             text;
ALTER TABLE sample_event ADD COLUMN IF NOT EXISTS centre_noble_id           integer;

-- The resolver joins hit these constantly during a bulk load.
CREATE INDEX IF NOT EXISTS test_specimen_noble_idx      ON test (specimen_noble_id)      WHERE specimen_type_id IS NULL;
CREATE INDEX IF NOT EXISTS lab_user_centre_noble_idx    ON lab_user (centre_noble_id)    WHERE centre_id IS NULL;
CREATE INDEX IF NOT EXISTS registration_centre_noble_idx ON registration (centre_noble_id) WHERE centre_id IS NULL;
CREATE INDEX IF NOT EXISTS sample_reg_noble_idx         ON sample (registration_noble_id) WHERE registration_id IS NULL;
CREATE INDEX IF NOT EXISTS ordered_test_reg_noble_idx   ON ordered_test (registration_noble_id) WHERE registration_id IS NULL;
CREATE INDEX IF NOT EXISTS bill_centre_noble_idx        ON bill (centre_noble_id)        WHERE centre_id IS NULL;
CREATE INDEX IF NOT EXISTS bill_line_bill_noble_idx     ON bill_line (bill_noble_id);
CREATE INDEX IF NOT EXISTS receipt_bill_noble_idx       ON receipt (bill_noble_id);

-- bill_line.bill_id and receipt.bill_id are NOT NULL in 005, which the staged
-- approach cannot satisfy while the parent bill is still arriving. Relax them:
-- the resolver fills them in, and a NULL is the honest representation of a
-- line whose bill Noble no longer has.
ALTER TABLE bill_line ALTER COLUMN bill_id DROP NOT NULL;
ALTER TABLE receipt   ALTER COLUMN bill_id DROP NOT NULL;
