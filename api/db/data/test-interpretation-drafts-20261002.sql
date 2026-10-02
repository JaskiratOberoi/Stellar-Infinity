/*
 * test-interpretation-drafts-20261002.sql
 *
 * Draft interpretation texts for the two serum tests the catalogue has none
 * for (Jas, 2026-10-02), into Infinity's sidecar inf_test_interpretation
 * (script 175). They print on ZZTEST01 review reports only until the
 * Reporting setting 'test_interpretation' is switched on. Re-runnable: a
 * second run replaces the text.
 *
 *   114  BI089  Creatinine (serum)
 *    96  BI064  Calcium - Serum
 */
SET NOCOUNT ON;

DECLARE @by INT = 6593;

MERGE dbo.inf_test_interpretation AS t
USING (VALUES
 (114, N'CLINICAL SIGNIFICANCE

- Creatinine is a waste product of muscle metabolism, produced at a steady rate and cleared almost entirely by the kidneys. Its level in blood is therefore a practical marker of glomerular filtration: as kidney function falls, serum creatinine rises.

- Raised creatinine may indicate reduced kidney function (acute kidney injury or chronic kidney disease), obstruction of the urinary tract, dehydration or reduced blood flow to the kidneys, or muscle breakdown (rhabdomyolysis). Some drugs (e.g. trimethoprim, cimetidine) raise creatinine slightly without affecting filtration. A high-meat meal or creatine supplements can also raise it transiently.

- Low creatinine is uncommon and usually reflects low muscle mass (elderly, malnourished or chronically ill patients, muscle-wasting disease), pregnancy or over-hydration; it rarely indicates disease of the kidney.

- Creatinine depends on age, sex and muscle mass, so a value within the reference interval does not exclude early kidney disease. Estimated GFR (eGFR), urea and urine protein/albumin give a fuller picture; a rising trend over time is more significant than a single value.

- Interpret with the clinical history, hydration status and any medication. Results should be correlated clinically.', 0),
 (96, N'CLINICAL SIGNIFICANCE

- Calcium is essential for bone, nerve conduction, muscle contraction and blood clotting. About half of serum calcium is bound to albumin, so total calcium must be read together with the albumin level (or a corrected calcium calculated) — a low albumin lowers total calcium without changing the physiologically active ionized fraction.

- Raised calcium (hypercalcaemia) is most often due to primary hyperparathyroidism or malignancy; other causes include excess vitamin D, thiazide diuretics, prolonged immobilisation, sarcoidosis and thyrotoxicosis. Symptoms include thirst, polyuria, constipation, bone pain, kidney stones and confusion. A raised value should be confirmed on a repeat fasting sample with PTH, phosphorus, albumin and vitamin D.

- Low calcium (hypocalcaemia) may follow vitamin D deficiency, hypoparathyroidism (including after thyroid or parathyroid surgery), chronic kidney disease, low magnesium, acute pancreatitis or certain drugs; a low albumin is the commonest reason for a low TOTAL calcium with no symptoms. Symptoms include tingling, cramps and tetany.

- Prolonged tourniquet use and a non-fasting sample can raise the result slightly; interpret borderline values with a repeat.

- Results should be correlated clinically and with albumin, phosphorus, PTH and vitamin D where indicated.', 0)
) AS s (test_id, interpretation, override)
ON t.test_id = s.test_id
WHEN MATCHED THEN UPDATE SET interpretation = s.interpretation, override = s.override, is_active = 1, updated_by = @by, updated_at = SYSUTCDATETIME()
WHEN NOT MATCHED THEN INSERT (test_id, interpretation, override, is_active, updated_by) VALUES (s.test_id, s.interpretation, s.override, 1, @by);

SELECT ti.test_id, LTRIM(RTRIM(m.TestCode)) code, LTRIM(RTRIM(m.Testname)) name, LEN(ti.interpretation) chars, ti.override, ti.is_active
FROM dbo.inf_test_interpretation ti JOIN dbo.tbl_med_test_master m ON m.id = ti.test_id;
