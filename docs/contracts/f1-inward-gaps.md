# F1 — Sample transit / inward tracking: completeness gap register

Role E (completeness critic) output for Phase P1, 2026-08-17. The last gate
before P1 may close.

---

## 0. ORCHESTRATOR CORRECTION — the working tree is AHEAD of everything running

Added after Role E reported. Two of its statements rest on an assumption that
production measurement disproves, and the underlying fact is more serious than
the correction.

**The source files were rewritten at 14:26–14:36, hours after the verified
deploy (SQL ~11:50, staging containers ~12:05) and after every Role D probe
(~12:00).** Nothing that runs anywhere is built from the current working tree.

Measured against production Noble at 14:4x:

```
indexes on tbl_acc_inward_sample_tracking:
  PK_tbl_cpath_inward_sample_tracking
  IX_inf_inward_vailid
  IX_inf_inward_scan_datetime            <- only TWO of the file's three

usp_inf_inward_scan (deployed definition):
  contains 'IX_inf_inward_bunit_scan_datetime' hint : 0
  reads samples WITH (UPDLOCK ...) inside the txn   : 0
```

Consequences, in order of importance:

1. **Role E's "deployment proven indirectly" is invalid.** The reasoning —
   "the procedure hard-hints the third index, a missing index would fail, the
   probes inserted successfully, therefore 105 is deployed" — is sound logic
   over the wrong timeline. The probes ran against the PREVIOUS revision of
   both files, which carried no such hint. `IX_inf_inward_bunit_scan_datetime`
   does not exist in Noble. The directive-1 row above is corrected accordingly.
2. **Deploying `107` alone would break scanning outright** — a hard `INDEX()`
   hint naming an absent index is a runtime error, not a plan degradation.
   Ground rule 4 (deploy ordering) applies: 105 must land before 107.
3. **The rewritten revision is UNVERIFIED.** Role D's transcript describes the
   revision that is deployed, not the one on disk. Shipping the new files and
   citing that transcript would be precisely the "silence reads as done"
   failure this pipeline exists to prevent.

**What the rewrite appears to improve** (read, not assumed): the deployed
revision reads the sample's `business_unit_id` BEFORE `BEGIN TRANSACTION` and
uses it inside for the audit's old value — two concurrent scans can therefore
record the same stale old→new transition. The new revision reads it inside the
transaction under `UPDLOCK, HOLDLOCK`. That is a real fix to a real race.

**Why it was NOT deployed on discovery.** The same change makes every scan of a
real sample take `UPDLOCK, HOLDLOCK` on `tbl_med_mcc_patient_samples` (5.51M
rows, written continuously by the live LIS during the working day).

Stated precisely, because the scale matters and it would be easy to overstate:
the lock is a key-range lock on ONE vailid, held for a transaction that runs in
milliseconds, and the legacy page already takes an exclusive lock on that same
row when it updates `business_unit_id`. The incremental exposure is mostly the
few milliseconds earlier the lock is acquired. The realistic risk is therefore
LOW — but it is unmeasured, no probe can exercise it (probes never touch a real
sample), the revision is unverified, and nobody asked for the change. Low-risk
is not the same as measured, and a new lock on a live clinical table during a
working shift is not a call to make silently.

**State as it stands: everything RUNNING is the verified revision** — the
safest possible form of this divergence, and a trap for whoever deploys next.
The decision (deploy-then-re-verify, or revert the tree to the verified
revision) belongs to the user and is recorded as **G-0**, blocking P1 closure
above every other item.

### 0.1 G-0 RESOLVED — deployed and re-verified

User chose deploy-then-re-verify (2026-08-17). Executed in dependency order:

- `105` → `106` → `107` deployed to Noble. Post-deploy measurement:
  `IX_inf_inward_bunit_scan_datetime` now present (three indexes total);
  `usp_inf_inward_scan` shows `has_hint = 1`, `reads_sample_in_txn = 1`,
  `uses_quoted_identifier = True` on both procedures.
- Staging `api` + `web` rebuilt (the image build is the compile gate) and
  restarted.
- **Full suite re-run against the deployed rewrite: same 23/24** — P01–P11,
  P13–P24 PASS; P12 remains only the wording judgment Role D already ruled
  PASS-with-amended-expectation. Evidence now describes what is actually
  running.
- Probe cleanup re-proven `0 / 0` at 14:59:57 IST.

### 0.2 G-2 CLOSED — fixed and verified

The silent CSV truncation is fixed: the response carries
`X-Inward-Truncated: <returned> of <total>`, the file's last line says so in
words (because nobody opening it in Excel sees a header), and the screen no
longer promises the CSV as "the rest" once the total passes the ceiling.

Verified read-only over real legacy scans (`07_csv_truncation.mjs`, 3/3):

```
G2a  header "10000 of 57841", 10,002 lines, still text/csv
G2b  last line: "TRUNCATED — this file holds the first 10,000 of 57,841
     matching scans. Narrow the date range to export the rest."
G2c  an export that FITS carries no header and no TRUNCATED line (no false alarm)
```

