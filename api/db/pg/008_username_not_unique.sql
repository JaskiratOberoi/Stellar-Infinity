/*
 * 008_username_not_unique.sql
 *
 * Drops the unique constraint on lab_user.username, because Noble does not
 * have one and the replica must be able to hold what Noble holds.
 *
 * FOUND BY THE FIRST SYNC RUN, not by reading the schema: the snapshot of
 * tbl_med_user_master aborted on a duplicate key. Measured afterwards —
 * 4,025 users, 4,015 distinct usernames case-insensitively, 9 duplicate
 * groups. Four of those pairs have BOTH rows marked active: yogesh, sufyan,
 * sonpal, dl0012.
 *
 * Two active accounts sharing a login name is a genuine defect in the LIS, not
 * merely an untidy table — authentication by username cannot say which row it
 * means, so one of the two either cannot sign in or, worse, signs in as the
 * other. That is worth fixing IN NOBLE, and it is deliberately not fixed here:
 * a replica that silently de-duplicates is a replica that disagrees with its
 * source, and the disagreement would surface later as a user who exists in one
 * system and not the other.
 *
 * The index stays, non-unique — lookup by username is the hot path for
 * authentication.
 */
SET search_path = stellar, public;

DROP INDEX IF EXISTS lab_user_username_key;
CREATE INDEX IF NOT EXISTS lab_user_username_idx ON lab_user (username);

COMMENT ON COLUMN lab_user.username IS
'NOT unique. Noble has 9 case-insensitive duplicate groups, 4 of them with two
active rows. Resolve by noble_id, never by username alone.';
