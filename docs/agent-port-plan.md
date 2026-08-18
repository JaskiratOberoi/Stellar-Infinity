# Porting the rest of the LIS — the agent plan

How to run the remaining port as a set of agent teams, so that every one of the
legacy application's 113 pages ends the project with a verified disposition and
none of them is lost in the gap between "we listed it" and "we built it".

The unit of work is a **feature**, not a page — the LIS often spreads one
feature across several pages (four Normal_Ranges screens are one feature), and
occasionally hides two features in one page. The master inventory below maps
every page to a feature; the completeness gate at the end checks the mapping in
both directions.

---

## 0. Ground rules every agent inherits

These are the landmines this project has already stepped on once. Every agent
brief includes them verbatim; a build that violates one fails review
automatically.

1. **Noble is production.** The staging stack (`infinity-staging`) runs against
   the LIVE LIS database. There is no sandbox. Schema changes are production
   migrations; destructive verification is forbidden. Probe rows must be
   removed and their removal shown.
2. **One store, two front ends.** The LIS keeps running while Infinity grows.
   Every ported feature reads and writes the SAME legacy tables the LIS reads —
   the attachments feature is the template. New `inf_*` tables are allowed only
   for things the legacy schema cannot express (audit, auto-auth config), never
   as a parallel copy of legacy data.
3. **`SET QUOTED_IDENTIFIER ON; GO`** at the top of every SQL script. It is
   baked into objects at creation time; filtered indexes, MERGE and computed
   columns all die without it. This has bitten four times.
4. **Deploy scripts run in filename order.** A script may not reference a
   column or object a later-numbered script creates. Use `NNa_` suffixes to
   slot fixes between numbers.
5. **Scope before existence.** Identity → capability → client-code scope →
   then the row. Out-of-scope is 404, not 403 — asking about a SID must not
   reveal that it exists. Every value used in a check comes from what the
   DATABASE returned, never from what the caller supplied.
6. **Audit is append-only** (`inf_result_audit` pattern: rollback trigger, no
   UPDATE/DELETE). Anything an operator can change needs an audit row with
   actor, ip, old value, new value, reason.
7. **Files are validated by magic bytes**, not extension; size-capped; served
   with a correct Content-Type and a filename that says what it is.
8. **Cookie auth + CSRF.** All writes carry the `X-CSRF-Token` header;
   multipart uploads must NOT set Content-Type manually.
9. **`/print/report/*` routes are documents, not sessions** — they neither
   register in the tab registry nor judge the session. Any new render-target
   route must be added to `isRenderSurface()` or PDFs will 502.
10. **Legacy free text is not HTML-safe and not HTML-free.** Use `plainText()`
    (which strips only the tags the LIS emits — a blanket stripper eats
    "<0.5" in reference ranges).
11. **The catalogue join trap.** `tbl_med_test_master` joins on `testid`, and
    every row of a test shares one `testid` — catalogue columns are TEST-level
    facts, never row-level names. This just caused the wrong-names report bug.
12. **Deploy to `infinity-staging` for evaluation.** The `infinity` stack is
    the live one; it gets a build only when the user says so.
13. **Verify by running.** Playwright against the deployed staging bundle,
    driving the UI the way an operator does; API probes over real HTTP. Stub
    at the network boundary when production credentials aren't warranted, but
    the bundle under test is always the built one, never a dev server.

---

## 1. Master inventory — every legacy page, its feature, its disposition

Dispositions: **PORT** (build it in Infinity), **MERGED** (already covered by
an existing Infinity screen — agent must prove the coverage, behaviour by
behaviour), **ASK** (needs a decision from the lab before any build), **DROP**
(dead in production — record the evidence, build nothing).

Evidence for dispositions below: production row counts and 90-day activity
measured 2026-08-17.

### Worksheet group

| Page | Feature | Disposition |
|---|---|---|
| Worksheet\Worksheet.aspx | Result entry | MERGED — Worksheet + WorksheetEntry |
| Worksheet\SampleWorksheet.aspx | Sample worklist | MERGED — Worksheet |
| Worksheet\Accession.aspx | Accessioning | MERGED — Accessioning |
| Worksheet\Search.aspx | Sample search | MERGED — worklist filters; prove parity |
| Worksheet\EditWorkOrder.aspx | Edit registered order | MERGED — OrderDetail; prove parity |
| Worksheet\Inward.aspx | **F1 Sample transit tracking** | **PORT** — 58,085 scans/90d, live this morning |
| Worksheet\Outsourcing.aspx | F7 Referral-out | ASK — usage unmeasurable from writes seen so far |
| Worksheet\Extract.aspx | Data extract | ASK — likely subsumed by Reporting export |
| Worksheet\IHCReport.aspx | F7 IHC narrative reports | ASK |
| Worksheet\icmr_docs.aspx + ICMR project | F7 ICMR submissions | ASK — regulatory; lab must confirm current obligation |
| Worksheet\fancy.aspx | (uploader shim) | DROP |

