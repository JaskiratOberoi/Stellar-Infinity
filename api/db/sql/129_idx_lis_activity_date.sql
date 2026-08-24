/*
 * 129_idx_lis_activity_date.sql
 *
 * A date index on the LIS's own activity log, so the unified audit feed can
 * fold it in.
 *
 * TBL_MED_USER_ACTIVITY_LOG is 16.3M rows and growing ~40k/day, clustered on
 * its identity, with one nonclustered index (USERID, PID, FUNCTION_DATE) —
 * fine for "what did this user do", useless for "what happened this week",
 * which is the first question every audit screen asks. The feed's date-range
 * filter would table-scan 16M rows per page without this; with it, a window
 * is an index seek and the page rows are fifty key lookups.
 *
 * Key-only on FUNCTION_DATE (the clustered ID rides along implicitly), so the
 * index stays ~narrow — a couple hundred MB, not a second copy of the table.
 * The LIS's own Audit_Trail screen gets the same speedup for free.
 *
 * Standard Edition: no ONLINE=ON, so the build takes a schema lock and
 * blocks inserts for its duration (tens of seconds at this size). Run it in a
 * quiet window. Guarded, so re-runs are no-ops.
 */
IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE object_id = OBJECT_ID('dbo.TBL_MED_USER_ACTIVITY_LOG')
      AND name = 'IX_user_activity_log_date'
)
BEGIN
    CREATE NONCLUSTERED INDEX IX_user_activity_log_date
        ON dbo.TBL_MED_USER_ACTIVITY_LOG (FUNCTION_DATE);
END
