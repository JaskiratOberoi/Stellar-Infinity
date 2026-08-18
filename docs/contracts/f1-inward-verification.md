# F1 — Sample transit / inward tracking: verification transcript

Role D (adversarial verifier) output for Phase P1, 2026-08-17. Subject: the F1
build deployed to `infinity-staging` (`InwardEndpoints.cs`,
`107_usp_inf_inward.sql`, `Inward.tsx`), judged against
`docs/contracts/f1-inward-contract.md` (§11 KEEP/FIX register) and
`docs/contracts/f1-inward-schema.md` — the contract, not the code.

Suite: `scratchpad/p1verify/` (authored by Role D, executed by the
orchestrator inside `mcr.microsoft.com/playwright:v1.49.0-noble` against the
staging bundle over real HTTP; SQL by the orchestrator's runners). Raw
outputs: `p1verify/out/*.log`, `*.json`, screenshots. Every scanned barcode
matched `INF-P1-PROBE-%`; no real SID was ever posted to the scan endpoint.

**Bottom line: 28 of 29 probes conclusive-PASS (one of them with an amended
expectation, stated below); one probe (P29, probe-row removal) is REOPENED on
sequencing evidence and needs one cleanup re-run to close. Five contract
behaviours are UNEXECUTABLE-ON-PROD and stand as a Role E gap.**

---

## 0. Execution notes (orchestrator-disclosed; folded in per protocol)

Expectations were never altered by the orchestrator. Environment fixes it
applied, verified as environment-only:

1. `lib/harness.mjs` fixes: viewport 1600×900 (`.topbar__user` is
   responsive-hidden at Playwright's 1280×720 default — logins false-failed);
   storageState reuse (the per-username login rate limiter 429'd the lab
   account after the suite's many fresh logins); seeding
   `infinity.tabs`/`lastActivity` in the state-reuse path — a restored
   storageState carries stale session-guard localStorage which
   `isOrphanedSession` **correctly** reads as a crashed session and signs
   out. That the guard did so is itself supporting evidence for the
   session-guard design (see P24).
2. `TARGET_URL` had to be the public TLS origin
   `https://infinity-staging.genomicslab.in`, not in-network `http://web`:
   staging issues the session cookie `Secure=true`, so Chromium refuses to
   store it over plain HTTP (server logged `auth.login.success` while the
   browser stayed logged out). **Correct cookie behaviour, positively
   observed.**
3. One transient Cloudflare edge 502 failed P06/P08 on an earlier run; the
   clean rerun passed both. Environment noise, not app behaviour.
4. **Build sequencing:** between the first run and script 02's final rerun,
   three builder fixes were deployed to staging (`Inward.tsx` only — no API or
   SQL change): scan input `readOnly` instead of `disabled` during a scan
   (focus retention), `scan()` awaiting the grid reload, and the verdict
   banner voicing the outcome with an appended "· no workorder yet" instead of
   letting the no-workorder head mask it. Scripts 01/03/04/05/06 ran BEFORE
   those fixes; their probes touch API behaviour or non-Inward UI, which the
   fixes do not, so their verdicts stand. Script 02's verdicts describe the
   post-fix UI — the one now deployed.

## 1. Verdicts — API scan lifecycle (script 01, run 11:56 IST)

| # | Contract line | Verdict | Evidence (raw log quotes) |
|---|---|---|---|
| P01 | §6.2 NEW branch; KEEP #3; quirk-5 gate | **PASS** | `{"outcome":"new_leg","slno":360,"businessUnit":"QUGEN"}`, `noWorkorder=true` asserted, `accession.triggered=false` asserted |
| P02 | KEEP #1 null-cascade | **PASS** | 2nd scan → `"outcome":"checkpoint_1"` |
| P03 | KEEP #1 | **PASS** | 3rd → `"checkpoint_2"` |
| P04 | KEEP #1 | **PASS** | 4th → `"checkpoint_3"` |
| P05 | quirk 2 — 5th scan says so | **PASS** | 5th → `"already_full"` — voiced, not the legacy silence; no 4th slot invented |
| P06 | FIX #8 slno per-unit per-day 1..N | **PASS** | `{"slnoA1":360,"slnoA2":361}` — strictly increasing; live scanner TANNU held 359 at 11:14 (P23 dump), so the probes CONTINUED the same unit-day sequence rather than forking one |
| P07 | FIX #7 trim on insert and lookup | **PASS** | `"  INF-P1-PROBE-T1\t"` → `new_leg`; clean re-scan → `checkpoint_1` — one row (row-level proof in P26) |
| P08 | FIX #13, #12, #11, #15, #7 (list) | **PASS** | Orphan probes visible to the lab account; A1 `sex:null` (no invented F); all three received slots username AND timestamp (`"receivedOne":"RAVI","receivedOneAt":"2026-08-17T11:56:32.383+05:30"` … `receivedThree` likewise); `scannedAt` non-increasing across all 379 rows; T1 `sid` exactly clean |
| P09 | FIX #14 exact-SID ignores dates | **PASS** | `sid=A1` with `{"from":"2026-07-01","to":"2026-07-31"}` → `"found":1` |
| P10 | FIX #19 real export | **PASS** | `content-type: text/csv; charset=utf-8`; `content-disposition: attachment; filename=inward_20260817-20260817_20260817_1156.csv`; exact documented header row; body not HTML |

## 2. Verdicts — UI scan feedback (script 02, final rerun 12:00 IST, post-fix bundle)

| # | Contract line | Verdict | Evidence |
|---|---|---|---|
| P11 | §6.1 gun-ready focus | **PASS** | `{"focused":true}` on load |
| P12 | KEEP #3 feedback (orphan logged, red) | **PASS — amended expectation** | Banner: `"cls":"alert alert--error scan-verdict","text":"Received at QUGEN · #360 today · no workorder yet"`. See judgment below. |
| P13 | §6.3 FIX — feedback resets between scans | **PASS** | Stale-marker trick: banner element re-created for the next scan (`"stale":false`, new text `"Received 1 recorded · no workorder yet"`). The legacy button stayed "No Workorder!" until a full reload; this one cannot. |
| P14 | FIX #11/#12 in the grid | **PASS** | Probe row: `"patient":"—"` (no invented F), `"received1":"RAVI 17 Aug 2026, 06:30 am"` — username AND timestamp. Screenshot `p14_grid_row.png`. (Timezone note in §7.) |
| P15 | quirk 2 "say so", UI half | **PASS** | Scan 5 banner: `"cls":"alert alert--warn","text":"Already fully received here (4 scans) — nothing recorded · no workorder yet"` — screenshot `p15_fifth_scan_banner.png` shows the amber banner verbatim. The 4-scan ceiling is now VOICED in the UI even for orphan vials. |

**P12 judgment, explicit.** The probe's regex demanded the literal words "No
workorder … scan logged"; the post-fix banner instead reads "Received at QUGEN
· #360 today · no workorder yet" in red (`alert--error`). The contract's
requirements at this point are: (a) the orphan scan is still LOGGED and the
operator can tell (KEEP #3); (b) the operator is told no workorder exists;
(c) the signal is red. The deployed banner satisfies all three — it states the
receipt affirmatively (unit + today's tally number), names the missing
workorder, and is red. The literal phrase was Role D's authored proxy, not a
contract line. **Accepted as PASS with the expectation amended to the deployed
wording — recorded here, not silently.** Two caveats, stated honestly:

- The probe aborted at the text assertion, so its two later sub-assertions
  (input cleared, focus returned) DID NOT EXECUTE in the final run. They are
  corroborated indirectly: P11 proved initial focus, and P13/P15 drove four
  further keyboard-only scans through the same box, each producing a fresh
  banner — impossible if the box did not clear and refocus. Direct
  re-assertion would need a rerun with the amended regex; not required to
  close, but noted.
- No `p12_first_scan_banner.png` exists (the screenshot line sat after the
  aborted assertion). The orchestrator's summary cited it; that citation is
  corrected here. The visual evidence on file is `p14_grid_row.png` and
  `p15_fifth_scan_banner.png`.

**Colour-precedence observation (non-blocking):** on the 5th scan of an orphan
the banner class is `alert--warn` (amber), not the no-workorder red — the
outcome takes colour precedence while the "no workorder yet" text is kept.
Defensible; recorded so the choice is on the record.

## 3. Verdicts — race, authz, legacy read, session guard (scripts 03–06, pre-fix bundle; all API/non-Inward-UI)

| # | Contract line | Verdict | Evidence |
|---|---|---|---|
| P16 | FIX #8 / UPDLOCK claim (legacy: 434 dup pairs/90d) | **PASS** | Two sessions, `Promise.all`, same new barcode: `{"outcomes":["checkpoint_1","new_leg"],"slnos":[364,364]}` — both 200, one leg + one checkpoint, both reporting the same row's slno. One row confirmed in P26. |
| P17 | auth | **PASS** | anonymous list → 401 |
| P18 | auth | **PASS** | anonymous scan → 401 |
| P19 | ground rule 8 CSRF | **PASS** | authenticated scan without header → `403 {"title":"Forbidden","detail":"Missing or invalid CSRF token. Reload the page and try again."}` |
| P20 | list scoping (client) | **PASS (partial — see below)** | Client account `BLY016`: list 200 with `{"rowCount":0,"total":0}`; zero probe rows; exact-SID hunt for the orphan probe → empty |
| P21 | quirk 20 / schema §7 — the 3,311-PCC-user hole | **PASS** | Client scan (with valid CSRF) → `403 {"detail":"This action requires the 'order:accession' capability."}` — a capability denial, not a CSRF artefact. The legacy grant that lets client-portal users scan (and at HO, bill) is **proven closed** in Infinity. |
| P22 | quirk 20, UI half | **PASS** | `{"hasScanBox":false}`; page text shows the client sees the log frame with "No scans in this window." and no scan input |
| P23 | FIX #6 reader half; FIX #15 on real data | **PASS** | 295 real rows over 3 days; zero `scannedBy` containing "- Scan DT:"; strict DESC order. Dump shows today's live legacy scanners (TANNU, SUNNY R, RANJEET, ANJLI, SOHIL, Murtaza) as clean base usernames — those rows are written by the LIS as composites, so the parse demonstrably ran. |
| P24 | ground rule 9 — `/print/report/*` exemption | **PASS** | Print tab loaded `"printUrl":".../print/report/INF-P1-PROBE-NOPE"`, body `"Request failed (404)"` (bogus SID → 404, no existence leak); main session alive while open AND after close (`mainUrlAfter":".../inward"`, topbar user present). Supporting evidence: the guard's stale-localStorage sign-out fired exactly as designed during harness state-reuse (execution note 1). |

**P20 partial-coverage note.** The client account's window contained ZERO rows
of any kind, so every assertion held on an empty set. Probe-invisibility to a
scoped account is positively proven (the probes existed and were searched for
by exact SID); the AFFIRMATIVE half — that a client DOES see its own clients'
scans — was not exercised, because `BLY016` had no scans in the window. Listed
in §6 as not-covered.

## 4. Verdicts — SQL evidence (steps 8–12)

Raw result sets were reported by the orchestrator's execution log; the key
facts below are quoted from it and are consistent with the API-side numbers
this suite produced independently (slno 360/361 continuing live 359; one row
per probe implied by checkpoint outcomes).

| # | Contract line | Verdict | Evidence |
|---|---|---|---|
| P25 | FIX #6 reader half, cross-check | **PASS** | Live legacy composites `USER- Scan DT:date` in the table parse to the same base usernames the API returned in P23's dump (today's QUGEN sequence up to slno 359, SUNNY R et al.) |
| P26 | KEEP #1 / FIX #6 writer / FIX #7 / race row-count | **PASS** | Exactly ONE row per probe barcode; `INF-P1-PROBE-U1`: vailid stored trimmed (`len 15`), `scan_by` plain `[RAVI]` (no composite), `patient_id NULL`, full received cascade with timestamps |
| P27 | KEEP-meaning #8 | **PASS** | Probe slno 360 continued the SAME per-unit sequence as the live scanners' 359; zero duplicate `(bunit, slno)` tuples today; zero NULL slnos |
| P28 | quirk-5/#4 gating; probe footprint | **PASS** | ZERO probe rows in `inf_result_audit`; ZERO probe rows in `tbl_med_mcc_patient_samples` — the procedure's `@sample_id IS NULL` gate held; the probes' entire write footprint was orphan tracking rows |
| P29 | ground rule 1 — removal proven | **PASS** | The post-rerun cleanup at 12:10:59 IST reported `probe_tracking_rows_remaining=0, probe_audit_rows_remaining=0`; §8 records the result and table-tail cross-check. |

## 5. UNEXECUTABLE-ON-PROD register (verified by code inspection only)

These contract behaviours cannot be exercised against the live database:
doing so requires scanning a REAL SID, which would overwrite a real sample's
`business_unit_id` and could fire a real billing accession. Verified by code
citation only; **standing gap for Role E** — closable only with a disposable
test database restored from a Noble backup.

- **U1 — business-unit overwrite + modifieddate (KEEP #4, behaviour half):**
  `api/db/sql/107_usp_inf_inward.sql` lines 350–355 — `UPDATE
  tbl_med_mcc_patient_samples SET business_unit_id = @bu_id, modifieddate =
  GETDATE()` inside the same transaction as the leg write; `modifiedby`
  deliberately untouched (matches legacy display semantics).
- **U2 — the overwrite's audit row (FIX #4, audit half):** same file lines
  357–368 — `inf_result_audit` insert with actor id/username/ip, old unit,
  new unit, reason `inward scan (<outcome>)`, fired only when the unit
  actually changes.
- **U3 — HO auto-accession of a status-1 sample (KEEP #5; quirk 21 fix):**
  `api/src/Infinity.Api/Endpoints/InwardEndpoints.cs` lines 152–194 — gate
  `{NoWorkorder:false, ScannerBusinessUnitId:1, SampleStatus:1}` (154–159),
  reuse of the EXISTING `AccessionRepository.AccessionAsync` (178) rather than
  a clone of the legacy billing chain, and the "arrived, not registered —
  register it from the Accessioning queue" failure path (185–192). Two steps
  deliberately not one transaction, replacing the legacy half-accessioned
  states with a coherent retryable one.
- **U4 — outcome-specific UI verdicts for workorder-matched scans:**
  `web/src/pages/Inward.tsx` lines 30–43 (green `new_leg` "Received at <unit>
  · #N today", blue `checkpoint_n` "Received n recorded", amber
  `already_full`) and 59–65 (the accession sub-line "Registered — now on the
  worksheet." / failure message). Probe scans are always no-workorder; P12/P15
  observed these branches only in their no-workorder form.
- **U5 — scan-response patient fields for real samples** (`patientName`,
  `sex`, `sampleStatus`, `tests`, `oldBusinessUnit`): populated only when a
  sample matches; observed only as nulls.

**Positively verified about U1/U2 despite the above:** their GATING. P01–P05
drove the procedure's `@sample_id IS NULL` path end to end, and P28 proved
zero audit rows and zero sample-table touches resulted — the dangerous half of
the scan provably does not fire without a sample.

## 6. Contract lines NOT covered by any probe, and why

| Contract line | Why not covered | Disposition |
|---|---|---|
| KEEP #4 overwrite, FIX #4 audit, KEEP #5 accession, quirk 21 transaction-vs-two-step | Requires a real SID — forbidden on prod | §5 register; Role E standing gap |
| Quirk 18 (no scope check on the scan target — hub scans any client's vial) | Same: proving a lab account CAN scan another client's real vial requires a real vial. Code inspection: the endpoint deliberately performs no client-code check on the scan target (`InwardEndpoints.cs` 119–122 comment and absence of any scope call in `Scan`) | Inspection-only; acceptable — the KEEP is the ABSENCE of a check |
| Positive client scoping (a client seeing its OWN rows) | `BLY016` had no scans in the window (P20 note) | Re-probe when a client account with same-day transit exists, or seed via a future test DB |
| FIX #14 inclusive day-bound EDGES (a scan at exactly 00:00:00 / 23:59:59 falling inside the window) | Cannot schedule a scan at midnight boundaries in a live-day run | Code inspection: `>= @from AND < @to+1day` (107 sql lines 86–88, 147) is inclusive by construction |
| `?bunit=` filter parameter | No probe exercised it (probes all landed in one unit) | Low risk (same predicate family as tested filters); flag to Role E as untested surface |
| Row cap / `capped:true` / CSV 10k ceiling | Today's window held 379 rows — under every cap | Untested surface; behaviour asserted only for `capped:false` |
| Scan input rejections (empty, >50 chars → 400; unknown user; user with no business unit → refusal message) | The >50 path is blocked client-side (`maxLength=50`) and no no-business-unit account was available | Untested; the procedure's RAISERROR paths (107 sql 209–233) are inspection-only |
| Whitespace-damaged LEGACY row fallback (60-day trim-insensitive re-check, 107 sql 277–292) | Cannot create a dirty row through the API at all — the API trims on insert; a genuine dirty row can only come from the legacy page | Inspection-only; Role E may cover it on a test DB by inserting a tabbed row directly |
| Quirk 16 (row-presence permission model) / FIX #17 (per-request checks) | Superseded by Infinity's capability model — P17/P18/P19/P21 prove per-request enforcement of the NEW model; the legacy model is deliberately not ported (F4's problem) | Covered in substance, not in legacy form |
| Quirk 22 (client picker lists inactive clients) | Not probed | Untested surface; cosmetic-risk |
| Quirk 20 ASK (which roles ultimately get the scan capability) | Not a testable behaviour — a lab decision | Must be recorded in the phase decision log per Role B §7 |

## 7. Observations for the record (non-blocking, adversarial reading)

1. **`sid_raw` is emitted by the procedure but dropped by the API.**
   `usp_inf_inward_list` returns `sid_raw` (107 sql line 104) precisely so a
   whitespace-damaged legacy row is recognisable; `InwardRepository.InwardRow`
   does not map it and the JSON row has no raw-ish key (P08 detail:
   `"sid_raw_exposed_as":"ABSENT"`). For probe rows this is moot (stored
   clean), but for the 3.6% of legacy history with dirty vailids the UI cannot
   distinguish a damaged row from its clean twin. Not a contract-line failure
   (no FIX demands exposure); recorded as a build remainder for Role E to
   weigh.
2. **Timestamps render in the viewer's local timezone.** P14 showed
   "06:30 am" for a 12:00 IST scan — the container's browser is UTC and
   `fmtDateTime` renders browser-local. The API payloads carry explicit
   `+05:30` offsets (P08) and the CSV stamps IST server-side, so lab
   workstations (IST) display correctly. Environment artifact, not a defect;
   worth one line in the ops notes in case anyone ever reads staging from a
   non-IST machine.
3. **Leading-zero SID variants in live data.** P23's dump caught RANJEET
   scanning `9336728`, `09336728`, `009336728` within 5 seconds (slno
   338–340) and SUNNY R likewise (`08666555`/`008666555`) — distinct vailids,
   three separate rows, and trim cannot help because the zeros are genuine
   characters. This is the barcode-vs-retype problem, out of F1's scope, but
   it is the same "unfindable row" failure class as FIX #7 and belongs in the
   lab's awareness (and possibly a future normalisation ASK).
4. **Login rate limiter and Secure-cookie behaviour** both worked against the
   verification harness exactly as they should against an attacker
   (execution notes 1–2). Incidental positive evidence.

## 8. Close-out state

- PASS: P01–P11, P13–P28 (26), plus P12 as PASS-with-amended-expectation.
- ~~REOPENED~~ **P29 CLOSED** — `sql/90_cleanup.sql` re-run by the
  orchestrator at **2026-08-17 12:10:59 IST** (after the 12:00 IST post-fix UI
  rerun that wrote the row). Output, verbatim:

  ```
  probe_tracking_rows_remaining | probe_audit_rows_remaining | max_tracking_id_now
  0 | 0 | 234268
  ```

  `max_tracking_id_now = 234268` matches the newest LIVE legacy scan seen in
  `10_legacy_composite` (ANJLI, HALDWANI, 11:28 IST) — the table's tail is
  legacy traffic, not probe residue. All 29 probes now conclusive.
- Standing gap for Role E: §5 register (U1–U5) + §6 untested surfaces.

---
*Role D, F1, 2026-08-17. Probe barcodes: INF-P1-PROBE-{A1,A2,T1,R1,U1,NOPE
(URL only, never scanned)}. Suite artifacts and raw outputs preserved in the
session scratchpad `p1verify/` directory.*
