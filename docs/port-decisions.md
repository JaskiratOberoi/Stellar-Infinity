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

## 2026-09-04 — Report downloads ask "which paper", not "letterhead on/off"

The Letterhead toggle folded two questions into one bit: draw Noble's artwork,
and use Noble's 26/34mm clear area. Off meant no artwork AND the 40mm bands a
client's own stationery needs — so a desk printing onto pre-printed Noble
paper had no mode that fitted, and every such report started 14mm under the
printed header. Replaced everywhere (Reporting batch bar, the SID viewer, the
PID Review & edit viewer, the PID menu, Worksheet's PID download) by a
three-way Paper choice: `letterhead` (artwork in, 26/34), `noble` (no artwork,
26/34 — the new one), `plain` (no artwork, 40/40). API: `?paper=` on the single
route and `paper` in the bulk body, resolved by `Reports/ReportPaper.cs`; the
old `headless` still resolves (true → plain, false → letterhead) so nothing
already built against it changes shape. The print route reads the same key
for its @page rule. The paper key rides in the PDF cache key and `PdfCacheV`
went 1 → 2, because `noble` and `plain` share margins and differ only in
artwork — a hit across them would be the wrong document. The remembered
preference keeps its localStorage key; stored `0`/`1` map onto `plain`/
`letterhead`, the two modes that reproduce exactly what those values printed.

## Interfacing is its own capability; Sales Admin is its own role (2026-09-08)

The Interfacing tab (the Synapse fleet, throughput, entry sources) was gated on
`analytics:view` — "may read the dashboards" — which every commercial reader
holds. The LIS's SALES ADMIN usertype (32) mapped to `admin`, so the sales
login had the lab's instrument fleet on its menu. Now `interfacing:view` gates
the tab, its route and the three monitoring API routes (site set-up stays
behind `user:manage`), held by super_admin, admin and lab_manager. Usertype 32
maps to a new `sales` role: the admin capability set minus `interfacing:view`,
still an unrestricted reporter. A role rather than a per-user revocation
because the grant table only grants, and because the next Sales Admin the LIS
creates must land in the same place. SPs 20 and 23 carry `sales` in their
role IN-lists and must be redeployed with this.

## A report download marks the sample Printed, as an audited transition (2026-09-09)

The legacy LIS's "With Header" / "Without Header" click on `Pcc/WebForm2.aspx`
— which IS the PDF download, for lab and client alike — runs
`WorksheetClass.ChangeSampleStatus`: 6 → 8, 7 → 9, 8 stays, nothing else
moves. It touches no other column, marks BEFORE the Crystal export (so a failed
export still marks), logs one free-text "Printed <from>-<to>" row with no IP,
and is not triggered by viewing, by the QR copy (`g.aspx`) or by the e-mail
button. Telo never ported it. Infinity read 8/9 everywhere and never wrote
them, so a lab tech could not tell from the list that a client had taken a
report.

Infinity now does the same, differently in three places on purpose.
`usp_inf_report_mark_printed` (143) makes the transition under UPDLOCK and
writes an `inf_result_audit` row (action `status`, old → new, actor, IP,
agent, `reason` naming the channel) — the sample's history tab and the audit
feed both show it. The API calls it only once the PDF bytes exist, rendered or
from cache, on the single route and per report inside a bundle; a failed render
is on the trail as `report.pdf_failed` and marks nothing. `modifieddate` is not
touched, so a download never moves a sample between the lists' date windows.
Every signed-in role marks, as in the legacy — the audit row carries the role
and username, which is how "was it the client" is answered. The QR copy and the
on-screen viewer do not mark. A printed sample leaves 8/9 only through the
reopen (52) — `usp_inf_result_save` refuses a 7/8/9 sample outright — so an
amendment after printing is itself an audited step, and the next download
marks the sample Printed again; the legacy froze 9 for ever, which hid
amendments.

The trail was also completed while here: `report.pdf` now carries role, paper,
cache hit and the status flip, and is written per report inside a bundle (a
fifty-report PID pull was one row naming no patient); `report.pdf_bulk` names
the SIDs; the graph download, the Smart Report view and the two QR routes are
recorded; the renderer's own data fetch is filed as `report.rendered` instead
of a phantom `report.viewed` beside every download. The Reporting list updates
the row's status locally the moment a download completes.

## A client ROLE locks the account to its centre, not only a client usertype (2026-09-09)

Both scope resolvers keyed the centre lock on the LIS usertype (2, 7, 8, 10,
12). The admin's New User form takes any LIS usertype id, so an account created
as `client_reporting` over usertype 33 with no centre attached carried no
restriction the LIS would honour and fell into the parity branch — every
centre, on the dashboard and the reporting list. Found the moment such an
account was made for the printed-status test. Now an explicit Infinity role of
`client`, `client_b2c`, `client_reporting` or `sub_client` (inf_user_role) is
treated as a client usertype in both resolvers: own centre plus admin-granted
codes, and NOTHING until one is granted. A centre is attached to such an
account through Admin → Users → client codes, which is the audited path.

## The Smart Report is sold only with the HR health packages (2026-09-10)

The booklet (SMART-RPT, ₹99, a custom line) was offered on every order from
every centre. Its sections, scores and advice are written around the HR health
packages' analytes, and the lab's decision is that it is sold with those alone
for now. `inf_smart_report_package` (144) lists the eligible master profiles —
seeded with the eleven verified on ZZTEST01: HR201A, HR203A, HR202A, HR202A EX,
HR0201EX, HR0203 EXTENDED, HR204A, HR204AEX, UP101, UP0102, UP103. The order
form offers the extra only while the cart carries one of them and untucks it if
the package is removed; placement refuses the line otherwise, rather than
dropping it, so a draft that lost its package is not booked without the extra
the operator thought was there. Offering it with another package is one INSERT.
Reports already bought are untouched: the booklet's visibility stays keyed on
the purchase.

## Report format v2 — serif and capitals, selectable, under test (2026-09-12)

A second FORMAT for the standard report, asked for as "keep everything the
same, change the font to serif and capitalise the text so it reads bigger".
Not a global switch: `?format=v2` on the print route, `format` on the PDF
routes, a Format select beside the Paper select in both viewers, remembered
per desk (`inf.report-format`) and carried on every download. Anything
unrecognised is v1, so prod and every existing caller print exactly as before
until the lab chooses. v2 is one root class, `.lr--v2`: Georgia/Times, the
tabular text (patient block, table, signatures, footer) in capitals; units,
e-mail addresses, the QR caption and the prose blocks (interpretations, notes,
descriptive results, culture free text) keep their case. Pagination, paper
and content are untouched. The format is in the PDF cache key.

## Smart Report format v2 — the body-map page (2026-09-16)

The booklet now has a FORMAT like the clinical report: v1 is the booklet as
issued since launch; v2 is v1 plus one page, "Your body map", after the
snapshot and before the chapters. A front-on figure with the organs the
report looked at drawn in and labelled — the booklet's own body-system
categories, so "Heart & Cholesterol" points at the heart and "Blood Sugar"
at the pancreas — drawn in their natural colours with a green callout where
every result in the system is in range, red where any is flagged (the
Attention badge's rule, deliberately binary), and the untested organs left
faint and unlabelled so the figure still reads as a body. Two hand-drawn
figures were tried and rejected as cartoonish; the map now uses a real
anatomical illustration — the organ renderings from "Man shadow anatomy.svg"
(Mikael Häggström, Wikimedia Commons, CC0), each organ its own image under
public/branding/anatomy, placed by the artist's own matrices inside that
drawing's body outline (web/src/pages/bodyOutline.ts). Untested organs are
desaturated and faded; flagged ones get a red cast and glow via SVG filters;
the callout discs show the organ's own picture. The figure follows the
patient's sex — Häggström's female drawing and placement for a female
patient, the male otherwise — and shows the whole body, head to feet. The
images load after the data, so the print route holds data-print-ready until
the map reports them loaded. Organ files are kept near their printed
resolution (arm bones cropped to the upper arm, the urinary tract split into
kidneys and bladder), so a v2 booklet carries about 1 MB more than v1.
Under it, the flagged results by system. Carried exactly as the
clinical format is: `?format=` on the print route, `format` on both smart
PDF routes (in the cache key), and the desk's existing Format select — one
choice covers both documents. Staging only, with the clinical v2.

Fixed at the same time, in both formats: the cover's headline and tagline
had a text-shadow, which Chromium's PDF writer rasterises — so the words sat
on a faintly different rectangle over the photo scrim. The scrim carries the
legibility on its own; the shadow is gone. And the cover greeted the patient
by the first WORD of the stored name — "Mrs" for "Mrs Rose" — where the
welcome letter already used the first name; the cover now does too.

## Reporting groups by patient across pages, not only within one (2026-09-13)

The list procedure ordered by registration time alone, and the pages grouped a
patient's tubes only when they happened to land on the same page. Two tubes of
PID 3675368 registered an hour apart on a busy morning sat a page apart and
read as two patients. The lab's rule is that a patient's samples belong
together, whenever they were registered. `usp_inf_worksheet_list` now takes
`@group_by_patient` (default 1): the sort key becomes the patient's LATEST
registration in the filtered set, then the patient, then the tube — so a
patient sits where their newest tube would have, with the older tubes beside
it, and the page grouping needs no luck. Reporting always asks for it; the
worksheet passes its own Group-by-patient toggle, since a bench sometimes
works in pure registration order. Two limits stay: grouping applies within
the date window asked for, and a group can still straddle a page cut.

## Accessioning is one desk: every Sample Sent tube, whoever registered it (2026-09-18)

The accessioning queue was platform-only by design — "native LIS samples are
accessioned in the LIS itself" — which left the lab with two receiving desks
and the worse one for the bulk of the work: the network's clients register
in the legacy LIS (5,500 tubes a week at status 1), the legacy Accession page
hides anything registered before today unless its date boxes are widened by
hand, and a tube registered on the 14th sat invisible to the technician
holding it on the 18th (PB0007, SID 9338277). Now `usp_inf_pending_registrations`
lists every Sample Sent tube in scope with the legacy page's own filters
(registration date range, SID contains, patient name or mobile, client
scope) plus an origin filter (LIS / Infinity / Telo) and the client's
business unit; the page opens on the last seven days, and the filters are
optional where the legacy's are forced. A scan box registers one tube on
Enter whatever the list is filtered to — the legacy's by-SID receive.

Register still goes through `usp_telo_accession_samples` (status, result
skeleton, charge-once billing). What the legacy page does beside it is now
done too, by `usp_inf_accession_stamp` after a successful register: the
receiving user's business unit onto the tube (reports resolve signatories
through it) and the LIS's "Sample Registered" activity row. Reject is new to
Infinity, `usp_inf_accession_reject`: Sample Sent → Rejected with a reason
from `tbl_med_resaon_master` or typed, modifiedby/modifieddate, a "Sample
Rejected" activity row, and an `inf_audit_log` 'sample.rejected' row. Both
report per-SID verdicts, and the page names the skipped ones. The Sample-ID
queue is unchanged: LIS orders always carry their tubes from registration.

## Report format v3 — v2 in Playfair Display (2026-09-19)

A third clinical-report format, "everything the same as v2, just Playfair
Display": the root carries both `.lr--v2` and `.lr--v3`, so every v2 rule
(serif, tabular text in capitals, the case exceptions) applies unchanged and
v3 adds only the face. The font ships with the app (SIL OFL, latin subset,
one variable file per style under public/fonts) because the render
service's Chromium has no route to Google Fonts — a stylesheet link would
have printed Georgia while the desk's preview showed Playfair. Carried like
v2: `?format=v3`, `format` on the PDF routes and cache keys, the Format
select. The Smart Report has no v3 of its own and treats v3 as v2 (the body
map). Staging only, with v2.

## A package expands by its definition, and the tube reads as the LIS writes it (2026-09-19)

HEALTH SCREEN 3 booked from Infinity came out without Thyroid Profile II —
no FT3, FT4 or TSH — and the legacy Sample Worksheet listed the serum tube
as loose tests with no package name. Both had one cause in the shared order
procedures (`usp_telo_create_order`, `usp_telo_add_sids`): a master
profile's child profiles and tests were joined with `IsActive = 1`, and
Thyroid Profile II is flagged inactive in the catalogue while still being a
member of HS3 and nine other live packages. The LIS never filtered —
`PatientWorkOrder.aspx.cs` walks `GetListofProfileinMaster` /
`GetListofTestsInMaster` as they come — so a legacy booking of the same
package carried the profile and Infinity's did not. Script 146 makes the
expansion follow the definition: no active filter on package members
(direct lines keep theirs), members in the definition's own row order under
the definition's own member names, and the package name tagged onto the
package's last profile and last test exactly as the LIS does
(`…&nbsp;<i><b>[HEALTH SCREEN 3]</b></i>`), which is the string the legacy
worksheet shows. Verified byte-for-byte against legacy bookings of HS3,
P035A and PCOD PROFILE HALDWANI, then by a rolled-back booking on ZZTEST01
through the live procedure. Two divergences kept on purpose: directly
ordered lines still sort by code after the package (the LIS keeps selection
order, which a procedure cannot know), and the LIS's habit of tagging
whatever line happened to be last when a package has no profiles is not
reproduced. The two unprinted HS3 orders (SIDs 9338332, 9338334) were
repaired in place — profile added to the tube, result skeleton inserted in
the accession procedure's shape, tube moved back to Partially Authorised,
activity logged — by `api/db/data/hs3-thyroid-repair-20260919.sql`. The six
already-printed ones need a lab decision. The pre-change procedure bodies
are kept in `E:\Downloads\noble-proc-backups-20260919`. Telo shares both
procedures; its `60_`/`65_` copies carry the same change.

## The catalogue is scanned for definition drift, and a profile books as defined (2026-09-19)

After the HS3 incident the whole catalogue was scanned for the family of
defects behind it — a package or profile whose definition does not match
what gets booked. The scan is `api/db/checks/catalogue_consistency.sql`,
read-only and re-runnable; every result set is labelled and an empty set is
a pass. What it found on 2026-09-19: ten active packages carrying an
inactive profile (Thyroid Profile II in eight, Kidney Basic Screen in two),
eight carrying an inactive test (one of them literally named "DELETED"),
thirty-six packages listing a test both directly and inside a member
profile — which puts the test on the report twice, confirmed on printed
BG003 and BXP003 reports — thirteen active profiles whose tests span
several sample types, which Telo and Infinity split into loose test codes
with no profile header while the LIS keeps the profile on one tube, and one
active profile (CD19 CD20 MARKERS) holding an inactive test. Nineteen
Infinity package orders between 11 and 19 September lost Thyroid Profile
II; two were repaired the same day, three more unprinted ones have a
prepared repair (`api/db/data/hs3-thyroid-repair-2-20260919.sql`), fourteen
were already printed. Script 147 completes the rule 146 started: a profile
ordered as its own line also expands by its definition, active or not, as
the LIS's `GetTestsByProfileID` does; only a test ordered as its own line
must be active. Which inactive members to reactivate or remove, how to
represent a multi-tube profile, and what to do about the printed reports
are lab decisions the scan output is meant to inform.

## The Smart Report is introduced with mini profiles at ₹11, on B2B orders (2026-09-20)

The booklet is sold with the HR health packages at ₹99 (the 2026-09-10
decision). The lab now wants to see whether centres will take it with a
single small profile — KFT, LFT, CBC, CBC with ESR, HbA1c, Iron Profile,
Vitamin Profile, Anemia Profile — at ₹21, with an introductory ₹11 against
it while the offer runs, and expects to raise the price on demand. `inf_smart_report_mini` (148) lists those items by the
order form's own kinds, 'profile' or 'test' (CBC and HbA1c are single
parameterised tests, not profiles), each row carrying the mini price and the
offer price (149), so the offer is data: adding an item, raising the price
or ending the offer (offer_mrp to NULL) is one row, and the form, the floor
and the bill follow. The tier is decided in ONE place,
`CustomTest.PriceFor`: a cart with an HR package is priced by 144 even when
a mini profile is also present; a B2B cart with a mini profile and no
package gets the offer price, or the mini price once the offer ends; a walk-in cart with only a mini profile
is not offered the booklet, because the lab named B2B. Placement re-prices
from that rule and the record it hands the order procedure carries the
tier's price, so the `telo_custom_test_order` row reads ₹11 and the Smart
Report gate — keyed on the purchase, not the price — opens as before. On
the form the chip remounts when the tier changes, so the moment an LFT makes
the order qualify it rises in, pulses three times and carries an
"Introductory offer" badge with the mini price struck through beside the
offer price (₹21 struck, ₹11); reduced motion keeps the badge only. The
badge uses fixed deep teals rather than the theme teal: white on the theme
colour is 3.9:1 in light and 1.9:1 in dark, below the 4.5:1 text this small
needs; the fixed pair is 5.4:1 and 7.5:1 in both themes. The booklet itself needed no change: its
content is keyed on analyte names, not on the package, so an LFT-only visit
yields a coherent one-chapter booklet. Eight review bookings live on
ZZTEST01 under invented but realistic patient names (ZZMINI01–08, `api/db/data/zztest01-smart-mini-fixtures-20260920.sql`).
Found on the way: the 50% counter floor called ResolveAsync with its
arguments swapped, so no extra ever counted toward it; fixed. The Anemia
Profile is inactive in the catalogue and cannot be ordered until the lab
reactivates it — listed so it is covered when that happens, the catalogue
untouched. Staging only until the lab has reviewed the booklets.

