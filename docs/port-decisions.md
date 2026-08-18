# Port decision log — append-only

Every DROP, every ASK answered, every KEEP-a-bug choice. When someone asks in
two years why there is no inventory module, the answer is a line here.

Entries are never edited; a reversed decision gets a new entry referencing the
old one.

---

## D1 — Drop Worksheet\fancy.aspx
**Date:** 2026-08-17 · **Decided:** plan run approved by Jaskirat ("run the plan")
Uploader shim for the fancybox JS library, not a feature. No data of its own.

## D2 — Drop the noticeboard set
**Date:** 2026-08-17 · **Decided:** plan run approved by Jaskirat
Birthdays, News, news marquee, ScrollingImages, Downloads, Callhealth_Ack.
Intranet-portal furniture around the LIS, not lab workflow. No Infinity
equivalent planned; nothing reads their tables from the worksheet or billing
paths.

## D3 — Drop Pcc\CourierStatus.aspx (provisional)
**Date:** 2026-08-17 · **Decided:** plan run approved by Jaskirat
`tbl_med_mcc_courier_status` holds 11 rows ever. Recorded as dropped; P5's
analyst re-confirms when the portal phase runs, since the portal is the one
place a courier status could plausibly matter.

## D4 — Drop scaffolding pages
**Date:** 2026-08-17 · **Decided:** plan run approved by Jaskirat
Pcc\WebForm1.aspx, Pcc\WebForm2.aspx (empty designer scaffolds), TinyMce.aspx
(editor asset page). No behaviour to port.

## D5 — Drop the Inventory module (13 pages)
**Date:** 2026-08-17 · **Decided:** plan run approved by Jaskirat
Production evidence, measured 2026-08-17: 2 indent records ever, 5 vendors,
32 products; every stock/log/control/history table at 0–2 rows;
vendor_payment_history 0 rows. The module was built and never adopted.
Porting it would be building a second empty warehouse. If the lab later wants
inventory, it should be specified fresh from today's workflow, not from this
code.

---

## D6 — P1 (F1 inward tracking): quirk rulings adopted as contracted
**Date:** 2026-08-17 · **Decided:** pipeline, on Role A's contract + Role B's data
All 22 KEEP/FIX rulings in `contracts/f1-inward-contract.md` §11 are adopted as
written. The two that would surprise a reader:

- **KEEP #5** — scanning a sent sample at head office performs a full
  accession. Kept because it is live daily workflow, but routed through
  Infinity's EXISTING `usp_telo_accession_samples` (whose `amount_checked`
  latch makes the billing debit charge-once) instead of cloning the legacy
  chain. A failure between the scan and the accession now leaves "arrived, not
  registered" — retryable — instead of the legacy's half-accessioned sample.
- **KEEP #18** — no client-code scope check on the scan target. A hub receives
  every client's vials; refusing to log a physical arrival over a mapping
  would be data loss. The capability gate and list-side scoping are the
  controls. See D9 for the consequence this has for branch staff.

## D7 — P1: quirk 16 (permission bits) deferred to P4
**Date:** 2026-08-17 · **Decided:** pipeline
The LIS's `CheckUserPage` ignores its own `_read`/`write`/`_delete` columns —
any row for (menu, usertype) grants full access. Infinity does not invent bit
semantics the LIS never enforced; the whole permission scheme is P4's subject
(F4 governance). Recorded so the silence is deliberate.

## D8 — P1: leading-zero SID variants are a recorded limitation, not P1's to fix
**Date:** 2026-08-17 · **Decided:** pipeline, endorsed by Role E
Production carries the same vial as `9336728`, `09336728` and `009336728` —
three rows within five seconds, three separate custody trails. Trimming cannot
heal this. Normalising leading zeros risks merging genuinely different vials
and would desynchronise the samples table. Any fix belongs at SID minting and
validation, not in transit tracking. **ASK the lab** whether leading zeros are
significant in a SID.

## D9 — P1: branch technicians can scan but cannot see their own log — **FIXED**
**Date:** 2026-08-17 · **Decided:** Jaskirat chose the unit-scoped rule; implemented and verified same day
Measured: an active SRINAGAR accessioning technician gets `200` with zero rows
from `/api/inward/`, at a unit with 5,453 scans in 90 days. Cause is
pre-existing — `Technician` is not an unrestricted reporter and branch lab
staff have no client-code mappings, so their report scope is `Denied`; the
same account gets `403` from the older `/api/reports/` worklist. P1 did not
introduce it but is the first feature it disables, because Inward exists for
branch technicians.

**Resolution — the unit-scoped rule, as the legacy page had it.**