### Admin_Technical group — F2 Catalogue authoring unless noted

| Page | Disposition |
|---|---|
| Test_Master, Test_Parameter_Master, Parameter_Master | PORT (F2) |
| Profile_Master, MasterProfile_Master | PORT (F2) |
| Test_Normal_Ranges(+_Master), Test_Param_Normal_Ranges(+_Master) | PORT (F2) — four screens, ONE feature |
| Test_Param_Default_Values | PORT (F2) |
| Sample_Master, Department_Master, Reason_Master, Signature_Master | PORT (F2) |
| TestRate_Master, Profile_Rate_Master, MasterProfile_Rate_Master, SpecialRateMaster | MERGED — RateLists; prove parity per screen |
| EditSample_Master | PORT (F2) — sample-type corrections post-registration |
| Organism.aspx, Organism_Drugs.aspx | ASK (F7 micro) — 27 organisms configured, ~0 organism-typed result rows in the recent 1.93M |
| AllergyReport.aspx | ASK (F7 allergy) — 172,982 historic rows, 0 samples in 90d |

### Billing group

| Page | Feature | Disposition |
|---|---|---|
| Bill.aspx, Billx.aspx | Invoice | MERGED — PrintInvoice + InvoiceConfig |
| Billreceipts.aspx | Receipts | MERGED — BillingEndpoints |
| Dues.aspx, DueReport.aspx | **F3 Outstanding balances** | **PORT** — data already drives the 423 report lock; needs its worklist |

### Admin_General group

| Page | Feature | Disposition |
|---|---|---|
| Security_Master, UserType_Master | **F4 Permission governance** | PORT — today the role→capability map is hardcoded in InfinityRoles.cs |
| User_Department_Mapping | F4 | ASK — implemented in the LIS but never enforced; decide whether it should exist before porting the ghost |
| BusinessUnit_Master, MccUnit_Master | F4 reference masters | PORT |
| Mcc_Account, Mcc_Account_invoice, LockUnlock_MCC | Client account admin | MERGED — ClientAccounts; LockUnlock needs parity proof against the 423 lock |
| Audit_Trail.aspx | **F5 Lab-wide audit search** | PORT — Infinity has only the per-sample History modal |
| MccUser_Master | User admin | MERGED — AdminUsers |
| ChangePassword | Self-service password | MERGED — UserSettings; prove parity |
| testcosting.aspx | Cost analysis | ASK |
| das-adm, das-cli, das-fin | Dashboards | MERGED — Dashboard; read-only so usage unmeasured, prove chart parity with lab |
| frm_mcc_franchise_mapping | Franchise mapping | ASK |
| Birthdays, News, frm_mcc_news_marquee, ScrollingImages, Downloads, Callhealth_Ack | Noticeboard | DROP |

### Pcc group — **F6 Client portal** (one feature, ~20 pages)

Customers, Doctors, PatientWorkOrder, Worder/Workor/Workorder(_om/_OM1),
SampleSent, SampleStatus, CourierStatus, PrintBill, Payment, checkout,
ccavRequestHandler/ccavResponse, razorCheckout/razorCallback, hrf, mrf, wa,
WebForm1, WebForm2.

Disposition: **PORT as a phase of its own** — it is a second audience
(collection centres and patients) with its own auth story. The five Workorder
variants are one flow forked repeatedly; the analysis agent must diff them and
port the union, not five screens. WebForm1/2 are scaffolding → DROP.
CourierStatus: 11 rows ever → DROP inside the phase unless the lab objects.

### Sales group — **F8 Sales/MIS** (read-heavy: usage unmeasurable from writes)

SalesCodeWise, SummarySalesofMCC, SalesDataForMcc, SalesTestTransForMcc,
LedgerStatusofMcc, mis_active, Sales_user_targets (348 target rows), BillCfad.
Disposition: PORT after the lab ranks which reports they still open.

### Inventory group — 13 pages

Every stock/log/control/history table at 0–2 rows; 2 indents ever; 5 vendors.
Disposition: **DROP** — record the counts in the decision log and build nothing.

### Root pages

Default/Home/login/Signout/Error → MERGED (shell). g.aspx (graph handler) →
MERGED by the attachments endpoints, which exist to close its auth hole.
TinyMce.aspx → editor asset, DROP.

---

## 2. Phase order

Ordered by measured production use, then by how much other work each unblocks.

| Phase | Feature | Why this order |
|---|---|---|
| P1 | F1 Inward / transit tracking | Heaviest live use of anything missing (58k scans/90d); self-contained table; no dependency on other phases |
| P2 | F3 Dues worklists | Small; data and lock logic already exist; pure UI+read procs |
| P3 | F2 Catalogue authoring | Biggest build; unblocks the lab from ever opening Admin_Technical again; feeds worksheet ranges and report names |
| P4 | F4+F5 Governance & audit viewer | Depends on nothing; benefits from P3's master-screen patterns |
| P5 | F6 Client portal | Own auth audience; largest risk surface (payments); do it when the internal app is whole |
| P6 | F8 Sales/MIS | After the lab ranks the reports |
| P7 | F7 Specialist reporting (micro, allergy, IHC, outsourcing, ICMR, extract) | Every item is ASK-gated; build only what the lab confirms |

