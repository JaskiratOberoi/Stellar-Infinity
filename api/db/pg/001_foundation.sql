/*
 * 001_foundation.sql — the stellar replica, phase 2.
 *
 * Schema, enums, and the two conventions every table in this database obeys.
 * See docs/noble-db-modernization.md for why this database exists.
 *
 * Applied in filename order by db/pg/apply.sh. Idempotent: safe to re-run.
 */

CREATE SCHEMA IF NOT EXISTS stellar;
SET search_path = stellar, public;

-- citext: Noble's collation is Latin1_General_CI_AI — case- AND accent-
-- insensitive. Postgres is case-sensitive by default, so codes compared
-- across the sync boundary (client codes, test codes, usernames) would stop
-- matching. citext restores case-insensitivity where it is load-bearing.
-- Accent-insensitivity is deliberately NOT restored globally: it is far rarer
-- in this data, and a nondeterministic ICU collation would forbid pattern
-- indexes on the columns that most need them.
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;   -- patient/test name search

-- ---------------------------------------------------------------------------
-- Migration ledger
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schema_migration (
    filename    text        PRIMARY KEY,
    applied_at  timestamptz NOT NULL DEFAULT now(),
    checksum    text
);

-- ---------------------------------------------------------------------------
-- Enums: the magic numbers, decoded ONCE at the sync boundary
--
-- Noble stores gender as 1/2 and age_type as 1/2/3, with the decode ring
-- living in application code — reimplemented in Telo, in Infinity, in LISTEC,
-- and in every report. Here the meaning is in the database and the sync is the
-- single place that translates.
-- ---------------------------------------------------------------------------
DO $$ BEGIN
    CREATE TYPE sex AS ENUM ('male', 'female', 'other', 'unknown');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE age_unit AS ENUM ('years', 'months', 'days');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Which system wrote a row. Replaces the convention of smuggling
-- 'telo:<uid>' / 'inf:<uid>' through a varchar(50) addedby column — a
-- pathology that became load-bearing because read paths filter on it.
-- 'sync' means "this row arrived from Noble", which is what makes echo
-- suppression possible when Infinity writes through to Noble and CT
-- reflects the write straight back.
DO $$ BEGIN
    CREATE TYPE write_origin AS ENUM ('sync', 'infinity', 'telo', 'listec', 'instrument', 'system');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- updated_at, maintained by the ENGINE
--
-- Noble's equivalent is maintained by application code, and 41.7M of its 68.3M
-- result rows have a NULL updateddate as a result. A timestamp that half the
-- rows lack is worse than no timestamp, because code trusts it. A trigger
-- cannot be forgotten by a new write path.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END $$;

-- Attach the trigger to every table that has the column. Called at the end of
-- each migration file so new tables are covered without anyone remembering.
--
-- TWO SUBTLETIES, both learned by getting them wrong:
--
--  1. Partitions are EXCLUDED (relispartition). A trigger created on a
--     partitioned parent is propagated to its partitions automatically, so
--     visiting them too tries to create a duplicate and fails.
--  2. The existence check is re-tested inside the loop, not only in the
--     driving query. FOR..IN fixes its snapshot when the cursor opens, so a
--     trigger created during the loop — which is exactly what propagation to
--     a partition does — is invisible to the original query's NOT EXISTS.
CREATE OR REPLACE FUNCTION attach_touch_triggers() RETURNS void
LANGUAGE plpgsql AS $$
DECLARE r record;
BEGIN
    FOR r IN
        SELECT c.relname
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'stellar'
          AND c.relkind IN ('r', 'p')      -- ordinary and partitioned tables
          AND NOT c.relispartition          -- see subtlety 1
          AND EXISTS (
              SELECT 1 FROM pg_attribute a
              WHERE a.attrelid = c.oid AND a.attname = 'updated_at'
                AND NOT a.attisdropped AND a.attnum > 0)
    LOOP
        -- see subtlety 2
        IF NOT EXISTS (
            SELECT 1 FROM pg_trigger g
            WHERE g.tgrelid = format('stellar.%I', r.relname)::regclass
              AND g.tgname = 'trg_touch_updated_at')
        THEN
            EXECUTE format(
                'CREATE TRIGGER trg_touch_updated_at BEFORE UPDATE ON stellar.%I
                 FOR EACH ROW EXECUTE FUNCTION stellar.touch_updated_at()', r.relname);
        END IF;
    END LOOP;
END $$;

COMMENT ON SCHEMA stellar IS
'Modern replica of the Noble LIS. Rows carrying noble_id mirror a Noble row and
are maintained by the sync service; rows without one are Infinity-native.';
