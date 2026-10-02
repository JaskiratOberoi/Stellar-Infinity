/*
 * b2b-order-access-neeraj-20261002.sql
 *
 * Lets the accessioning technician NEERAJ (6708, NEERAJ SINGH,
 * singhneeraj9144@gmail.com) register new B2B orders, via per-user grants of
 * order:create + order:b2b on top of the technician role (109/110 widened to
 * allow them).
 *
 * Asked by: Jaskirat Singh Oberoi (actor 6593).
 * Idempotent: the procedure answers "No change" for a grant already held.
 */
SET NOCOUNT ON;
SET XACT_ABORT ON;

IF NOT EXISTS (SELECT 1 FROM dbo.tbl_med_user_master
               WHERE id = 6708 AND Username = 'NEERAJ' AND IsActive = 1)
    THROW 50000, 'User 6708 is not the active NEERAJ login; stop.', 1;

EXEC dbo.usp_inf_admin_set_capability_grant
     @userId = 6708, @capability = 'order:create', @granted = 1, @actor = 6593;
EXEC dbo.usp_inf_admin_set_capability_grant
     @userId = 6708, @capability = 'order:b2b', @granted = 1, @actor = 6593;
GO