The scope now reads: a caller who is denied by client-code scope BUT holds
`order:accession` is scoped by their business unit instead. The unit lock
already existed in `usp_inf_inward_list`, derived server-side from the actor's
own user row — so a caller cannot ask for another unit, and the empty client
TVP is safe precisely because that lock is not.

Three deliberate narrowings, each to avoid trading a fixed screen for a widened
one:

- Keyed on **`order:accession`, not `order:view`** — "you may scan, therefore
  you may see the log of scans". This excludes `viewer`, which is Infinity's
  catch-all for LIS user types it does not recognise; handing an unknown type
  the hub's entire transit log would be a bad trade.
- **Client-scoped callers are untouched.** A client with no codes still sees
  nothing. Note 667 active client users sit on a branch business unit, so the
  unit lock applies to them too — exactly as the legacy page did for PCC users.
- The procedure now **fails closed** on the remaining case (no codes, not
  unrestricted, no usable business unit) by forcing an impossible unit, so
  nobody falls through the gap the fallback opens.

Verified on staging after deploy (`08_readonly_closure.mjs` 6/6): the SRINAGAR
technician now sees 200 of their own unit's rows, and asking for `bunit=QUGEN`
still returns SRINAGAR rows — the lock wins over caller input rather than
widening. Regression-checked in the same pass: `04_authz` 6/6 (client still
sees only its own client, still 403 on scan, still no scan box) and
`01_api_scan_lifecycle` 10/10. Probe rows cleaned, 15:13:09 IST.

## D10 — P1: accepted residual risk (the unexecutable half)
**Date:** 2026-08-17 · **Decided:** pipeline, pending explicit user acceptance
Five behaviours cannot be exercised against a live production database because
they require a real workorder and would move or bill a real sample: the
business-unit overwrite, its audit row, the head-office auto-accession, the
outcome-specific UI verdicts for matched scans, and the patient fields in the
scan response. All are verified by code inspection only
(`contracts/f1-inward-verification.md` §5, U1–U5). The probes DID positively
verify that the dangerous half stays gated off when no sample exists
(P01–P05 + P28: zero audit rows, zero sample rows).

The sharpest residual is unmeasured lock contention: the scan transaction has
never held a real `UPDLOCK` on the 5.51M-row samples table against live LIS
writers. Scope is one vailid for a few milliseconds, and the legacy page
already takes an exclusive lock on the same row when it updates
`business_unit_id` — so the realistic risk is low, but it is unmeasured. A
disposable copy of Noble would close all five.

## D11 — Client portal: rate lists were readable by every client login — **FIXED**
**Date:** 2026-08-17 · **Decided:** found while scoping the portal; fixed and deployed to staging
`/api/rate-lists/` and `/{id}/items` were gated on `billing:view`, which the
CLIENT role holds because a centre needs it for their own ledger and invoices.
Rate lists carry no client scope of their own — one list serves many centres —
so the capability was the entire gate, and it was the wrong one.

Measured on staging before the fix: the Delhi centre DL0214 enumerated all
**112 rate lists** (names, client counts, 1,823 priced tests each) and read
BIJNOR's line by line — MRP 8000 / rate 4000, MRP 3500 / rate 1500. Any of the
~3,300 active client logins could do the same.

Now `rate:manage` (super_admin and admin only). Verified 403 naming the
capability, and the Rates tab no longer renders for a client. Nobody legitimate
lost access: `lab_manager` holds neither capability, so that screen was never
theirs, and `viewer` — the catch-all for unrecognised LIS user types — has no
business reading commercial terms.

**Present on the live stack too**, which runs the same code. Not pushed there:
the user has not authorised a live deploy.

## D12 — Client portal: the temporary unlock was ignored — **FIXED**
**Date:** 2026-08-17 · **Decided:** found by P2 Role B; fixed and deployed to staging
`LockUnlock_MCC.aspx` lets the lab release one client for N hours — "pay
tomorrow, send today" — writing `tbl_med_mcc_lockunlock`. Infinity's balance
lock never read that table, so it kept returning 423 for clients the lab had
explicitly released, and the operator's only clue was a refusal naming a
balance they had already waived.

Not theoretical: **65 clients held a live unlock** at the moment of the fix,
several granted that morning, including centres owing lakhs (CH0074, ₹14.7
lakh, unlocked for ten days; AG0171, ₹2.4 lakh, unlocked at 10:04).

Read as an EXPIRY, not a flag — `number_of_hours` is decoration,
`expire_unlock` is the fact — and compared to `GETDATE()` in SQL so the
decision runs on the database's clock, not the API container's. TOP 1 by latest
expiry, because re-unlocking appends a row rather than updating one.

Verified as a PAIR, because testing only the release would prove nothing except
that the lock can be broken: BR0001 (owes ₹65,370, live unlock) → **200,
released**; DL0300 (owes ₹21.9 lakh, no unlock) → **423 BALANCE_LOCKED, due
2188563**. The gate still works.