### 0.3 G-3 RESOLVED AS A REAL GAP — cause is pre-existing, decision is the lab's

The read-only closure batch (`08_readonly_closure.mjs`) closed G-6, G-7 and
G-9 (5/6), and turned G-3 from "untested" into a measured defect:

**A branch technician can scan, but their inward log is empty.** Measured with
an active SRINAGAR accessioning account against the second-busiest scanning
unit in the lab (5,453 scans in 90 days): `/api/inward/` returns `200` with
`rows: 0, total: 0`.

Root cause, traced (`09_technician_scope.mjs`): `Technician` is not in
`InfinityRoles.UnrestrictedReporters` (SuperAdmin, Admin, LabManager,
Reporting), and branch lab staff hold no client-code mappings — they are not
tied to collection centres. `GetReportClientCodesAsync` therefore returns
`Denied`, and the endpoint correctly turns Denied into an empty list rather
than the whole lab.

**This is NOT introduced by P1.** The same account gets `403` from the
pre-existing `/api/reports/` worklist (Technician holds no `report:view` at
all). P1 is simply the first feature where the gap has teeth, because Inward
is *for* branch technicians: the scan path deliberately has no scope check
(contract KEEP #18 — a hub receives every client's vials), so scanning works
while the log that proves it happened does not.

Not fixed here, deliberately: deciding who may see which patients' transit
history is a permissions policy, not a build detail. Recorded as an **ASK**
with two candidate closures for the lab:

1. give the inward LIST a unit-scoped rule of its own — a technician sees the
   rows of their OWN business unit regardless of client mapping (matches the
   legacy page, which scoped branch users to `bunit` and nothing else); or
2. add `Technician` to the unrestricted reporters (broader, and it changes far
   more than Inward).

Option 1 matches the legacy behaviour Role A documented (§5.2: branch users
were filtered to their own `bunit`, never by client) and is the narrower
change; it is the recommendation, but it is the user's call.

Inputs diffed: the behaviour contract (`f1-inward-contract.md`, Role A), the
production schema findings (`f1-inward-schema.md`, Role B — its §10 directives
are contract-level), the verification transcript (`f1-inward-verification.md`,
Role D), and Role C's build remainder (reproduced verbatim in Appendix A,
because it exists in no other file). Spot-checks were run against the built
surface: `api/db/sql/105–107*.sql`, `InwardEndpoints.cs`, `InwardRepository.cs`,
`web/src/pages/Inward.tsx`, plus `77_usp_inf_worksheet_filters.sql`,
`ClientPicker.tsx`, `App.tsx`, `docs/port-decisions.md`,
`docs/port-inventory.md`.

**Terminal statuses used**

| Status | Meaning |
|---|---|
| **VERIFIED** | A probe executed against the deployed staging bundle / production data settles it. Probe cited. |
| **VERIFIED-BY-INSPECTION-ONLY** | Proven by reading the deployed code; execution was impossible or forbidden on prod. Role D's §5 U-register or an equivalent citation given. |
| **ACCEPTED-REMAINDER** | Role C left it deliberately undone/narrowed; cited by letter from Appendix A. |
| **ASK** | Needs the lab; not a testable behaviour. |
| **OPEN** | Nobody covered it. A gap by definition. |

Silence is not coverage: every line below carries a citation or a gap number.

**Headline.** Of the 41 contract lines (22 quirks + 7 Role B directives + 12
open questions), **none is OPEN with zero coverage** — but **9 carry
inspection-only proof**, and 4 of those 9 are the writes that touch a REAL
sample, which have never executed anywhere. Fourteen gap items are listed in
§5; most are closable read-only in one script, one is a genuine build defect
(silent CSV truncation), and one is only closable on a disposable database.

---

## 1. The §11 quirk register — all 22 lines

