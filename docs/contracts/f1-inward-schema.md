# F1 — Sample transit / inward tracking: production schema findings

Role B (schema verifier) output for Phase P1, run against the LIVE Noble
database on 2026-08-17, read-only (SELECT only, ad-hoc helper, deleted after
use). Companion to Role A's `f1-inward-contract.md` — section §9 below answers
its §12 open questions one by one. All "90d" figures are the window ending
2026-08-17; the moving GETDATE() window makes counts drift by a few rows
between queries (58,078–58,094) — treat them as ±0.05%.

**Everything Role C builds cites this file, not the code reading.**

---

## 1. Physical table

`dbo.tbl_acc_inward_sample_tracking` — 233,082 rows; scan_datetime spans
**2025-07-06 → today** (~13.5 months; either the feature started then or was
purged before — no purge mechanism exists in DB or code).

| column | type | null | notes from data |
|---|---|---|---|
| id | int identity | PK | clustered |
| vailid | varchar(50) | Y | 1 blank in 90d; **contains literal TAB characters and stray spaces** (see §5) |
| patient_id | int | Y | NULL/0 on 6.5% of 90d rows |
| scan_datetime | datetime | Y | never NULL (0 of 233k) |
| scan_by | varchar(50) | Y | **always** `USERNAME- Scan DT:d/MM/yyyy` — 58,089/58,089 90d rows match the pattern; embedded date equals `CONVERT(date, scan_datetime)` in **100%** of rows (pure redundancy); max length ever = 32, so the 50-char truncation bomb has not yet gone off |
| bunit | varchar(50) | Y | never NULL/blank; all values are `tbl_med_business_unit_master.BusinessUnitCode` |
| received_one(_datetime) | | Y | filled on **13.6%** of 90d rows |
| received_two(_datetime) | | Y | filled on **3.0%** |
| received_three(_datetime) | | Y | filled on **0.75%** |
| slno | int | Y | never NULL, never 0; range 1–633 in 90d |

**Indexes: the clustered PK on `id` is the ONLY index**
(`PK_tbl_cpath_inward_sample_tracking` — note the fossil `cpath` name). No
index on `vailid`, none on `scan_datetime`, none on `bunit`. Every legacy
lookup (`CheckInwardVailid`, `GetVailSlno`, the grid) table-scans 233k rows.
Infinity querying by vailid and by date **requires new indexes — a production
migration Role C must script** (`SET QUOTED_IDENTIFIER ON; GO`, numbered).

By contrast `tbl_med_mcc_patient_samples` (5.51M rows) has `vailid` covered by
at least four indexes — joins from tracking→samples are cheap; the reverse
direction is what needs help.

No triggers on the tracking table; **zero** objects in `sys.sql_modules`
mention it; the one trigger on samples (`trigger_PreventDuplicate`) is
unrelated. The Inward page really is the sole writer (settles Role A Q1).

## 2. What the row population says the feature is

- **58,080 scans / 37,411 distinct vailids in 90d.** Rows per vailid:
  1 row — 16,897 vailids; 2 rows — 20,478; ≥3 rows — 35 (max 100, see §5).
- Of the 20,478 two-row vailids, **20,044 (98%) are two different bunits**,
  and 13,086 of the pairs are >12h apart (6,939 between 5min–12h, 453 ≤5min).
  Direction is overwhelmingly **branch → QUGEN hub**: SRINAGAR→QUGEN 5,211,
  KARNAL→QUGEN 4,113, AGRA→QUGEN 2,650, Lucknow→QUGEN 2,034, JAMMU→QUGEN
  1,875, ZIRAKPUR→QUGEN 1,529… reverse QUGEN→branch legs are noise (≤63).
- **Coverage is the big surprise: scanning is optional and hub-centric.** Of
  ~566k samples registered in the same 90d (excluding the last 2 days),
  only ~33k distinct vailids have ANY tracking row (~6%). By the sample's
  registered business unit: QUGEN 15.4% scanned, every branch ≤0.6%,
  SAMARPAN/unknown 0%. Samples processed at their own branch never transit
  and never get scanned.

**So the feature, per production data: a dispatch/receipt scan log for the
minority of samples couriered from a branch to the QUGEN hub (plus hub-side
double-scans), one row per (vailid, business-unit) leg — exactly Role A's §3
model, confirmed.** It is NOT a universal chain-of-custody for all samples,
and NOT primarily an accession gate (94% of samples are accessioned without
ever being scanned here).

Activity: every single day of the last 30 has scans — min 284 (today,
partial), 414–1,170 on full days, mean ≈ 700/day, busiest 8/16 (1,170).

## 3. Actors

- 131 distinct scan_by base names in 90d (prefix before `- Scan DT:`).
  **128 match `tbl_med_user_master.Username` exactly**; the 3 misses
  (`ABHIJEET`, `DEEPAKTECH`, `DEEPAKTTECH`) look like renamed/deleted users.
  They are usernames, not device names or free text.
- Top scanners are hub/branch couriers-receivers: RANJEET, PARAMJEET, SUNNY R,
  J P, KAVIT dominate (per-day scan_by strings differ because the date is
  embedded, so "top 20 scan_by values" is meaningless as stored — group on the
  parsed prefix).