Still open from the same finding, NOT fixed: the LIS locks a client at exactly
zero balance where Infinity releases them (676 clients). That is a policy
difference rather than a defect — ASK the lab which is intended.

## D13 — Client portal: a parent centre sees its franchises' reports — **BUILT**
**Date:** 2026-08-17 · **Decided:** Jaskirat, answering the portal contract's G4
The legacy portal effectively allowed this, though by accident (the IDOR in
§3.6 let any client read anything). Infinity did not allow it at all. The lab's
answer: parents should see their franchises.

Implemented in `ScopeRepository.GetReportScopeAsync` — the single seam where a
caller's centre ids are resolved — so reports, the worksheet, accounts and
inward all inherit one definition of scope rather than each growing its own.
It matches how the money already behaves: sub-franchise charges post to the
PARENT's account with the child's code in the ledger description.

**One level deep, and the data says that is not a simplification.** The only
three-deep chain in production is PB0008 → PB0008B → PB0008A, and PB0008A is
also mapped *directly* to PB0008 — the mapping table writes its transitive
edges out explicitly. A recursive CTE would return identical rows while making
a cycle in hand-maintained data able to hang the query.

**One-directional.** A child must not inherit its parent and must not reach a
sibling; only the parent looks down.

Blast radius, measured: 88 mappings, 47 parents, 84 children, 0 orphans.
**Four children have two parents** — PB0008A, PB0027A, and the two UK0022 labs
shared with HR0349 — so those reports are visible to two different parent
logins. That is what the lab's own mapping says; flagged rather than
second-guessed.

Verified on staging (`16_franchise_rollup.mjs` 3/3), the last two probes being
what make the first one safe:

| probe | account | result |
|---|---|---|
| F1 parent sees children | UP0050 (AG0050) | scope **3 centres**, 6,892 reports, AG0050A rows visible |
| F2 child does NOT inherit | UP0001A | scope **1 centre**, no UP0001 rows |
| F3 unmapped client unchanged | DL0214 | scope **1 centre**, only DL0214 |

Scope is cached for 5 minutes, so existing sessions pick this up within that
window; the staging cache was flushed after deploy.

---

*(KEEP/FIX rulings from behaviour contracts are recorded per-phase as the
contracts land; the contract file is the authority, this log records only the
contested ones.)*

## D14 — Client portal: two cross-client leaks in INFINITY, found by sweeping — **FIXED**
**Date:** 2026-08-17 · **Decided:** found executing G40 from the portal contract; fixed and deployed to staging

Both leaks today (rate lists, the technician gap) came from checking routes one
at a time, so G40 asked for the systematic version: every authenticated GET,
hit with a client token, using a FOREIGN identifier wherever a route takes one.
84 routes inventoried. Two leaked.

**1. `GET /api/samples/{sid}/header`** — gated on `patient:view` alone, which
the CLIENT role holds, and it took no principal and performed no scope check.
Asking for another centre's SID returned that patient's **name, sex, age,
owning centre, business unit and status**. The handler even carried the comment
*"a missing SID and an out-of-scope SID should be indistinguishable to the
caller once scoping lands"* — scoping never landed, and the comment was the
only trace of the intent.

**2. `GET /api/accessioning/tubes/{patientId}`** — checked that *someone* was
logged in, then answered for any patient id: another centre's sample type, test
names, and the SID already issued against them.

Both now resolve the owning centre from the DATABASE and 404 when it is outside
the caller's scope — 404 rather than 403, so the response cannot be used to
confirm a record exists. The tubes route needed a new
`AccessionRepository.PatientClientCodeAsync`, a plain read of the patient's
owning centre.

This is the same class as the legacy portal's IDOR recorded in
`f6-portal-contract.md` §3.6 — but in Infinity, and reached without editing any
URL by hand. Worth stating plainly: reading the code did not find these. The
sweep did.

Verified on staging: `17_route_sweep.mjs` 3/3 (lab-only surfaces refuse a
client, no foreign record returned by id, own surfaces intact and mentioning no
other client), `14_idor_check.mjs` 5/5 unchanged, and `18_scope_regression.mjs`
2/2 — an unrestricted lab user still reads any centre's header (JM0007, 200)
and order tubes (200, 1 tube), so the fix removed the leak without removing the
lab's own reach.

Three of the sweep's first failures were MY probe specification, not the app,
and are corrected in the script rather than quietly dropped: the accessioning
queues are `order:view` (which a client legitimately holds) and return an empty
scoped page; `/api/dashboard/stats` correctly 403s a client for lacking
`analytics:view`; and two URLs were artefacts of how the route inventory
tracked `MapGroup` context.