DROP dispositions are executed in P1 alongside the first decision log — they
cost nothing to record and closing them early shrinks the inventory everyone
else carries.

---

## 3. The standard agent team for one phase

Each phase runs the same five-role pipeline. Roles, not head-counts — a fat
phase (P3, P5) fans each role out across sub-areas; a thin one (P2) may run a
role as a single agent.

### Role A — Legacy analyst (read-only, one per sub-area)

Reads the `.aspx`, its `.aspx.cs`, the `MedCis.Business`/`MediCis.DAL` classes
behind it, and every stored procedure it calls. Produces a **behaviour
contract**: every field, validation, permission check (`CheckUserPage` id),
status transition, side effect, and quirk — including the bugs, each marked
`KEEP` (compatibility requires it) or `FIX` (defect; Infinity must not copy
it), with a one-line justification. The wrong-name join, the disabled-checkbox
clear and the status-10 comment bug were all `FIX`; the frozen-range printing
rule was `KEEP`.

### Role B — Schema verifier (read-only against Noble)

Takes Role A's contract and proves it against production: do the tables exist
as described, what are the real row counts, which columns are actually
populated vs always-NULL, which "features" the code implies are dead in the
data. Everything Role C builds cites Role B's findings, not Role A's reading
of fifteen-year-old code. This is the role that caught allergy (dead), micro
(configured but unused) and inventory (empty) before anything was built.

### Role C — Builders (one each for SQL / API / UI, per sub-area)

Build from the contract under the ground rules. SQL first (numbered scripts,
deployed to Noble), API second (endpoints + repository, staging deploy), UI
third (staging deploy). Each builder ends by listing what it did NOT cover
from the contract — an explicit remainder, so silence never reads as done.

### Role D — Verifier (adversarial, never the builder)

Writes and runs the Playwright/API verification against the deployed staging
bundle. Must include: the happy path driven as an operator would; every
permission gate (wrong role → refused); scope escape attempts (other client's
row → 404); input abuse (oversize, wrong magic bytes, injection strings in
anything that reaches a query); and cleanup of every probe row with proof.
Verifier receives the CONTRACT, not the code — it tests what the feature must
do, not what it happens to do.

### Role E — Completeness critic (one per phase, runs last)

Diffs three artefacts: the behaviour contract (A), the build remainders (C),
and the verification transcript (D). Emits the phase's gap list: contract
lines with no passing verification. A phase closes only when the critic's gap
list is empty or every remaining line is explicitly ACCEPTED by the user in
the decision log.

---

## 4. Completeness gates — how "not a single thing" is enforced

1. **Page-level gate.** `docs/port-inventory.md` (generated from §1) holds one
   row per legacy page. A page's row may only hold: PORTED (link to phase +
   verification), MERGED (link to parity proof), DROPPED (link to evidence +
   user sign-off), or ASK (link to the open question). The project is not done
   while any row says ASK.
2. **Behaviour-level gate.** Within a phase, Role E's empty gap list is the
   exit criterion — page-level porting is necessary, contract-level porting is
   sufficient.
3. **Parity proofs for MERGED.** "Already covered" is a claim, so it gets the
   same treatment as a build: Role A writes the contract for the legacy page,
   and a verifier shows each contract line satisfied by the existing Infinity
   screen. MERGED without a parity proof is just hope with a label.
4. **The decision log.** `docs/port-decisions.md`, append-only: every DROP,
   every ASK answered, every `KEEP`-a-bug choice, with date and who decided.
   When someone asks in two years why there is no inventory module, the answer
   is a line in a file, not archaeology.

---

## 5. What to run first

P1 (Inward tracking) end to end as the pilot of the pipeline: one analyst on
`Inward.aspx` + `tbl_acc_inward_sample_tracking`, one schema verifier, three
builders, one verifier, one critic — plus the DROP dispositions recorded in
the inventory and decision log. It is big enough to prove the pipeline and
small enough to finish in one phase.

Open questions to put to the lab before P6/P7 (collected here so they are
asked once): which Sales/MIS reports are still opened; whether micro
culture-and-sensitivity is done anywhere; whether allergy panels are coming
back; whether ICMR submissions are a current obligation; whether outsourcing
referrals still happen; whether department scoping should exist.

Added during P1 (Role B, 2026-08-17): the legacy grants the inward SCAN page
to 21 usertypes including client-portal users — 3,311 active PCC users can
scan (and thereby trigger accession side effects) today. Infinity's P1 build
denies clients scan access by default (order:accession); the lab should
confirm whether any client-side scanning is actually wanted, e.g. a
collection centre marking "handed to courier".