- `received_one/two/three` hold bare usernames (case-inconsistent: `fardeen`
  vs `FARDEEN`). Top: AYUSH, SUMITJM, RANJEET, SUNNY R, TANNU…
- **The checkpoints are mostly self-service**: in 63% of filled
  `received_one` rows (4,953/7,882) the receiver IS the original scanner, and
  the median gap scan→received_one is **2 minutes** (p90 ≈ 19h); r1→r2 median
  **0 minutes** (p90 ≈ 10h). They are rapid re-scans at the same desk, not
  staged departmental hand-offs. Ordering is perfectly consistent though:
  0 rows with r1_datetime < scan_datetime, 0 with r2 < r1, 0 with r2-without-r1
  or r3-without-r2 — the null-cascade holds absolutely.

**Verdict on the three checkpoint pairs: real but marginal.** 86% of rows
never get even one; 99.25% never get the third. Port them as display +
append-on-rescan (contract quirk 1/2), but do not build workflow UI around
"stage 2/3" — the lab does not use them as stages.

## 4. bunit

12 distinct values in 90d, 13 all-time, **no NULLs, no blanks, and no
"A->B" concatenated fossils — the dead branch in §6.2 of the contract never
fired in the table's entire life** (settles Q3). All values join
`tbl_med_business_unit_master.BusinessUnitCode` (master has 18 rows; 5 units
have never scanned). 90d volume: QUGEN 35,310 (61%), SRINAGAR 5,425, KARNAL
4,912, AGRA 2,970, Lucknow 2,601, JAMMU 2,343, ZIRAKPUR 1,618, ROHTAK 1,027,
KHETARPAL 1,008, HALDWANI 861, MEDICARE 2, MEDSKY 1.

Note the type trap Role A flagged: this column stores the **string code**;
`tbl_med_mcc_unit_master.BusinessUnitCode` is an **int** FK to
`business_unit_master.id`. Same name, different meaning.

## 5. Integrity defects measured

- **Whitespace contamination (contract quirk 7, damage quantified).** Orphan
  scans (no exact vailid match in samples): 3,853 rows / 3,105 vailids in 90d
  (6.6% of scans). Of those, 2,086 contain a literal TAB or edge space, and
  2,062 match a real sample once trimmed — **more than half of all "orphans"
  are just the untrimmed insert bug.** These rows are invisible to every
  trimmed lookup in the LIS: the same barcode re-scanned creates a NEW row
  each time because `CheckInwardVailid` (trimmed) never finds the untrimmed
  row. Extreme case: one vailid with a leading tab collected **100 rows in
  2m12s** at one bunit on 2026-07-30. Genuinely unknown vailids ≈ 1,790/90d.
- **Same-(vailid,bunit) duplicate rows exist**: 434 same-bunit/same-user
  two-row pairs in 90d plus the tab-driven repeats above. The 1-second
  `Thread.Sleep` is not a dedup mechanism.
