/*
 * 141_fix_hepatitis_igm_department.sql
 *
 * Catalogue correction, the same pattern as 140: HAV IgM CLIA (2655,
 * HAVCL01) and HEV IgM CLIA (2656, HEVCL01) were filed under CLINICAL
 * BIOCHEMISTRY (1). Both are serology and print with the rest of it under
 * IMMUNOLOGY / SEROLOGY (5).
 *
 * Active rows only, as asked: an inactive test is not ordered and is left
 * where it was. Idempotent - touches a row only while it still carries
 * department 1 - and reverts with the same statement pointed back.
 */
UPDATE dbo.tbl_med_test_master
   SET DepartmentId = 5,
       ModifiedDate = GETDATE()
 WHERE id IN (2655, 2656)
   AND DepartmentId = 1
   AND ISNULL(IsActive, 0) = 1;

PRINT CONCAT('Hepatitis IgM rows moved to Immunology / Serology: ', @@ROWCOUNT);
GO
