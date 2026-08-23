/*
 * 127_verify_lis_scope_parity.sql
 *
 * READ-ONLY (a #temp table is the only thing written). Never run via apply.ps1
 * — this is an ad-hoc verification, not a migration.
 *
 * Proves that Infinity's scope resolution grants every account the same
 * client-code access the legacy LIS grants, after the LIS-parity rule landed
 * in ScopeRepository (absence of restriction = all access, for non-client
 * usertypes).
 *
 * The LIS-side model being compared against (from E:\Listec Genomics):
 *   restriction set = tbl_med_user_sales_mcc_mapping rows ∪ PCC_Id ∪ sub_pcc_id
 *   zero restrictions            -> sees every client
 *   one or more                  -> sees exactly that union
 *   franchise children           -> added for a parent-client login
 *   usertype                     -> gates menus/features, never data
 *
 * Deliberate, documented divergences (tagged, never counted as failures):
 *   D1  client usertypes (2,7,8,10,12): operational scope is own centre only —
 *       admin-granted mappings are ignored for ordering/billing (they still
 *       count for reports). The LIS "enforces" the same lock with a disabled
 *       dropdown; Infinity does it server-side.
 *   D2  admin widening: usertype 1/5 (operational) and roles in
 *       InfinityRoles.UnrestrictedReporters (reports) resolve to ALL even when
 *       the account carries mappings the LIS would filter by.
 *   D3  a client-usertype account with no centre at all stays locked out
 *       (LIS would give it everything — the one place parity is refused).
 *   D4  a resolved scope of more than ScopeFilter.UnrestrictedThreshold
 *       (1000) centres is promoted to ALL — SQL Server's parameter cap makes
 *       the literal IN-list impossible, and a >1000-centre restriction is a
 *       distinction without a difference. Pre-dates the parity change; in
 *       production it covers exactly two sales accounts (~1,200 and ~1,550
 *       codes).
 *
 * Result sets, in order:
 *   1. population summary by access class (LIS vs Infinity, both scopes)
 *   2. divergence rows — every user whose classes differ, tagged D1/D2/D3;
 *      tag UNDOCUMENTED = a parity failure. EXPECTED: zero UNDOCUMENTED rows.
 *   3. MDCARE freeze proof — the accounts tied to unit 5797, old rules vs new
 *      rules side by side. EXPECTED: identical per account.
 */
SET NOCOUNT ON;

DECLARE @totalMcc INT = (SELECT COUNT(*) FROM dbo.tbl_med_mcc_unit_master);

IF OBJECT_ID('tempdb..#scope') IS NOT NULL DROP TABLE #scope;

SELECT
    b.id, b.Username, b.ut, b.pcc, b.sub, b.maps, b.inf_role,
    b.restricted, b.own_n, b.r_op, b.r_rep,
    role_resolved =
        COALESCE(b.inf_role,
            CASE WHEN b.ut = 1 THEN 'super_admin'
                 WHEN b.ut IN (5, 26, 28, 32) THEN 'admin'
                 WHEN b.ut IN (2, 7, 12) THEN 'client'
                 WHEN b.ut IN (29, 33) THEN 'lab_manager'
                 WHEN b.ut IN (4, 9, 16, 17, 18, 20, 25, 30, 34) THEN 'technician'
                 ELSE 'viewer' END),
    -- What the LIS resolves this account to.
    lis_op_n  = CASE WHEN b.restricted = 0 THEN @totalMcc ELSE b.r_op END,
    lis_rep_n = CASE WHEN b.restricted = 0 THEN @totalMcc ELSE b.r_rep END,
    -- What Infinity resolves under the NEW rules.
    inf_op_n =
        CASE WHEN b.ut IN (1, 5) THEN @totalMcc
             WHEN b.ut IN (2, 7, 8, 10, 12) THEN b.own_n
             WHEN b.restricted = 1 THEN b.r_op
             ELSE @totalMcc END,
    -- What Infinity resolved under the OLD rules (for the freeze proof).
    old_op_n =
        CASE WHEN b.ut IN (1, 5) THEN @totalMcc
             WHEN b.ut IN (2, 7, 8, 10, 12) THEN b.own_n
             ELSE b.r_op END
