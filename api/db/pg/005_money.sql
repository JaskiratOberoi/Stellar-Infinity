/*
 * 005_money.sql — bills, lines, receipts, and the centre ledger.
 *
 * Money is numeric(14,2) throughout. Noble is inconsistent here — the bill
 * header uses decimal(16,2) but account_detail.amount, test rates and every
 * catalogue price are plain int (whole rupees). Integers are defensible for
 * this business today and indefensible as a schema decision, because widening
 * them later is a migration on live billing data.
 */
SET search_path = stellar, public;

-- ---------------------------------------------------------------------------
-- Bill (Noble: tbl_billing_patient_detail, 23,297 rows)
--
-- ── ON bill_number ─────────────────────────────────────────────────────────
-- YYMM*10000 + seq, unique per centre per month, NEVER globally unique. The
-- unique index below is the constraint Noble lacks, and the reason it can be
-- declared here without argument is that this database has exactly one writer
-- for it: the sync, replaying numbers Noble already allocated. Noble remains
-- the allocator — see the outbound-write section of the modernization doc.
--
-- Not enforced as a constraint on the CENTRE alone: 646 historical rows in
-- Noble violate it (all Listec-origin, mostly 2019 and 2023, from a COUNT+1
-- allocator that reuses numbers after a delete). Those rows must land in the
-- replica as they are, or the replica stops being a faithful mirror. Hence
-- the index is on (centre_id, bill_number, noble_id) — unique enough to catch
-- a sync bug, permissive enough to accept history as it actually is.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bill (
    id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    noble_id            integer UNIQUE,
    bill_number         integer,
    centre_id           bigint REFERENCES centre (id),
    registration_id     bigint REFERENCES registration (id),

    -- Noble copies the patient's name, age and sex onto the bill header as
    -- well as the registration. Carried because a bill is a document that was
    -- printed with those values on it, and later edits to the registration
    -- must not retroactively rewrite an issued bill.
    patient_name        text,
    age                 integer,
    age_unit            age_unit,
    sex                 sex,
    mobile_number       text,
    email               text,
    ip_op_number        text,

    referring_doctor_id   bigint REFERENCES referrer (id),
    referring_customer_id bigint REFERENCES referrer (id),

    amount              numeric(14,2),
    discount_type       text,
    discount_percent    numeric(6,2),
    discount_amount     numeric(14,2),
    tax_type            text,
    tax_percent         numeric(6,2),
    tax_amount          numeric(14,2),
    amount_paid         numeric(14,2),
    balance             numeric(14,2),
    payment_type        text,
    pay_mode            integer,

    patient_count       integer,
    is_phlebotomy       boolean NOT NULL DEFAULT false,
    remarks             text,
    comments            text,

    billed_at           timestamptz,
    origin              write_origin NOT NULL DEFAULT 'sync',
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS bill_centre_number_key
    ON bill (centre_id, bill_number, noble_id)
    WHERE bill_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS bill_centre_date_idx ON bill (centre_id, billed_at DESC);
CREATE INDEX IF NOT EXISTS bill_registration_idx ON bill (registration_id);
-- Outstanding balances, the question the accounts screen asks constantly.
CREATE INDEX IF NOT EXISTS bill_outstanding_idx ON bill (centre_id, balance)
    WHERE balance > 0;

-- ---------------------------------------------------------------------------
-- Bill line (Noble: tbl_billing_patient_test_detail, 39,563 rows)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bill_line (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    noble_id    integer UNIQUE,
    bill_id     bigint NOT NULL REFERENCES bill (id),
    test_id     bigint REFERENCES test (id),
    test_code   citext,
    test_name   text,
    test_type   text,
    amount      numeric(14,2),
    -- What the centre is charged, where the patient is billed at MRP: the
    -- margin lives in the gap between this and `amount`.
    ref_amount  numeric(14,2),
    origin      write_origin NOT NULL DEFAULT 'sync',
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bill_line_bill_idx ON bill_line (bill_id);

-- ---------------------------------------------------------------------------
-- Receipt (Noble: tbl_billing_patient_amount_receipt, 21,740 rows)
--
-- Voids are not deletions. Noble's receive_status carries the live/void flag
-- and Telo layers telo_receipt_void on top; here it is a nullable
-- voided_at/voided_reason on the row itself, so "is this receipt live" is a
-- single predicate rather than a join plus a string comparison.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS receipt (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    noble_id        integer UNIQUE,
    bill_id         bigint NOT NULL REFERENCES bill (id),
    amount          numeric(14,2) NOT NULL,
    pay_mode        text,
    card_number     text,
    received_by     text,
    received_at     timestamptz,
    voided_at       timestamptz,
    voided_reason   text,
    origin          write_origin NOT NULL DEFAULT 'sync',
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS receipt_bill_idx ON receipt (bill_id);
CREATE INDEX IF NOT EXISTS receipt_live_idx ON receipt (bill_id) WHERE voided_at IS NULL;

-- ---------------------------------------------------------------------------
-- Account entry (Noble: tbl_med_mcc_account_detail, 550,894 rows)
--
-- The centre's running account: deposits in, test charges out. Noble carries
-- a debit_flag bit alongside a positive amount; a signed amount says the same
-- thing without the reader having to remember which way the flag points.
-- direction is kept as well, for the cases where the UI wants the word.
-- ---------------------------------------------------------------------------
DO $$ BEGIN
    CREATE TYPE ledger_direction AS ENUM ('credit', 'debit');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS account_entry (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    noble_id        integer UNIQUE,
    centre_id       bigint REFERENCES centre (id),
    direction       ledger_direction NOT NULL,
    -- Signed: positive is money in, negative is money out. The sync derives
    -- the sign from Noble's debit_flag once, here, instead of every consumer
    -- re-deriving it.
    amount          numeric(14,2) NOT NULL,
    credit_type     integer,
    deposit_type    integer,
    instrument_ref  text,          -- cheque / DD number
    reason          text,
    occurred_at     timestamptz,
    origin          write_origin NOT NULL DEFAULT 'sync',
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS account_entry_centre_idx
    ON account_entry (centre_id, occurred_at DESC);

SELECT attach_touch_triggers();