## The body-map booklet is the Smart Report (2026-09-21)

Smart Report format v2 — the booklet with the body-map page — is no longer
"under test": it is the Smart Report, everywhere, with no picker. The print
route renders it unless a caller asks for `format=v1` by name (kept so the
two can be compared), the PDF routes default to it the same way through
`ReportFormat.NormaliseSmart`, and the modal's Format select is gone —
the lab does not want a choice offered in production, just the one booklet.
The clinical report's per-desk Format select is untouched by this and stays
where it was: its v2 and v3 remain staging-only. What the production build
leaves out of main is therefore: the clinical formats' WEB files only
(2589c9f, 3ca9dca, 4d9c2c0 — the API keeps `ReportFormat` and the
`format` plumbing, which the booklet now needs and which the v1 clinical
page simply ignores). The mini-profile offer was reviewed on staging the
same day and went to production with everything else.

## The Smart Report's introductory prices are dated, and end after Diwali 2026 (2026-09-21)

Both tiers are on offer: the booklet with a health package at ₹49 instead
of ₹99, and with a mini profile at ₹11 instead of ₹21, "till Diwali 2026" —
Sunday 8 November — after which both revert to list. `inf_smart_report_offer`
(150) holds one row per tier with the offer price, the last day and the
note the operator sees; the API sends only offers still in force, so on
9 November the chip shows the list price with no badge and nothing has to
be switched off. `CustomTest.PriceFor` bills the offer price while it
lasts and the list price after, and the chip strikes its tier's list
price beside the offer, with "Introductory offer · till Diwali 2026" on
the badge. The list prices themselves are untouched: ₹99 stays in Telo's
`telo_custom_test`, ₹21 in `inf_smart_report_mini`. That table's own
offer_mrp (149) is superseded and ignored by code from 150 onward; it is
cleared once every stack reads from the offer table. Extending an offer is
an UPDATE of offer_until; ending one early is dating it yesterday.