INTO #scope
FROM (
    SELECT u.id, u.Username, u.usertypeid AS ut,
           ISNULL(u.PCC_Id, 0) AS pcc, ISNULL(u.sub_pcc_id, 0) AS sub,
           ISNULL(mc.n, 0) AS maps, r.role AS inf_role,
           CASE WHEN ISNULL(mc.n, 0) > 0 OR ISNULL(u.PCC_Id, 0) > 0
                  OR ISNULL(u.sub_pcc_id, 0) > 0 THEN 1 ELSE 0 END AS restricted,
           CASE WHEN ISNULL(u.PCC_Id, 0) > 0 THEN 1 ELSE 0 END
             + CASE WHEN ISNULL(u.sub_pcc_id, 0) > 0
                     AND ISNULL(u.sub_pcc_id, 0) <> ISNULL(u.PCC_Id, 0) THEN 1 ELSE 0 END AS own_n,
           (SELECT COUNT(DISTINCT v.id) FROM (
               SELECT m.mcc_code AS id FROM dbo.tbl_med_user_sales_mcc_mapping m
               WHERE m.user_id = u.id AND m.mcc_code IS NOT NULL
               UNION SELECT u.PCC_Id     WHERE ISNULL(u.PCC_Id, 0) > 0
               UNION SELECT u.sub_pcc_id WHERE ISNULL(u.sub_pcc_id, 0) > 0) v) AS r_op,
           (SELECT COUNT(DISTINCT v.id) FROM (
               SELECT m.mcc_code AS id FROM dbo.tbl_med_user_sales_mcc_mapping m
               WHERE m.user_id = u.id AND m.mcc_code IS NOT NULL
               UNION SELECT u.PCC_Id     WHERE ISNULL(u.PCC_Id, 0) > 0
               UNION SELECT u.sub_pcc_id WHERE ISNULL(u.sub_pcc_id, 0) > 0
               UNION
               SELECT f.sub_franchise_code
               FROM dbo.tbl_med_mcc_unit_franchise_mapping f
               WHERE f.sub_franchise_code > 0 AND f.sub_franchise_code <> f.mcc_code
                 AND f.mcc_code IN (
                     SELECT m2.mcc_code FROM dbo.tbl_med_user_sales_mcc_mapping m2
                     WHERE m2.user_id = u.id AND m2.mcc_code IS NOT NULL
                     UNION SELECT u.PCC_Id     WHERE ISNULL(u.PCC_Id, 0) > 0
                     UNION SELECT u.sub_pcc_id WHERE ISNULL(u.sub_pcc_id, 0) > 0)) v) AS r_rep
    FROM dbo.tbl_med_user_master u
    LEFT JOIN (SELECT m.user_id, COUNT(DISTINCT m.mcc_code) AS n
               FROM dbo.tbl_med_user_sales_mcc_mapping m
               WHERE m.mcc_code IS NOT NULL
               GROUP BY m.user_id) mc ON mc.user_id = u.id
    LEFT JOIN dbo.inf_user_role r ON r.user_id = u.id
) b;

-- Report scope under the new rules needs the resolved role, so it is computed
-- from #scope rather than inline above.
--
-- 1 ── population summary ---------------------------------------------------
SELECT
    access_class = CASE
        WHEN s.restricted = 0 AND s.ut NOT IN (2, 7, 8, 10, 12)
            THEN 'unrestricted staff (parity flip: was NOTHING, now ALL)'
        WHEN s.restricted = 0 AND s.ut IN (2, 7, 8, 10, 12) AND s.own_n = 0
            THEN 'zero-centre client (D3: stays locked)'
        WHEN s.ut IN (1, 5) THEN 'admin usertype (ALL, unchanged)'
        WHEN s.ut IN (2, 7, 8, 10, 12) THEN 'client (own centre, unchanged)'
        ELSE 'mapped staff (restricted, unchanged)' END,
    users = COUNT(*),
    total_centres = MIN(@totalMcc)
