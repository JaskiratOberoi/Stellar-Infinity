/*
 * 01_table_inf_account.sql
 *
 * Infinity-owned sidecar that decouples an Infinity-created account's LIS login
 * from its Infinity login. Directly mirrors dbo.telo_account, for the same
 * reason: the shared LIS table (tbl_med_user_master) has exactly one IsActive
 * bit and the legacy LIS LoginClass uses it as its ONLY login gate, so that bit
 * cannot also mean "may use Infinity". Two intents are tracked here instead:
 *
 *   inf_active : may sign in to INFINITY (the Infinity enable/disable switch).
 *   lis_access : may sign in to the LIS with these same credentials.
 *
 * The LIS gate stays exactly what the LIS reads — IsActive — kept derived as
 *   IsActive = (inf_active AND lis_access)
 * So a new Infinity account has IsActive = 0 and the LIS rejects it, while
 * usp_inf_authenticate keys on inf_active and lets the user into Infinity.
 * Granting LIS access from the admin panel flips lis_access to 1, which
 * re-derives IsActive = 1 and the LIS begins accepting the same credentials.
 *
 * Existence of a row here == "Infinity-managed account".
 *
 * ---------------------------------------------------------------------------
 * SHARED-COLUMN HAZARD — read before changing anything here.
 *
 * Telo derives the SAME IsActive column from ITS OWN pair
 * (telo_active AND lis_access). Two systems writing one derived column will
 * clobber each other: an Infinity admin granting LIS access would be silently
 * reverted the next time a Telo admin touched that user, and vice versa.
 *
 * The rule that keeps this safe: an account has at most ONE managing system.
 * Infinity's admin procedures refuse to touch LIS access for any user that has
 * a dbo.telo_account row, exactly as Telo's refuse for users that have no
 * telo_account row. Do not "improve" that guard away.
 * ---------------------------------------------------------------------------
 *
 * Deliberately NOT backfilled. Telo's equivalent script claimed every account it
 * had ever created and revoked their LIS access; Infinity has created none yet,
 * so there is nothing to claim, and sweeping up existing users here would
 * silently seize accounts Telo or the LIS already manages.
 *
 * Idempotent: created only if missing.
 */
SET NOCOUNT ON;

IF OBJECT_ID('dbo.inf_account', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.inf_account (
        user_id    INT       NOT NULL PRIMARY KEY,
        inf_active BIT       NOT NULL CONSTRAINT DF_inf_account_inf_active DEFAULT 1,
        lis_access BIT       NOT NULL CONSTRAINT DF_inf_account_lis_access DEFAULT 0,
        created_at DATETIME2 NOT NULL CONSTRAINT DF_inf_account_created    DEFAULT SYSDATETIME(),
        created_by INT       NULL,
        updated_at DATETIME2 NULL,
        updated_by INT       NULL
    );

    PRINT 'Created dbo.inf_account.';
END
ELSE
BEGIN
    PRINT 'dbo.inf_account already present.';
END
GO
