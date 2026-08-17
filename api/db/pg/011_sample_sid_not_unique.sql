/*
 * 011_sample_sid_not_unique.sql
 *
 * Two fixes, both found by the first clinical snapshot.
 *
 * ── 1. sample.sid cannot be unique ─────────────────────────────────────────
 *
 * 004 declared a unique index on sid, on the stated grounds that it replaced
 * Noble's trigger_PreventDuplicate declaratively. The snapshot proved the
 * premise wrong: Noble has 5,510,706 samples and 5,510,501 distinct vailids —
 * 155 duplicate groups, the worst of them 31 copies of one barcode.
 *
 * So the trigger does not actually prevent duplicates. Its test is
 *
 *     IF EXISTS (SELECT i.vailid FROM Inserted i, tbl_med_mcc_patient_samples F
 *                WHERE i.vailid = F.vailid GROUP BY i.vailid HAVING COUNT(*) > 1)
 *
 * which is an AFTER trigger doing a whole-table self-join, and it was added to
 * a table that already contained duplicates. Whatever it catches today, 155
 * groups got past it.
 *
 * A duplicate barcode is worse than a duplicate bill number: two physically
 * different tubes share an identifier, so "the sample with this SID" is
 * ambiguous, and any read path that does SingleOrDefault on it is picking
 * arbitrarily. Worth investigating IN NOBLE. Not papered over here — a replica
 * that de-duplicates disagrees with its source, and the disagreement surfaces
 * later as a sample that exists in one system and not the other.
 *
 * The index stays, non-unique: lookup by barcode is the hot path.
 *
 * ── 2. sample_event needs updated_at ───────────────────────────────────────
 *
 * The generic upsert appends `updated_at = now()` to every ON CONFLICT, so a
 * table without the column fails outright. Adding it is better than making the
 * upsert conditional: every other table has one, and the convention that all
 * rows carry created_at/updated_at is worth keeping total.
 */
SET search_path = stellar, public;

DROP INDEX IF EXISTS sample_sid_key;
CREATE INDEX IF NOT EXISTS sample_sid_idx ON sample (sid);

COMMENT ON COLUMN sample.sid IS
'NOT unique. Noble has 155 duplicate vailid groups (worst: 31 copies), which
trigger_PreventDuplicate failed to stop. Resolve by noble_id, never by sid.';

ALTER TABLE sample_event ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

SELECT attach_touch_triggers();
