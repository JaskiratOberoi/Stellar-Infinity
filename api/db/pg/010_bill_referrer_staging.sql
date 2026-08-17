/*
 * 010_bill_referrer_staging.sql
 *
 * The bill header carries its own referring doctor and customer — Noble stores
 * them on tbl_billing_patient_detail as well as on the registration, because a
 * bill is a document that was printed with those names on it. 007 staged the
 * registration's referrer keys and missed the bill's; the bill mapper failed
 * on the first run with "column ref_doctor_noble_id of relation bill does not
 * exist".
 */
SET search_path = stellar, public;

ALTER TABLE bill ADD COLUMN IF NOT EXISTS ref_doctor_noble_id   integer;
ALTER TABLE bill ADD COLUMN IF NOT EXISTS ref_customer_noble_id integer;

CREATE INDEX IF NOT EXISTS bill_ref_doctor_noble_idx
    ON bill (ref_doctor_noble_id) WHERE referring_doctor_id IS NULL;
CREATE INDEX IF NOT EXISTS bill_ref_customer_noble_idx
    ON bill (ref_customer_noble_id) WHERE referring_customer_id IS NULL;
