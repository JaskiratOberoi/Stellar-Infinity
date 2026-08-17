/*
 * 02_grant_view_server_state.sql
 *
 * RUN AS SYSADMIN, ONCE, FROM SSMS ON THE NOBLE SERVER (122.161.198.159).
 * This is the only elevation the stellar replica work needs.
 *
 * ---------------------------------------------------------------------------
 * WHY NOT sysadmin
 *
 * The earlier plan needed sysadmin because CDC's sp_cdc_enable_db demands it.
 * That plan is gone — phase 1 shipped on Change Tracking instead, which
 * nobleone could already enable as db_owner, and it is done. Nothing left in
 * the roadmap requires sysadmin, so granting it would be handing out
 * server-wide write authority to buy three read-only queries.
 *
 * VIEW SERVER STATE is the standard monitoring permission: it exposes the
 * dynamic management views and nothing else. It cannot create logins, change
 * data, alter databases, or read table contents anywhere.
 *
 * One honest caveat: it is SERVER-scoped, so nobleone will be able to see
 * activity metadata (sessions, waits, query text and plans, index usage) for
 * EVERY database on this instance, not just Noble. On a dedicated Noble box
 * that is immaterial. If this instance also hosts unrelated databases whose
 * query text is sensitive, say so and we can scope it down instead — see the
 * appendix at the foot of this file.
 * ---------------------------------------------------------------------------
 */

USE master;
GO

GRANT VIEW SERVER STATE TO nobleone;
GO

-- Verify. Expect has_view_server_state = 1.
SELECT login_name           = SUSER_SNAME(),
       has_view_server_state = HAS_PERMS_BY_NAME(NULL, NULL, 'VIEW SERVER STATE'),
       still_not_sysadmin    = CASE WHEN IS_SRVROLEMEMBER('sysadmin', 'nobleone') = 1
                                    THEN 'NO — nobleone is sysadmin, unexpected'
                                    ELSE 'correct, nobleone is not sysadmin' END;
GO

/*
 * ---------------------------------------------------------------------------
 * WHAT THIS UNLOCKS — the three things measured-but-blocked so far
 *
 *   1. Which of the 16 indexes on tbl_med_mcc_patient_test_result the engine
 *      ACTUALLY uses. 57.8 GB of indexes sit on 21.4 GB of data, seven of them
 *      leading on the same column; today that duplication is read from
 *      definitions, not from traffic. This turns it into evidence — both for
 *      choosing the replica's indexes and, separately, for pruning Noble's.
 *
 *   2. The tempdb version store that ALLOW_SNAPSHOT_ISOLATION now feeds.
 *      Expected to idle near zero, but it should be confirmed before phase 3
 *      snapshots 25 GB under snapshot isolation.
 *
 *   3. Whether SQL Server Agent is running — not needed by Change Tracking,
 *      but it is the prerequisite for backups and for CDC if we ever revisit.
 *
 * Run these AFTER the grant, as nobleone, against Noble:
 * ---------------------------------------------------------------------------

-- 1. Index usage on the over-indexed result table.
SELECT i.name,
       gb = CAST(ISNULL((SELECT SUM(a.total_pages) FROM sys.partitions p
                  JOIN sys.allocation_units a ON a.container_id = p.partition_id
                  WHERE p.object_id = i.object_id AND p.index_id = i.index_id), 0)
                 * 8.0/1024/1024 AS DECIMAL(8,2)),
       reads  = ISNULL(us.user_seeks,0) + ISNULL(us.user_scans,0) + ISNULL(us.user_lookups,0),
       writes = ISNULL(us.user_updates,0)
FROM sys.indexes i
LEFT JOIN sys.dm_db_index_usage_stats us
       ON us.object_id = i.object_id AND us.index_id = i.index_id AND us.database_id = DB_ID()
WHERE i.object_id = OBJECT_ID('dbo.tbl_med_mcc_patient_test_result') AND i.index_id > 0
ORDER BY reads ASC, gb DESC;   -- zero-read indexes at the top: pure write tax

-- Caveat when reading it: these counters reset on service restart, so check
-- uptime before concluding an index is unused.
SELECT uptime_days = DATEDIFF(DAY, sqlserver_start_time, GETDATE())
FROM sys.dm_os_sys_info;

-- 2. tempdb version store (snapshot isolation overhead).
SELECT version_store_mb = CAST(SUM(version_store_reserved_page_count) * 8.0/1024 AS DECIMAL(10,1))
FROM tempdb.sys.dm_db_file_space_usage;

-- 3. SQL Agent.
SELECT servicename, status_desc, startup_type_desc FROM sys.dm_server_services;

 * ---------------------------------------------------------------------------
 * REVOKE, if it is ever unwanted:
 *     USE master;  REVOKE VIEW SERVER STATE FROM nobleone;
 *
 * APPENDIX — tighter alternative for a shared instance
 *
 * If this instance hosts other databases whose activity should stay private,
 * skip the grant above and instead sign a stored procedure with a certificate
 * so ONLY that procedure can read the DMVs, while nobleone stays unprivileged.
 * More moving parts and it must be re-signed whenever the procedure changes,
 * which is why it is not the default recommendation. Ask and I will write it.
 * ---------------------------------------------------------------------------
 */