| # | Quirk (abbrev.) | Verdict in contract | Terminal status | Citation / note |
|---|---|---|---|---|
| 1 | One row per (vailid, bunit); received_1..3 = 2nd–4th scan, null-cascade | KEEP | **VERIFIED** | P01–P04 (`new_leg → checkpoint_1..3`), P26 (exactly one row per probe barcode, full cascade with timestamps), P16 (race → one leg + one checkpoint) |
| 2 | 5th+ scan = silent no-op; surface it | KEEP + voice | **VERIFIED** | P05 (`already_full`), P15 (amber banner, verbatim screenshot). The rider "side effects still run on the 5th" rides on U1 and is inspection-only — see #4 |
| 3 | No-workorder scan still inserts an orphan row, red feedback | KEEP | **VERIFIED** | P01 (`noWorkorder=true`, row written), P26 (`patient_id NULL`), P12 (red banner) |
| 4 | Every scan overwrites `patient_samples.business_unit_id`, no audit, no `modifiedby` | KEEP overwrite / FIX audit | **VERIFIED-BY-INSPECTION-ONLY** + **ACCEPTED-REMAINDER (d)** | Role D §5 U1/U2 (107 sql 350–368). GATING positively verified: P28 proved zero audit rows and zero sample-table touches on the no-sample path. Remainder (d) narrows the audit to actual unit CHANGES and leaves `modifiedby` alone — see the ruling in §3.1. Gap **G-1** |
| 5 | Scan at HO of a status-1 sample performs full accession | KEEP | **VERIFIED-BY-INSPECTION-ONLY** | Role D §5 U3 (`InwardEndpoints.cs` 152–194). Negative half verified: P01 asserted `accession.triggered=false` for a non-qualifying scan. Gap **G-1** |
| 6 | `scan_by` = "user- Scan DT:date" composite | FIX | **VERIFIED** | Writer: P26 (`scan_by` plain `[RAVI]`). Reader: P23 (295 real legacy rows, zero `- Scan DT:` leaking through), P25 (SQL cross-check) |
| 7 | `vailid` saved untrimmed | FIX | **VERIFIED** | P07 (`"  …\t"` → one `new_leg`, clean re-scan → `checkpoint_1`), P26 (`len 15`, stored trimmed). One residual code-level divergence found by inspection: gap **G-10** |
| 8 | `slno` count+1, unlocked, `.AddSeconds(0.1)` | FIX mechanism / KEEP meaning | **VERIFIED** | P06 (360→361 strictly increasing), P27 (continued live scanner's 359; zero duplicate `(bunit, slno)` today), P16 (concurrent scans did not fork) |
| 9 | Dead "bunit A->B" concatenation branch | FIX (don't port) | **VERIFIED-BY-INSPECTION-ONLY** | Confirmed by reading `107_usp_inf_inward.sql`: no concatenation anywhere on the scan path. Role B §4 measured zero fossil rows in the table's entire life, so there is nothing to execute against |
| 10 | `Thread.Sleep(1000)` on every scan | FIX | **VERIFIED-BY-INSPECTION-ONLY** | No delay exists anywhere in `usp_inf_inward_scan` / `InwardRepository.ScanAsync` / `Inward.tsx`. No probe measured scan latency; P01–P05 drove five scans inside one script run, which is consistent with but not proof of sub-second cadence. Non-risk-bearing |
| 11 | Three columns all headed "Received1"; datetimes fetched, never shown | FIX | **VERIFIED** | P08 (all three slots return username AND timestamp), P14 (`"received1":"RAVI 17 Aug 2026, 06:30 am"`, screenshot) |
| 12 | NULL gender renders "F" | FIX | **VERIFIED** | P08 (`sex:null`), P14 (`"patient":"—"`). Reader-side `MapSex` returns null for null |
| 13 | Client filter silently drops orphan rows | FIX | **VERIFIED** (lab half) + **ACCEPTED-REMAINDER (c)** (client-scoped half) | P08 — orphan probes visible to the unscoped lab account. The client-scoped half is unfixable by nature: an orphan row has no client to scope by. Accepted per orchestrator brief; see §3.2 |
| 14 | Date window always ANDed with SID; window 00:00:01–23:59:59 | FIX | **VERIFIED** | P09 (`sid=A1` with a July window → `found:1`). Inclusive edges by construction (`>= @from AND < @to+1day`, 107 sql 89–91, 165) — a construction proof, stronger than a boundary probe |
| 15 | `orderby slno desc` interleaves days/units | FIX | **VERIFIED** | P08 (`scannedAt` non-increasing across 379 rows), P23 (strict DESC over 295 real rows / 3 days) |
| 16 | `CheckUserPage` ignores the `_read/write/_delete` bits | KEEP as fact → F4 | **ACCEPTED** (deliberately not ported) | Role D §6: superseded by Infinity's capability model. **Not yet recorded in the decision log** — gap **G-5** |
| 17 | Permission checked only on `!IsPostBack` | FIX | **VERIFIED** | P17/P18 (401 anonymous), P19 (403 missing CSRF), P21 (403 capability). Both routes carry `RequireCapability` per request (`InwardEndpoints.cs` 29–35) |
| 18 | No scope check on the scan target | KEEP core / ASK edges | **VERIFIED-BY-INSPECTION-ONLY** (core) + **ASK** (edges) | The KEEP is the ABSENCE of a check; inspection is the right proof for an absence (`InwardEndpoints.cs` 119–122, no scope call in `Scan`). The edge question — may a branch unit scan vials of clients not mapped to it — is unanswered and unrecorded: gap **G-5** |
| 19 | HTML-as-`.xls` export, no size cap | FIX | **VERIFIED**, with a NEW defect | P10 (`text/csv; charset=utf-8`, honest filename, documented header, body not HTML). The replacement cap truncates silently: gap **G-2** |
| 20 | PCC read-only intent never enacted (client users can scan) | ASK | **VERIFIED** (hole closed) + **ASK** (final grant list) | P21 (client scan → 403 `order:accession`), P22 (`hasScanBox:false`). The 3,311-user legacy hole is proven closed. Which roles ultimately scan is a lab decision, **unrecorded** — gap **G-5** |
| 21 | Unhandled exceptions mid-chain leave half-accessioned samples | FIX | **VERIFIED-BY-INSPECTION-ONLY** | Role D §5 U3. The one-transaction half (leg + overwrite + audit) has never executed with a real sample row present; the two-step "arrived, not registered" failure path has never been triggered. Gap **G-1** |
| 22 | `FillCombo("PCC")` lists inactive clients | KEEP | **VERIFIED-BY-INSPECTION-ONLY** — *closes remainder (f)* | Role C left this open. Settled here: `77_usp_inf_worksheet_filters.sql` 51–60 returns `is_active` as a column and applies **no** `IsActive` predicate, and `Inward.tsx` 255 uses `ClientPicker` at its default `activeOnly = false` (`ClientPicker.tsx` 62, 102). Inactive centres are listed, as the KEEP requires |

**Quirk tally:** VERIFIED 14 · VERIFIED-BY-INSPECTION-ONLY 7 · ACCEPTED 1 ·
OPEN 0. Three lines carry ASK riders (16, 18, 20).

## 2. Role B's directives and Role A's open questions

### 2.1 Role B §10 directives (contract-level)

| # | Directive | Status | Citation |
|---|---|---|---|
| 1 | Add nonclustered indexes on `vailid` and `(scan_datetime, bunit)` | **PARTLY VERIFIED — see correction** | Two indexes (`IX_inf_inward_vailid`, `IX_inf_inward_scan_datetime`) are deployed and exercised by P01–P16. The THIRD (`IX_inf_inward_bunit_scan_datetime`) is **not deployed** — see §0 correction below. P16's key-range serialization corroborates `IX_inf_inward_vailid` |
| 2 | Trim spaces AND tabs on insert and on every lookup; read legacy trim-insensitively | **VERIFIED** (write/lookup) + **VERIFIED-BY-INSPECTION-ONLY** (legacy dirty read) | P07/P26 for the write and lookup. The list's clean-side match (107 sql 146–147, 164) reaches damaged legacy rows, but no probe read an actual dirty legacy row — gaps **G-4**, **G-8** |
| 3 | Keep the (vailid, bunit) model and the null-cascade byte-for-byte; surface "already fully received" | **VERIFIED** | P01–P05, P15, P26 |
| 4 | Store the plain username; parse the legacy composite for display only | **VERIFIED** | P26 (writer), P23/P25 (reader) |
| 5 | Join to samples through vailid at read time; never trust stored `patient_id` | **VERIFIED-BY-INSPECTION-ONLY** | 107 sql 146–157 (`OUTER APPLY` on the cleaned vailid; `patient_id` returned from the JOIN, not the stored column). Every probe row was an orphan, so the affirmative half — a real row rendering its patient/client/tests — was never asserted: gap **G-9** |
| 6 | slno per-unit per-day, computed race-safely | **VERIFIED** | P06, P16, P27 |
| 7 | Do not grant the inward capability to client-portal roles by default | **VERIFIED** (build) + **ASK** (final list) | P21/P22; ASK unrecorded — gap **G-5** |

### 2.2 Role A §12 open questions

All twelve were answered by Role B §9 from production data; they are settled,
not merely covered.

- **VERIFIED (settled from production): Q1** out-of-code writers (none),
  **Q2/Q2b/Q2c** page-55 grants (21 usertypes, 3,311 PCC users, bits all NULL),
  **Q3** fossil bunits (none), **Q4** checkpoint fill rates, **Q5** orphans and
  coverage, **Q6** slno reality, **Q7** rows-per-vial, **Q8** `scan_by` drift
  (zero), **Q11** indexes, **Q12** menu 55 label.
- **ACCEPTED (partially answered, no residual risk): Q10** — the per-scan
  overwrite was not verified row-by-row against the last scan's unit, and the
  "does anything else read `business_unit_id`" column-usage scan was not run.
  No new risk: Infinity keeps the legacy overwrite semantics exactly, so any
  reader that works today keeps working.
- **ASK: Q9** — the exact Inward-vs-Accession split of "Sample Registered"
  activity-log rows was approximated (≤6% of samples scanned), never measured.
  This is the same thread as Role C remainder (i): gap **G-11**.

## 3. Rulings on the tensions

### 3.1 P12's amended expectation — **ENDORSED**

Role D swapped its own probe's literal regex ("No workorder … scan logged") for
the deployed banner "Received at QUGEN · #360 today · no workorder yet"
(`alert--error`). I endorse the ruling.

The contract at that point (quirk 3 KEEP + §6.3 FIX) demands three things:
the orphan scan is still logged and the operator can tell; the operator is told
no workorder exists; the signal is red. The banner does all three, and it does
them *better* than the probe's phrasing — it states the receipt affirmatively
with the unit and today's tally, which the legacy page never did. The literal
string was Role D's authored proxy, not a contract line, and Role D declared
the amendment rather than quietly relaxing the assertion.

Two caveats, weighed and dismissed:

- The probe aborted before its "input cleared / focus returned" sub-assertions.
  P13 and P15 subsequently drove **four further keyboard-only scans through the
  same box**, each producing a fresh banner. That is impossible unless the box
  cleared and refocused each time. The corroboration is sufficient; no re-run
  is required to close.
- The missing `p12_first_scan_banner.png` is corrected in Role D's own §2. A
  self-corrected citation is the behaviour one wants from a verifier.

One process note for future phases, not a P1 blocker: an amended expectation
authored by the same role that authored the probe is self-marking. It is
legitimate here only because the contract text is specific enough to adjudicate
against independently — which I did. Where a contract line is vaguer, an
amendment should come to Role E before the transcript closes.

**Colour precedence** (amber `already_full` beating red `no workorder` on the
5th scan): correct. "Nothing was recorded" is the louder operational fact; the
workorder text is retained. Cosmetic, defensible, on the record.

### 3.2 `sid_raw` emitted by the procedure, dropped by the API — **a real gap, low severity; NOT a FIX #7 failure**

`usp_inf_inward_list` returns `sid_raw` (107 sql 122) specifically so a
whitespace-damaged legacy row is recognisable; `InwardRepository.InwardRow` has
no such field, so the JSON never carries it (P08: `sid_raw_exposed_as: ABSENT`).

Ruling: FIX #7 is **satisfied** — its mandate is trim-on-write plus trim-aware
lookup, both positively proven (P07/P26), and the list deliberately matches on
the cleaned side so damaged history stays reachable. Nothing in the contract
demands exposure of the raw value.

But it is not cosmetic either. Role B measured ~3.6% of vailids carrying tabs
or stray spaces, including one barcode that accumulated 100 rows in 2m12s. In
the UI those rows now render under their *cleaned* SID — identical text to
their clean twin. An operator investigating a duplicate leg sees two rows that
look the same and cannot tell which is the damaged one, and P1 ships no tooling
to repair them either. The consequence is confusion during an investigation,
not data loss or a wrong action.

Disposition: **gap G-8**, low rank, with a cheap closure (map `sid_raw`, mark
rows where `sid_raw <> sid`). It does not block P1 on its own.

### 3.3 Leading-zero SID variants (`9336728` / `09336728` / `009336728`) — **NOT P1's to own; recorded limitation + ASK**

Role D caught one scanner producing all three within five seconds, as three
distinct rows. Trim cannot heal it: the zeros are real characters.

P1 must not normalise them, for three reasons. (a) They are genuinely different
strings; collapsing them requires knowing that a leading zero is
non-significant in the lab's SID scheme, which is a registration-level fact
nobody has established — and if it is ever wrong, the fix silently merges two
different vials' custody trails, a strictly worse failure than the one it
cures. (b) The same variants exist in `tbl_med_mcc_patient_samples`, so a fix
confined to the tracking table would make the two stores disagree — a direct
violation of ground rule 2 (one store). (c) The legacy page behaves identically,
so P1 introduces no regression by leaving it.

Disposition: record as a limitation in `docs/port-decisions.md` with the
measurement, plus an ASK to the lab ("is a leading zero significant in a SID?").
If the answer is no, the work belongs where SIDs are minted and validated —
order entry / accessioning, i.e. the P3-era catalogue-and-registration work or a
standalone data-hygiene item — not in a transit-tracking read/scan port. An
optional, non-blocking P1 mitigation exists if the lab wants it: on an exact-SID
search, also report "N rows found for zero-padded variants".

### 3.4 U3 (accession-at-HO) unexecutable on prod — the residual risk that ships

**What ships unverified:** every write this feature performs against a REAL
sample. Specifically U1 (the `business_unit_id` overwrite + `modifieddate`),
U2 (its audit row), U3 (the HO accession gate, the call into the existing
`AccessionRepository.AccessionAsync`, and the "arrived, not registered" failure
path), U4 (the outcome banners in their workorder-matched form) and U5 (the
scan response's patient fields). Every one of the 29 probes took the
`@sample_id IS NULL` branch.

**Residual risks, named plainly and ranked by how badly they end:**

1. **Lock contention against the live LIS (worst, and the least discussed).**
   The scan transaction takes `UPDLOCK, HOLDLOCK` on a row of the 5.51M-row
   `tbl_med_mcc_patient_samples` **first**, and holds it across the tracking
   lookup, the slno computation, the insert/update and the audit insert (107 sql
   271–397). No probe has ever acquired that lock on an existing row — the
   no-sample path takes only a range lock on an absent key. So the blocking and
   deadlock behaviour of this transaction against the legacy Inward page, the
   legacy Accession page and the LIS's own writers, at ~700 scans/day, is
   **entirely unmeasured**. If it deadlocks, it deadlocks in production, on
   both applications at once.
2. **Gate too narrow** (`NoWorkorder:false, ScannerBusinessUnitId:1,
   SampleStatus:1`): HO scans log arrival but never register. Visible
   immediately (no "Registered — now on the worksheet." sub-line), recoverable
   from the Accessioning queue. Low harm.
3. **Gate too wide**: a sample is registered — and therefore *billed* — earlier
   than it should be. Partially mitigated by reuse of the single existing
   accession procedure and its `amount_checked` charge-once latch, so no
   double-charge; but a genuinely-uncharged sample would take a real debit
   against a real client balance. This is the only failure mode with money in
   it, and the hardest to reverse.
4. **Audit fidelity**: an old-unit or actor value written wrong would go
   unnoticed until someone reads the trail — by which time it is the record.

**What a disposable test database (Noble backup restored to a throwaway
instance) would close:** all of U1–U5; quirk 21's two-step failure path (kill
the accession step mid-flight and confirm "arrived, not registered" is
coherent and retryable); the whitespace-damaged-legacy-row fallback write path
(G-4, insert a tabbed row directly and scan it); positive client scoping (G-6);
the row-cap path (G-7); the no-business-unit refusal; quirk 18's cross-client
scan; and the lock-contention question under a replayed write load. **One
artefact closes eight of the listed gaps** — and every later phase (P2 dues,
P3 catalogue authoring, P5 the payment-bearing portal) will hit the same wall
harder. It is the single highest-leverage investment available to this project.

**A proportionate prod-safe partial closure exists now, and I recommend it.**
Scan, once, under supervision at head office, a REAL sample that is (a) already
`sample_status = 2` (so the accession gate cannot arm and no billing can fire)
and (b) already owned by business unit 1 (so `business_unit_id` is rewritten to
the value it already holds and no audit row is due). The only production
mutation is `modifieddate` on one already-registered sample. That single scan
exercises: the transaction holding a real `UPDLOCK` on a real sample row, the
leg write alongside it, the `IF ISNULL(@old_bu_id,-1) <> @bu_id` no-audit
branch, and U5's patient fields in the response — i.e. the structural half of
U1/U2 and the lock behaviour of risk 1. It cannot close U3/U4, which need the
test database. Clean up the tracking leg afterwards per ground rule 1.

## 4. Role D's §6 not-covered table and §7 observations, adjudicated

| Role D item | My ruling | Why |
|---|---|---|
| §6 KEEP #4 / FIX #4 / KEEP #5 / quirk 21 (real-SID writes) | **REAL GAP — highest** | §3.4. Gap G-1 |
| §6 Quirk 18 (no scope check on the scan target) | **ACCEPTED LIMITATION** for the core; the edge is an **unrecorded ASK** | Proving an absence by inspection is correct methodology; a probe could only show that one particular vial was scannable. The ASK ("may branch units scan unmapped clients?") is contract text nobody has actioned — G-5 |
| §6 Positive client scoping (client sees its OWN rows) | **REAL GAP — low/medium**, and cheaper to close than Role D thought | P20 asserted on an empty set, which proves invisibility, not visibility. No test DB needed: pick a client code Role B showed has scans and run the list read-only as that client over a 90-day window. Gap G-6 |
| §6 FIX #14 inclusive day-bound edges | **COSMETIC** to test | `>= @from AND < @to+1day` is inclusive by construction. A construction proof beats a midnight-scheduled probe; nothing further owed |
| §6 `?bunit=` filter | **REAL GAP — low**, and it hides a bigger one | The filter itself is same-predicate-family, low risk. But the *actor-derived* branch lock (107 sql 110–111: `@actorBuId > 1` forces the actor's own unit, failing closed to `__INVALID_BUSINESS_UNIT__`) is a **scope control** that Role D never mentions at all — no branch-unit account was probed. Silence ⇒ OPEN. Gap G-3 |
| §6 Row cap / `capped:true` / CSV 10k ceiling | **REAL GAP — medium**, and worse than "untested surface" | The cap path is trivially probe-able read-only (`maxRows=5`). More seriously, the CSV's own 10k ceiling truncates *silently* while the UI points the operator at it as the complete answer. Gaps G-7, G-2 |
| §6 Scan input rejections (empty, >50, no business unit) | **REAL GAP — low**; two-thirds prod-safe | Empty and oversize are rejected at the endpoint before any DB call (`InwardEndpoints.cs` 135–138) — probing them writes nothing and is safe on prod today. The no-business-unit RAISERROR needs a purpose-made account or the test DB. Gap G-7 |
| §6 Whitespace-damaged LEGACY row fallback (60-day) | **REAL GAP — medium** | Twenty lines of write-path logic that have never executed and, as things stand, will first execute in production against a real operator's vial. Gap G-4 |
| §6 Quirk 16 / FIX #17 (legacy permission model) | **ACCEPTED LIMITATION** | Deliberately superseded; per-request enforcement of the new model positively proven (P17–P21). Owes a decision-log line only — G-5 |
| §6 Quirk 22 (inactive clients listed) | **CLOSED — not a gap** | Settled here by inspection; see quirk 22 above. Also closes Role C remainder (f) |
| §6 Quirk 20 ASK (which roles scan) | **REAL GAP — documentation** | Role B §7 and `InwardEndpoints.cs` both say "record it in the decision log"; `docs/port-decisions.md` has no P1 entry at all. G-5 |
| §7.1 `sid_raw` dropped | **REAL GAP — low** | §3.2. G-8 |
| §7.2 Timezone rendering | **COSMETIC / environment** | The API carries explicit `+05:30`, the CSV stamps IST server-side, lab workstations are IST. Owes one line in the ops notes. G-12 |
| §7.3 Leading-zero SID variants | **RECORDED LIMITATION + ASK — not P1's** | §3.3. G-14 |
| §7.4 Rate limiter / Secure-cookie behaviour | **NOT A GAP — positive evidence** | Two security controls observed working against a determined harness. No action |

## 5. The gap list, ranked by risk

| # | Gap | Rank | Proposed closure (one line) |
|---|---|---|---|
| **G-1** | Every write against a REAL sample is unexecuted (U1–U5, quirk 21's transaction and failure path); the scan transaction has never held a real `UPDLOCK` on `tbl_med_mcc_patient_samples` while the LIS writes concurrently | **HIGH** | Restore a Noble backup to a disposable instance and run U1–U5 there; meanwhile take the proportionate prod-safe scan described in §3.4 (status-2, already-unit-1 sample) to exercise the lock and the no-audit branch |
| **G-2** | The CSV export silently truncates at 10,000 rows (`InwardEndpoints.cs` 74, 107 sql 86) while the screen tells the operator "export CSV for the rest" — reachable in ~14 normal days of scans | **MED-HIGH** | Emit the true total with the export (trailing row or response header) and soften the UI copy, or refuse ranges over the ceiling with an explicit message |
| **G-3** | Branch-unit list scoping (`@actorBuId > 1` forcing the actor's own unit) never exercised — a scope control that nobody probed and nobody listed | **MED** | One read-only list call as a branch-unit account: assert every row's unit is that branch, and that `?bunit=` naming another unit returns nothing |
| **G-4** | The 60-day whitespace-damaged-legacy-row fallback (107 sql 298–317) has never run; first execution will be in production | **MED** | Read-only rehearsal of the fallback SELECT against a known dirty vailid on prod (Role B has candidates), then the write path on the test DB |
| **G-5** | No P1 entries in `docs/port-decisions.md`: the quirk-20 ASK (which roles scan), the quirk-18 edge ASK (branch scanning unmapped clients), the quirk-16 deferral to F4, the accepted remainders, and the U-register as accepted residual risk. `docs/port-inventory.md` row 6 still reads "IN PROGRESS (P1)" | **MED** (gate §4.1/§4.4 is unmet without it) | Append D6–D10 recording each ASK/KEEP/accepted-limitation with date and decider; flip inventory row 6 to PORTED with links to the contract, schema, verification and this file |
| **G-6** | Positive client scoping unproven — P20 ran against an empty result set | **LOW-MED** | Read-only list as a client account over a 90-day window for a client Role B showed has scans; assert rows returned and all belong to that client |
| **G-7** | Untested surfaces, all closable read-only with no writes: `?bunit=` filter, row cap / `capped:true` (`maxRows=5`), empty and >50-char scan rejections (400 before any DB call) | **LOW-MED** | One four-assertion read-only script against staging |
| **G-8** | `sid_raw` emitted by the procedure but dropped by the API: a damaged legacy row is indistinguishable from its clean twin in the UI | **LOW** | Map `sid_raw` into `InwardRow` and mark rows where `sid_raw <> sid` ("damaged barcode") |
| **G-9** | No probe ever asserted a positive patient/client/tests join on a real row — all probes were orphans, so Role B directive 5's affirmative half is unproven | **LOW** | Read-only assertion that at least one real row in today's window carries a non-null `patientName` and `clientCode` |
| **G-10** | Trim divergence between API and procedure: `ScanRequest`'s `.Trim()` removes only *leading/trailing* whitespace, while the procedure also strips *interior* TAB/CR/LF (107 sql 224–225). For a barcode with an interior control character, the accession step and the length check act on a different string than the one stored | **LOW** | Return the cleaned vailid from the procedure and use that value for the `AccessionAsync` call (or apply the same strip in the endpoint) |
| **G-11** | Nothing in the Infinity stack writes `sp_user_activity_log` (verified: zero references in `api/`), so inward-triggered registrations never appear in the LIS's own "Sample Registered" activity report. Ties Role C remainder (i) to Role A Q9 | **LOW** (pre-existing, not introduced by P1 — Infinity's Accessioning screen already behaves this way) | ASK the lab whether the legacy activity report must still show Infinity registrations; if yes it is an F5 / P4 item, not a P1 rebuild |
| **G-12** | Timestamps render in the viewer's local timezone (staging container shows UTC) | **COSMETIC** | One line in the ops notes: read staging from an IST workstation |
| **G-13** | No nav entry; Inward reached from the Accessioning header button or `/inward` directly (remainder b) | **COSMETIC / ACCEPTED** | Accepted as built; revisit when the top bar is redesigned (the reasoning is preserved in `App.tsx`) |
| **G-14** | Leading-zero SID variants produce separate rows and separate custody trails | **RECORDED LIMITATION** | Decision-log entry with Role D's §7.3 measurement + an ASK to the lab on SID significance; any fix belongs at SID minting/validation, not in F1 |

**Gap count by status:** HIGH 1 · MED-HIGH 1 · MED 3 · LOW-MED 2 · LOW 4 ·
COSMETIC/ACCEPTED 3 (of which G-14 is a recorded limitation).

**Cheap-closure cluster.** G-3, G-6, G-7 and G-9 are all read-only assertions
against the deployed staging bundle — no writes, no probe rows, no cleanup
burden, and they need one account with a branch business unit plus one client
account with recent scans. That is a single short script, and it converts four
gaps to VERIFIED.

## 6. Verdict on the gate

The exit criterion (plan §4.2) is: gap list empty, **or** every remaining item
explicitly ACCEPTED by the user in the decision log.

Neither holds today. `docs/port-decisions.md` contains no P1 entry of any kind
— not the ASKs, not the accepted remainders, not the U-register as accepted
residual risk — and `docs/port-inventory.md` still shows Inward as IN PROGRESS,
so the page-level gate (§4.1) is unmet too. There is also one live build defect
(G-2) that is neither fixed nor accepted.

**Recommendation: NO — P1 cannot close as it stands.** It is a short list, not
a rebuild:

1. Fix G-2 or accept it explicitly (silent truncation of an export the UI calls
   complete).
2. Run the read-only probe batch closing G-3, G-6, G-7, G-9 — one script, no
   writes.
3. Record G-5's decision-log entries (quirk 20 ASK, quirk 18 edge ASK, quirk 16
   → F4, remainders (b)(c)(d)(i)(j), G-14's limitation) and flip the inventory
   row to PORTED.
4. Have the user explicitly ACCEPT G-1's residual risk with the test-database
   commitment attached (and, if they want the cheap half now, the supervised
   status-2 scan in §3.4).

With those four done, every remaining line is VERIFIED, ACCEPTED or ASK, and
P1 closes.

---

## Appendix A — Role C's build remainder (verbatim; recorded in no other file)

> (a) `dotnet build` unverified locally — RESOLVED: the orchestrator's Docker
> image build compiled the API cleanly before deploy.
> (b) No nav entry; Inward reached via Accessioning header button + direct
> `/inward` (top bar at width limit; reasoning left in App.tsx NAV comment).
> (c) FIX #13 client-scoped half: orphan rows invisible to client-scoped users
> by nature of scoping; accepted per orchestrator brief.
> (d) Quirk 4 nuance: audit row written only when the business unit actually
> CHANGES; same-unit re-scan logs nothing; `modifiedby` deliberately untouched
> (legacy parity), `modifieddate` stamped.
> (e) Quirk 20/grant list: which roles should ultimately scan is an ASK for the
> lab; client role denied by default.
> (f) Quirk 22: ClientPicker used with `activeOnly=false`, but whether
> `/api/reports/filters` includes inactive centres was NOT verified.
> (g) `bunit` filter exists in proc+API, no UI control.
> (h) Row-cap not paging; UI cap 500 with "showing first N of M".
> (i) Activity log: legacy inward-accession wrote `sp_user_activity_log`
> "Sample Registered"; Infinity's path records via `usp_telo_accession_samples`
> + inward audit row; whether the LIS's own activity-log report must ALSO show
> these was not confirmed.
> (j) Dirty-vailid fallback bounded to 60 days at the scanning unit.

**Role E disposition of the remainder:** (a) resolved. (b) accepted, G-13.
(c) accepted, quirk 13. (d) accepted — the tracking row itself (`scan_by`,
`received_*`) is the record of every scan, so auditing only the *change* to the
sample loses no information, and leaving `modifiedby` alone is deliberate legacy
parity; ruled sound. (e) → G-5. (f) **closed by inspection in this file** —
the filters procedure applies no `IsActive` predicate, so inactive centres are
listed as quirk 22 requires. (g) → G-3/G-7. (h) accepted, but see G-2 for the
CSV half. (i) → G-11. (j) accepted; the bound is the reason G-4 is medium rather
than high.

---
*Role E, F1, 2026-08-17. No database was queried and no file outside
`docs/contracts/` was modified. Inputs: `f1-inward-contract.md`,
`f1-inward-schema.md`, `f1-inward-verification.md`, Role C's remainder
(Appendix A), and the deployed source in `api/db/sql/105–107`,
`InwardEndpoints.cs`, `InwardRepository.cs`, `Inward.tsx`.*