- **patient_id is a snapshot, never healed.** 3,790 90d rows have
  patient_id NULL/0; 2,004 of them (53%) NOW have a matching sample —
  registration arriving after the scan — but the code never backfills, so the
  column permanently understates linkage. Of rows WITH a patient_id, 2,068 of
  54,302 (3.8%) disagree with (or can't find) the current samples-row
  patient_id. **Join through vailid at read time; treat patient_id as a hint.**
- slno: clean. 0 duplicate (bunit, day, slno) tuples in 90d; in the last 30
  days 291 of 296 unit-days start at 1 AND have max(slno)=count — it really
  is a per-unit per-day 1..N tally (the 5 stragglers are cross-midnight
  batches). The GetVailSlno race Role A predicted has left no recent scars.
- scan_by: format is universal, embedded date always agrees with
  scan_datetime, longest value 32 chars. FIX (store username only) is safe;
  legacy display needs only `LEFT(scan_by, CHARINDEX('- Scan DT:', …)-1)`.

## 6. Timing profile

- Registration → first scan (90d, joined on exact vailid): p10 **1 min**,
  p50 **189 min (~3.2h)**, p90 **~17h**. Same-day for most, overnight for the
  long tail — consistent with evening courier runs from branches.
- Checkpoint gaps: §3 above (median 2 min / 0 min — same-desk re-scans).
- Between transit legs (branch scan → hub scan): mostly >12h (13,086 of
  20,044 cross-unit pairs), i.e. overnight courier.

## 7. Access reality (data half of contract §4/§7)

- `tbl_med_menu_master` id 55 = **"Sample Tracking"**, url
  `../worksheet/inward.aspx` (settles Q12).
- `tbl_med_security_master` menuid 55: **21 usertypes** hold the row, and on
  every row `_read`/`write`/`_delete` are all NULL — confirming "row-presence
  = full access" as the only semantic that has ever existed (Q2c). Grantees:
  Super Admin, **Client**, Doctor, Technician, Admin, Molecular, HISTO TECH,
  AUTHORISED, ACCESSIONING, NOBLE REPORTING, JANAKPURI REPORTING, OPERATION
  MANAGER (inactive type), SPL MOLECULR, Director, RSM Kashmir, BAS ADMIN,
  WALKIN CODES, SALES ADMIN, ENTRY, HLD ACCESSION, RECEPTION.
- **Quirk 20 is live, not moot: 3,311 active users with `PCC_Id > 0` belong
  to page-55 usertypes.** Client-portal users can open the scan page today,
  and per contract §7 a scan silently re-points the sample's
  `business_unit_id` and, at HO, triggers accession + billing debit. Infinity
  must NOT mirror this grant; flag to the lab as an ASK (which roles get the
  new inward capability) and record in the decision log.

## 8. What contradicts a plain reading of the legacy code

1. The three `received_*` pairs read like a formal four-stage pipeline;
   in production they are same-desk double-scans, 86% absent, median 2
   minutes after the first scan. Build them as history, not workflow.
2. "Inward at HO is how samples get registered" (contract §7) is true only
   for the ~6% of samples that transit; the accession side effect is the
   exception path, not the main one.
3. `scan_by` looks like an audit column; it is a composite display string
   whose date half is 100% redundant.
4. `patient_id` looks like an FK; it is a nullable, never-updated snapshot
   that is wrong or missing for ~10% of rows. vailid is the real join key —
   and even IT is dirty (tabs/spaces) on ~3.6% of rows.
5. The table looks keyed on the vial; it is keyed on nothing (PK id only) and
   deduped only by the in-code (vailid, bunit) lookup — which whitespace
   defeats, producing 100-row pile-ups.
6. A reader would assume indexes exist for the queries the page runs every
   second of the working day. None do.
7. The gender→'F' display bug (contract quirk 12) will show on every orphan
   row: 6.5% of rows have no patient join at all.

## 9. Role A §12 questions — answers

| Q | Answer |
|---|---|
| 1 out-of-code writers | None. 0 sys.sql_modules mention the table; no triggers on it. |
| 2 page-55 grants | 21 usertypes (list §7); url/title confirmed; bits all NULL. |
| 2b PCC reach | YES — 3,311 active PCC_Id>0 users in granted usertypes. |
| 3 fossil bunits | None ("A->B" never occurred, no NULL/blank); 13 units all-time, all valid codes. |
| 4 checkpoints used? | 13.6% / 3.0% / 0.75%; 63% same-user; median 2 min; cascade never violated; all-three-full (4-scan ceiling) reached on 0.75% — it binds essentially never. |
| 5 orphans | 6.5% patient-NULL rows; 53% later have a matching sample but are never adopted (patient_id stays NULL); >half of no-sample orphans are whitespace artefacts. Inward is optional: ~6% of registered samples get scanned. |
| 6 slno | Never NULL/0; genuine per-unit per-day 1..N; zero duplicate tuples in 90d. |
| 7 multi-row vials | Max 2 real legs (branch→hub); ≥3 rows = defects (tabs, re-scans); 434 same-unit duplicate pairs in 90d. |
| 8 scan_by drift | Zero drift: 100% `user- Scan DT:date`, max 32 chars, embedded date always matches. |
| 9 accession-by-inward share | Approximated via coverage: ≤15.4% of QUGEN-registered samples (≤6% overall) even have a scan, so Inward-triggered accession is a minority path. Exact activity-log matching not run (expensive on prod); revisit only if Role C needs the precise split. |
| 10 business_unit_id | Populated on samples (used as the coverage group key, §2); per-scan overwrite not directly verified row-by-row against last scan — the 98% branch→hub pair pattern is consistent with "last scanning unit owns the sample". |
| 11 indexes | Tracking: PK(id) only — nothing else. Samples: vailid richly indexed. Role C must add tracking indexes on vailid and (scan_datetime, bunit). |
| 12 menu 55 | "Sample Tracking", `../worksheet/inward.aspx`. |

## 10. Directives for Role C (from data, not code)

1. **Migration:** add nonclustered indexes on `vailid` and
   `(scan_datetime, bunit)` to the tracking table (small table, cheap build;
   still a production migration — numbered script, QUOTED_IDENTIFIER).
2. **Trim vailid** (spaces AND tabs) on insert and on every lookup; when
   reading legacy rows, match trim-insensitively or 3.6% of history is
   unreachable.
3. Keep the (vailid, bunit) one-row-per-leg model and the received_1..3
   null-cascade byte-for-byte; surface "already fully received" instead of
   the silent 5th-scan no-op.
4. Store the plain username in scan_by's replacement; parse the legacy
   composite only for display.
5. Join to patient/samples through vailid at read time; never trust the
   stored patient_id for scoping decisions.
6. slno = per-unit per-day sequence; compute race-safely (the meaning is
   proven and operators do restart at 1 daily).
7. Do not grant the Infinity inward capability to client-portal roles by
   default; the legacy grant list (§7) goes to the lab as an ASK.

---
*Role B, F1, 2026-08-17. All queries SELECT-only against Noble via ad-hoc
helper (deleted after use); no rows written, no DDL, no temp objects.*
