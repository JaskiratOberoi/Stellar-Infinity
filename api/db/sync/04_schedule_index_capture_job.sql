/*
 * 04_schedule_index_capture_job.sql
 *
 * RUN AS SYSADMIN, ONCE, IN SSMS ON THE NOBLE SERVER.
 *
 * Creates a SQL Agent job that calls dbo.usp_inf_capture_index_usage every
 * hour, so index usage accumulates across the service restarts that keep
 * wiping sys.dm_db_index_usage_stats (twice in 29 hours, most recently
 * 2026-08-18 06:09 local).
 *
 * Why sysadmin: nobleone is db_owner on Noble but holds nothing in msdb — not
 * SQLAgentUserRole, not EXECUTE on sp_add_job. Checked, not assumed. Creating
 * Agent jobs is genuinely outside what the application login should be able to
 * do, so this is the right boundary rather than a gap to close.
 *
 * Cost per run: one pass over sys.indexes plus a small insert — a few hundred
 * rows, milliseconds. It writes only dbo.inf_index_usage_history.
 *
 * Idempotent: the job is dropped and recreated if it already exists.
 */
USE msdb;
GO

IF EXISTS (SELECT 1 FROM msdb.dbo.sysjobs WHERE name = N'Infinity - Capture index usage')
    EXEC msdb.dbo.sp_delete_job @job_name = N'Infinity - Capture index usage', @delete_unused_schedule = 1;
GO

DECLARE @jobId BINARY(16);

EXEC msdb.dbo.sp_add_job
     @job_name    = N'Infinity - Capture index usage',
     @enabled     = 1,
     @description = N'Hourly snapshot of index usage into Noble.dbo.inf_index_usage_history. '
                  + N'dm_db_index_usage_stats is in-memory and resets on every service restart; '
                  + N'this preserves the deltas so index-pruning decisions rest on weeks of '
                  + N'evidence rather than whatever has accrued since the last reboot.',
     @job_id      = @jobId OUTPUT;

EXEC msdb.dbo.sp_add_jobstep
     @job_id           = @jobId,
     @step_name        = N'Capture',
     @subsystem        = N'TSQL',
     @database_name    = N'Noble',
     @command          = N'EXEC dbo.usp_inf_capture_index_usage;',
     -- Never retry: the next hourly run supersedes a missed one, and a retry
     -- storm against a struggling server helps nobody.
     @retry_attempts   = 0,
     @on_success_action = 1,   -- quit reporting success
     @on_fail_action    = 2;   -- quit reporting failure

-- Top of every hour, forever.
EXEC msdb.dbo.sp_add_jobschedule
     @job_id                = @jobId,
     @name                  = N'Hourly',
     @freq_type             = 4,      -- daily
     @freq_interval         = 1,
     @freq_subday_type      = 8,      -- hours
     @freq_subday_interval  = 1,
     @active_start_time     = 000500; -- :05 past, clear of other top-of-hour work

EXEC msdb.dbo.sp_add_jobserver @job_id = @jobId, @server_name = N'(local)';

PRINT 'Job created: Infinity - Capture index usage (hourly at :05).';
GO

-- Prove it works rather than waiting an hour to find out.
EXEC msdb.dbo.sp_start_job @job_name = N'Infinity - Capture index usage';
GO

/*
 * Verify (give it a few seconds first):
 *
 *   SELECT TOP 5 j.name, a.run_requested_date, a.last_executed_step_id, a.stop_execution_date
 *   FROM msdb.dbo.sysjobactivity a JOIN msdb.dbo.sysjobs j ON j.job_id = a.job_id
 *   WHERE j.name = 'Infinity - Capture index usage' ORDER BY a.run_requested_date DESC;
 *
 *   SELECT COUNT(*) AS captures, MIN(captured_at), MAX(captured_at)
 *   FROM Noble.dbo.inf_index_usage_history;
 *
 * Then, after a few weeks including a month-end:
 *
 *   SELECT * FROM Noble.dbo.vw_inf_index_usage_total
 *   WHERE table_name = 'tbl_med_mcc_patient_test_result'
 *   ORDER BY total_reads ASC, size_mb DESC;
 *
 * An index with size_mb in the thousands, total_reads of 0 and observed_hours
 * past a month is then a defensible drop. Reversal:
 * api/db/sync/noble_index_definitions_backup.sql.
 *
 * REMOVE:
 *   EXEC msdb.dbo.sp_delete_job @job_name = N'Infinity - Capture index usage';
 */
