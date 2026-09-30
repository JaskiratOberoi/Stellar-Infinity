/*
 * sample-23664594-unit-20260930.sql
 *
 * SID 23664594 (Mrs Devki, LKR0229, CBC) was accessioned under LUCKNOWACC,
 * whose LIS user record carries business unit 1 (QUGEN, Delhi), so the sample
 * was stamped as Delhi-processed and its report printed the NABL mark. It was
 * run and authorised in Lucknow (SONPAL LK, unit 15). Corrected to 15 on
 * Jas's instruction, 2026-09-30. Guarded on the exact wrong value.
 */
UPDATE dbo.tbl_med_mcc_patient_samples
SET business_unit_id = 15
WHERE vailid = '23664594' AND business_unit_id = 1;

SELECT vailid, business_unit_id, modifiedby FROM dbo.tbl_med_mcc_patient_samples WHERE vailid = '23664594';
GO
