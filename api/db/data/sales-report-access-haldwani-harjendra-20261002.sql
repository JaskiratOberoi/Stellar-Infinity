/*
 * sales-report-access-haldwani-harjendra-20261002.sql
 *
 * Gives two field-sales logins Reporting and PDF download for the clients
 * allotted to them, via a per-user report:view grant (109/110 widened to
 * allow it). Their scope stays their own tbl_med_user_sales_mcc_mapping rows.
 *
 *   6400  HALDWANI SALES  (Hariom12100@gmail.com)       315 allotted clients
 *   6362  HARJENDRA       (Harjendragangwar@gmail.com)  226 allotted clients
 *
 * Asked by: Jaskirat Singh Oberoi (actor 6593).
 * Idempotent: the procedure answers "No change" for a grant already held.
 */
SET NOCOUNT ON;
SET XACT_ABORT ON;

IF NOT EXISTS (SELECT 1 FROM dbo.tbl_med_user_master
               WHERE id = 6400 AND Username = 'HALDWANI SALES' AND IsActive = 1)
    THROW 50000, 'User 6400 is not the active HALDWANI SALES login; stop.', 1;
IF NOT EXISTS (SELECT 1 FROM dbo.tbl_med_user_master
               WHERE id = 6362 AND Username = 'HARJENDRA' AND IsActive = 1)
    THROW 50000, 'User 6362 is not the active HARJENDRA login; stop.', 1;

-- Both must be restricted by allotments: a sales login with none would
-- resolve to every centre.
IF NOT EXISTS (SELECT 1 FROM dbo.tbl_med_user_sales_mcc_mapping WHERE user_id = 6400)
   OR NOT EXISTS (SELECT 1 FROM dbo.tbl_med_user_sales_mcc_mapping WHERE user_id = 6362)
    THROW 50000, 'A user has no allotted clients - grant would be unrestricted; stop.', 1;

EXEC dbo.usp_inf_admin_set_capability_grant
     @userId = 6400, @capability = 'report:view', @granted = 1, @actor = 6593;
EXEC dbo.usp_inf_admin_set_capability_grant
     @userId = 6362, @capability = 'report:view', @granted = 1, @actor = 6593;
GO
