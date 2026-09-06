/*
 * 140_fix_typhidot_igg_department.sql
 *
 * Catalogue correction: Typhidot IgG (tbl_med_test_master 2206, CP3121)
 * was filed under CLINICAL PATHOLOGY (2) while Typhidot IgM (213) sits under
 * IMMUNOLOGY / SEROLOGY (5).
 *
 * Every report that groups by department — Infinity's PID bundle, the LIS's
 * own patient report, Telo's — therefore printed the IgG with the urine
 * examination on the Clinical Pathology sheets and the IgM three sheets
 * later, on its own (PID 3643624, 05/09/2026). Both are serology; both now
 * print together, after the urine.
 *
 * Idempotent: touches the row only while it still carries department 2, so
 * a re-run changes nothing. Reverts with the same statement pointed back.
 */
UPDATE dbo.tbl_med_test_master
   SET DepartmentId = 5,
       ModifiedDate = GETDATE()
 WHERE id = 2206
   AND DepartmentId = 2;

PRINT CONCAT('Typhidot IgG rows moved to Immunology / Serology: ', @@ROWCOUNT);
GO
