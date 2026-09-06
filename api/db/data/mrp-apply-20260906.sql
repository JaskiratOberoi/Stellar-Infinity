-- MRP corrections from E:\Downloads\Infinity_Tests_MRP.xlsx (the B2B source of truth as of 2026-09-06).
-- 73 rows: 46 tests, 18 profiles, 9 packages. Touches ONLY the MRP column of the three
-- catalogue masters; client special rates (incl. MDCARE) are not read or written.
-- Every row is updated only if it still holds the MRP it was diffed against; otherwise the
-- whole batch rolls back. Old values are copied to dbo.inf_mrp_backup_20260906 first.
-- Run: powershell -File api/db/apply.ps1 mrp-apply-20260906.sql -SqlDir api/db/data
SET XACT_ABORT ON; SET NOCOUNT ON;
BEGIN TRAN;
IF OBJECT_ID('dbo.inf_mrp_backup_20260906') IS NULL
  CREATE TABLE dbo.inf_mrp_backup_20260906 (kind NVARCHAR(10), id INT, code NVARCHAR(100), old_mrp INT, new_mrp INT, applied_at DATETIME NOT NULL DEFAULT GETDATE());
DECLARE @c TABLE (kind NVARCHAR(10), id INT, code NVARCHAR(100), old_mrp INT, new_mrp INT);
INSERT INTO @c (kind,id,code,old_mrp,new_mrp) VALUES
(N'Package', 2361, N'HR0203 EXTENDED ', 2000, 3000),
(N'Package', 2457, N'HR202A EX', 1000, 2000),
(N'Package', 2492, N'HR204AEX', 1500, 3500),
(N'Package', 213, N'UP0102', 1600, 1800),
(N'Package', 214, N'UP103', 2000, 2500),
(N'Package', 1351, N'201PLUS', 1000, 1500),
(N'Package', 1352, N'202PLUS', 1500, 2000),
(N'Package', 2359, N'203PLUS', 2500, 3000),
(N'Package', 1353, N'204PLUS', 2000, 3500),
(N'Profile', 82, N'CBES1', 70, 350),
(N'Profile', 4, N'CP103', 1600, 2250),
(N'Profile', 81, N'KFTJK', 70, 500),
(N'Profile', 67, N'KFTMN', 70, 350),
(N'Profile', 64, N'KFTM1', 50, 400),
(N'Profile', 65, N'KFTMN2', 70, 450),
(N'Profile', 116, N'KFBN01', 100, 600),
(N'Profile', 121, N'KFTEG01', 150, 700),
(N'Profile', 128, N'KFTELEC01', 120, 600),
(N'Profile', 16, N'CP116', 200, 600),
(N'Profile', 63, N'LFTMN', 80, 500),
(N'Profile', 62, N'LPSC', 40, 500),
(N'Profile', 1, N'CP114', 500, 600),
(N'Profile', 35, N'GP14', 3000, 1200),
(N'Profile', 34, N'GP13', 3000, 1200),
(N'Profile', 14, N'CP113', 1500, 1800),
(N'Profile', 103, N'TYPHIDOT PROFILE', 250, 600),
(N'Profile', 20, N'CP120', 750, 850),
(N'Test', 165, N'BI215', 200, 300),
(N'Test', 213, N'CP3120', 500, 300),
(N'Test', 2233, N'BI00032', 700, 1800),
(N'Test', 1944, N'BI295', 3500, 1500),
(N'Test', 92, N'BI058', 1300, 850),
(N'Test', 2208, N'IMCA', 1450, 1500),
(N'Test', 723, N'BI254', 0, 300),
(N'Test', 15, N'HE010', 175, 750),
(N'Test', 109, N'MS023', 550, 600),
(N'Test', 263, N'HE012', 200, 400),
(N'Test', 34, N'CP004', 150, 100),
(N'Test', 72, N'HE013', 320, 550),
(N'Test', 267, N'HE014', 320, 550),
(N'Test', 2626, N'HE0140', 250, 650),
(N'Test', 2298, N'C19RT', 300, 600),
(N'Test', 113, N'MS024', 350, 400),
(N'Test', 1968, N'MS-01', 300, 1200),
(N'Test', 1989, N'BI244A', 1600, 2500),
(N'Test', 125, N'BI106', 400, 450),
(N'Test', 722, N'BI253', 0, 250),
(N'Test', 328, N'BI117', 25, 100),
(N'Test', 329, N'BI118', 25, 100),
(N'Test', 330, N'BI119', 25, 100),
(N'Test', 331, N'BI120', 25, 100),
(N'Test', 332, N'BI121', 25, 100),
(N'Test', 333, N'BI122', 25, 100),
(N'Test', 240, N'BI123', 50, 100),
(N'Test', 2403, N'HPRA1', 250, 800),
(N'Test', 194, N'CP3051', 400, 550),
(N'Test', 768, N'MS056', 300, 350),
(N'Test', 2220, N'HPIGA01', 1200, 1600),
(N'Test', 188, N'MS046', 1800, 1600),
(N'Test', 180, N'MS047', 2500, 1600),
(N'Test', 197, N'MS051', 600, 750),
(N'Test', 199, N'MS065', 500, 550),
(N'Test', 201, N'MS066', 500, 350),
(N'Test', 202, N'MS067', 500, 650),
(N'Test', 2625, N'TTFIA', 500, 1600),
(N'Test', 1890, N'MS111', 400, 550),
(N'Test', 211, N'MS087', 500, 600),
(N'Test', 212, N'MS088', 500, 600),
(N'Test', 2224, N'SER10192', 500, 1000),
(N'Test', 1809, N'cp113', 2500, 1800),
(N'Test', 2642, N'MST098', 150, 300),
(N'Test', 175, N'BI235', 500, 800),
(N'Test', 74, N'BI005', 1500, 1200);
INSERT INTO dbo.inf_mrp_backup_20260906 (kind,id,code,old_mrp,new_mrp) SELECT kind,id,code,old_mrp,new_mrp FROM @c;
DECLARE @n1 INT, @n2 INT, @n3 INT;
UPDATE t SET MRP = c.new_mrp, ModifiedBy = N'inf:mrp', ModifiedDate = GETDATE() FROM dbo.tbl_med_test_master t JOIN @c c ON c.kind='Test' AND c.id=t.id AND t.MRP=c.old_mrp; SET @n1=@@ROWCOUNT;
UPDATE t SET MRP = c.new_mrp, ModifiedBy = N'inf:mrp', ModifiedDate = GETDATE() FROM dbo.tbl_med_test_profile_master t JOIN @c c ON c.kind='Profile' AND c.id=t.id AND t.MRP=c.old_mrp; SET @n2=@@ROWCOUNT;
UPDATE t SET MRP = c.new_mrp, ModifiedBy = N'inf:mrp', ModifiedDate = GETDATE() FROM dbo.tbl_med_test_master_profile_master t JOIN @c c ON c.kind='Package' AND c.id=t.id AND t.MRP=c.old_mrp; SET @n3=@@ROWCOUNT;
DECLARE @want INT = (SELECT COUNT(*) FROM @c);
IF @n1+@n2+@n3 <> @want BEGIN ROLLBACK; PRINT 'ROLLED BACK - a row no longer holds the MRP the sheet was diffed against. tests=' + CAST(@n1 AS VARCHAR) + ' profiles=' + CAST(@n2 AS VARCHAR) + ' packages=' + CAST(@n3 AS VARCHAR) + ' wanted=' + CAST(@want AS VARCHAR); END
ELSE BEGIN COMMIT; PRINT 'COMMITTED - tests=' + CAST(@n1 AS VARCHAR) + ' profiles=' + CAST(@n2 AS VARCHAR) + ' packages=' + CAST(@n3 AS VARCHAR) + ' (old values kept in dbo.inf_mrp_backup_20260906)'; END