FROM #scope s
GROUP BY CASE
        WHEN s.restricted = 0 AND s.ut NOT IN (2, 7, 8, 10, 12)
            THEN 'unrestricted staff (parity flip: was NOTHING, now ALL)'
        WHEN s.restricted = 0 AND s.ut IN (2, 7, 8, 10, 12) AND s.own_n = 0
            THEN 'zero-centre client (D3: stays locked)'
        WHEN s.ut IN (1, 5) THEN 'admin usertype (ALL, unchanged)'
        WHEN s.ut IN (2, 7, 8, 10, 12) THEN 'client (own centre, unchanged)'
        ELSE 'mapped staff (restricted, unchanged)' END
ORDER BY users DESC;

-- 2 ── divergences, tagged --------------------------------------------------
SELECT
    s.Username, s.ut, s.role_resolved,
    s.lis_op_n, s.inf_op_n,
    lis_rep_n = s.lis_rep_n,
    inf_rep_n = CASE
        WHEN s.role_resolved IN ('super_admin', 'admin', 'lab_manager', 'reporting') THEN @totalMcc
        WHEN s.restricted = 1 OR s.ut IN (2, 7, 8, 10, 12) THEN
            CASE WHEN s.r_rep > 1000 THEN @totalMcc ELSE s.r_rep END
        ELSE @totalMcc END,
    tag = CASE
        WHEN s.ut IN (2, 7, 8, 10, 12) AND s.own_n = 0 THEN 'D3 zero-centre client, locked'
        WHEN s.ut IN (2, 7, 8, 10, 12) AND s.maps > 0
             AND s.inf_op_n <> s.lis_op_n THEN 'D1 client op lock ignores mappings'
        WHEN (s.ut IN (1, 5) OR s.role_resolved IN ('super_admin', 'admin', 'lab_manager', 'reporting'))
             AND s.restricted = 1 THEN 'D2 admin/reporter widened to ALL'
        WHEN s.restricted = 1 AND (s.r_op > 1000 OR s.r_rep > 1000)
            THEN 'D4 >1000-code scope promoted to ALL'
        ELSE 'UNDOCUMENTED' END
FROM #scope s
WHERE s.lis_op_n <> CASE
        WHEN s.ut IN (1, 5) THEN @totalMcc
        WHEN s.ut IN (2, 7, 8, 10, 12) THEN s.own_n
        WHEN s.restricted = 1 THEN s.r_op
        ELSE @totalMcc END
   OR s.lis_rep_n <> CASE
        WHEN s.role_resolved IN ('super_admin', 'admin', 'lab_manager', 'reporting') THEN @totalMcc
        WHEN s.restricted = 1 OR s.ut IN (2, 7, 8, 10, 12) THEN
            CASE WHEN s.r_rep > 1000 THEN @totalMcc ELSE s.r_rep END
        ELSE @totalMcc END
ORDER BY tag, s.Username;

-- 3 ── MDCARE freeze proof --------------------------------------------------
-- Every account touching unit 5797, old resolution vs new, side by side.
SELECT
    s.Username, s.ut, s.role_resolved, s.pcc, s.sub, s.maps,
    old_op_n = s.old_op_n,
    new_op_n = s.inf_op_n,
    op_frozen = CASE WHEN s.old_op_n = s.inf_op_n THEN 'YES' ELSE 'CHANGED' END,
    -- Report scope old vs new differs only for unrestricted non-clients, and
    -- no 5797 account is one; both computed anyway so the proof is a diff,
    -- not an argument.
    old_rep_n = CASE
        WHEN s.role_resolved IN ('super_admin', 'admin', 'lab_manager', 'reporting') THEN @totalMcc
        WHEN s.r_rep > 1000 THEN @totalMcc ELSE s.r_rep END,
    new_rep_n = CASE
        WHEN s.role_resolved IN ('super_admin', 'admin', 'lab_manager', 'reporting') THEN @totalMcc
        WHEN s.restricted = 1 OR s.ut IN (2, 7, 8, 10, 12) THEN
            CASE WHEN s.r_rep > 1000 THEN @totalMcc ELSE s.r_rep END
        ELSE @totalMcc END
FROM #scope s
WHERE s.pcc = 5797 OR s.sub = 5797
   OR EXISTS (SELECT 1 FROM dbo.tbl_med_user_sales_mcc_mapping m
              WHERE m.user_id = s.id AND m.mcc_code = 5797)
ORDER BY s.Username;

DROP TABLE #scope;
