# F3 — Outstanding balances / dues: production schema findings

Role B (schema verifier) output for Phase P2, run against the LIVE Noble
database on 2026-08-17, read-only (SELECT only, ad-hoc helper, deleted after
use; no INSERT/UPDATE/DELETE, no DDL, no temp objects, no procedure executed —
every procedure below was read from `sys.sql_modules`). Companion to Role A's
work on `Billing\Dues.aspx` + `DueReport.aspx`.

Money is live: balances moved between queries in this session (the count of
owing accounts read 1,851 at 15:14 and 1,854 at 15:38). Treat every figure as
±0.2% and as of **2026-08-17 ~15:30 IST**.

**Everything Role C builds cites this file, not the code reading.**

---

## 0. The answer to the question the phase exists to ask

**The stored balance DOES reconcile with its ledger. It is safe to build on.**

Method: the ledger row carries the balance before (`currentbalance`), the
movement (`testcharges`) and the balance after (`closingbalance`). For each
account with activity in the last 90 days:

```
break = last_closing - first_current - SUM(closing - current)
```

A non-zero `break` is money that left or entered the wallet **without** a
ledger row — the only thing that can make a dues screen lie.

| measure (90 days, 1,630 accounts, 530,990 ledger rows) | value |
|---|---|
| accounts whose chain is perfectly intact | **1,474 (90.4%)** |
| accounts with at least one break | 156 (9.6%) |
| total UNEXPLAINED movement (absolute) | **Rs 81,050** |
| net unexplained movement | Rs +43,462 |
| largest single break | Rs 12,000 |
| total debits actually moved in the same window | Rs 8,27,04,946 |
| **unexplained as a share of movement** | **0.098% — about 1 rupee in 1,000** |
| stored `currentbalance` = last ledger `closingbalance` | **1,627 / 1,630 (99.8%)** |

All-time (all 3,622 accounts): 3,312 of the 3,317 accounts that have any ledger
row agree exactly with their last `closingbalance`. The **five** exceptions,
in full:

| client | name | stored | last closing | diff | last ledger row |
|---|---|---|---|---|---|
| DL0390 | Sharon Medical Centre | -13,189 | -5,189 | -8,000 | 2024-03-29 |
| JHANSI015 | Rinki collection Point | 90 | 335 | -245 | 2025-05-03 |
| STAFF CODE | NOBLE STAFF | -165,705 | -153,705 | -12,000 | 2026-08-07 |
| HR0701 | DEV CLINICAL LABORATORY | 1 | -549 | +550 | 2026-08-16 |
| PB0504 | CHOUHAN COMPUTERISED LAB | -2,645 | -2,495 | -150 | 2026-06-12 |

Total drift across the whole business: **Rs 20,945**, max Rs 12,000, on a book
of Rs 22.15 crore. And the 305 accounts with no ledger row at all carry a
balance of **exactly zero** — there are no phantom balances.

Caveat Role C must carry: this proves the balance is consistent with the
LEDGER, i.e. with what the LIS believes it charged. It does not prove the LIS
charged the right amount — §5 shows Rs 16.7 lakh of accessioned work that was
never charged at all, and Rs 29,423 double-charged in 30 days.

---

## 1. The account model

`dbo.tbl_med_mcc_account_master` — **3,622 rows**, and
`dbo.tbl_med_mcc_unit_master` has **3,622 rows**. Exactly one wallet per
client: 0 duplicate `mcccode`, 0 orphan accounts, 0 clients without one.

| column | type | reality |
|---|---|---|
| id | int identity | PK, clustered — the **only** index on the table |
| mcccode | int | = `tbl_med_mcc_unit_master.id` (the surrogate, NOT `MCCUnitCode`). Never NULL. No unique constraint — the 1:1 is held up by `IF NOT EXISTS` in the writer procs, not by the schema |
| totaldeposited | int | never NULL but **not trustworthy** — the two largest debtors show 0 against millions of ledger movement |
| currentbalance | int | never NULL. **Whole rupees only** — the ledger is `decimal(16,2)` |
| lastupdatedby | nvarchar(100) | **NULL on 3,619 of 3,622** |
| lastupdateddate | datetime | **NULL on 3,619 of 3,622** |

The three populated `lastupdated*` rows were all written by Telo
(`telo:6593`, `telo:balance-resync` ×2, May–Jun 2026). **The LIS's own balance
update does not stamp them.** There is no "balance as of" in this table.

**Sign convention: NEGATIVE means the client OWES the lab.** Confirmed by both
writer procs (`usp_telo_post_ledger` decrements on a charge,
`usp_telo_record_mcc_payment` increments on a payment) and by the data.

### Distribution

| | accounts | total |
|---|---|---|
| positive (in credit) | 1,095 | +Rs 39,20,101 |
| zero | 676 | 0 |
| negative (owes) | 1,851 | **-Rs 22,14,96,430** |
| NULL | 0 | — |

By size of debt:

| bucket | accounts | total |
|---|---|---|
| owes > Rs 10 lakh | **22** | **-Rs 18,74,45,768 (84.6%)** |
| owes Rs 1–10 lakh | 81 | -Rs 2,48,03,506 |
| owes Rs 10k–1 lakh | 211 | -Rs 63,98,987 |
| owes Rs 1k–10k | 779 | -Rs 24,80,539 |
| owes Rs 1–999 | 758 | -Rs 3,67,630 |

### Largest debits (top 10)

| code | name | active | balance | totaldeposited | PerminentUnlock | last ledger |
|---|---|---|---|---|---|---|
| RUDARPUR | RUDARPUR | No | -5,89,67,550 | 0 | **Yes** | 2024-07-15 |
| ROORKEE | ROORKEE | Yes | -5,62,06,350 | 0 | **Yes** | 2025-01-13 |
| SAMARPAN | SAMARPAN HOSPITAL | No | -1,91,64,645 | 1,82,775 | **Yes** | today |
| DL0214 | KHETRAPAL HOSPITAL | No | -1,37,92,738 | 0 | **Yes** | today |
| HR0044COVI | LHDM AND PREM HOSPITAL | No | -52,07,455 | 0 | **Yes** | 2026-08-16 |
| MDCARE | MEDICARE SUPER SPECIALITY | No | -32,01,351 | 200 | **Yes** | today |
| DL0142 | DR P BHASIN PATH LABS | No | -31,92,790 | 24,000 | **Yes** | 2026-08-16 |
| JM0007 | JAMMU CITY ONCOLOGY | No | -29,16,198 | 13,960 | No | today |
| MEDSKY | MEDSKY PATH LAB | No | -24,47,665 | 1,08,130 | **Yes** | today |
| DL0158C0VID | DM OFFICE DELHI | Yes | -23,89,500 | 0 | **Yes** | 2020-10-20 |

### Largest credits (top 10)

GENOMICS +20,79,900 · DL0133 SPRING MEADOWS +14,59,250 · HR0041COVI ELITE TECH
+73,568 · HR0040 NOBLE GEN +69,635 · HR1028 VISHAL LABORATORY +21,710 ·
DL0171COVI PCC-GENOMICS +17,900 · HR0334 Muskan +10,015 · J&K0001 A Care health
+9,375 · DL0321 NORTH WEST CDMO +7,500 · J&K0001B Patients care +6,985.

The two largest credits are Noble's own entities. Real client credit is small.

---

## 2. The ledger

`sp_mcc_test_account_101` (and its `_100` / bare siblings, all created
2019-02-21, never modified) does exactly one thing: **INSERT one row into
`dbo.tbl_med_mcc_test_transactions`**. It does NOT touch `account_master` —
the balance UPDATE lives in the caller (`MccAccountClass` in the LIS,
`usp_telo_post_ledger` on the Telo/Infinity side). The `@SUBFRANCHISE`
parameter lands in the ledger's `description` column (§7).

`dbo.tbl_med_mcc_test_transactions` — **5,488,130 rows / 718 MB clustered**.

| column | type | notes |
|---|---|---|
| id | int identity | PK clustered |
| mccid | int NOT NULL | = `unit_master.id`. 0 NULL/zero in 90d, 0 orphans |
| transdate | datetime | 2019-03-14 → live. **7 NULLs** ever |
| currentbalance | decimal(16,2) | balance BEFORE |
| testcharges | decimal(16,2) | magnitude of the movement |
| closingbalance | decimal(16,2) | balance AFTER |
| userid | int NOT NULL | |
| tname | nvarchar(200) | test name, or `ONLINE` / `Payment-<note>` for credits |
| vailid | nvarchar(100) | blank on the payment rows |
| patientid | int | 0 on the payment rows |
| description | nvarchar(100) | sub-franchise code; blank on 96% of rows |

**It is not a charge log — it is a two-directional running-balance ledger.**
In the last 30 days:

| direction | identity | rows | amount |
|---|---|---|---|
| debit (test charged) | `closing = current - charge` | 158,360 | Rs 2,85,60,504 |
| credit (payment) | `closing = current + charge` | 23,104 | Rs 2,67,71,419 |
| neither | — | **0** | — |

Credit rows by `tname`: `ONLINE` 18,922 (Rs 1.68 crore), then
`Payment-CASH RECEIVED BY RIYAZ`, `Payment-UPI MERCHANT TRNS ID …`, etc. So
`testcharges` on a payment row is a CREDIT despite its name, and 68,330 of the
530,977 rows in 90 days (12.9%) have no patient and a blank vailid — those are
the payments.

Volume: **530,990 rows in 90 days, 181,423 in 30 days**, last row written
seconds before this query. `userid` 1 (the online-payment system account)
writes 18,918 rows/30d, then human users 4333, 3109, 2844, 4329, 716…

**Immutability.** The table has NO `updatedby`/`updateddate` columns and no
trigger — a ledger row cannot be edited by any code path in the database.
Identity gaps: 3,988 missing ids in the most recent 616,721 (0.65%), which is
rolled-back transactions, not deletion (there is no DELETE path anywhere in
`sys.sql_modules`). `account_detail`: 56 gaps in its last 27,894 (0.2%).

**Indexes:** PK(id), `(mccid, transdate, userid)`, `(vailid, patientid)`,
`(transdate, patientid)`. A per-client statement ordered by date is a clean
seek; **no index covers `testcharges`**, so `SUM(testcharges)` over an account's
history is a lookup-per-row. Use the stored running balance instead of summing.

`decimal(16,2)` but **0 fractional values in 90 days** — whole rupees
throughout. The INT `currentbalance` would silently truncate paise if any ever
appeared.

Data quality: 159 rows with `testcharges = 0` in 90d.

---

## 3. The deposits book (`tbl_med_mcc_account_detail`)

551,204 rows. The second money table — a record of *payments and adjustments*,
parallel to the ledger's credit rows.

| credittype | meaning (from the data, not the code) | rows | total |
|---|---|---|---|
| 1 | payment / deposit | 518,683 | Rs 89,06,91,969 |
| 2 | refund or credit adjustment — free-text `Reason` ("REFUND FOR Double Marker Test LOW WEEKS (PID - …)", "ADJUSTMENT AGAINST BHIWANI COLLECTION CENTRE'S RENT…") | 27,978 | Rs 5,82,68,637 |
| 3 | extra charge — biopsy specimen surcharges ("BIOPSY OF <name> ( PID - … ) SMALL TO LARGE SPECIMEN") | 4,527 | Rs 27,91,507 |

`deposittype`: **5 = Online 425,599 (77%)**, 3 Cash 84,789, 6 Other 37,401,
4 NEFT 1,579, 2 Cheque 850, 1 DD 565, 7 Reject 413, 8 NULL.

**`debit_flag` is a dead column** — NULL on 551,188 of 551,204 rows. The only
16 non-NULL rows were written by the Telo/Infinity procs. `credittype` is the
real classifier; anything that branches on `debit_flag` is reading a column the
LIS has never populated.

**`depositedate` is operator-editable and dirty.** In the last 90 days, 880
rows (Rs 80.0 lakh) are backdated by a day or more and 44 of them (Rs 15.2
lakh) by more than 60 days. All-time it holds impossible values: 10 rows dated
in the future, including **a Rs 29,73,599 credit dated 2109-10-04** entered in
January 2022. `addeddate` is the honest timestamp — 67,178 of the 90d rows are
same-day.

`updatedate` is set on 551,192 of 551,204 rows but sits within 60 seconds of
`addeddate` on all but **2** — it is an insert artefact, not an edit log.

**Do the two books agree?** Over 90 days, on `addeddate`:

| | rows | amount |
|---|---|---|
| account_detail (all credittypes) | 68,059 | Rs 7,41,31,378 |
| ledger credit rows | 67,960 | Rs 7,47,54,284 |

Within 0.8% but **not row-for-row identical**. The LEDGER is the book that
moves the balance (§0); `account_detail` is the payment record the LIS screens
read. Where they disagree, the ledger wins.

Indexes: PK(id), `(mcccode, credittype)`, `(mcccode, depositedate)` — a
per-client payment history is a seek.

---

## 4. What the legacy DueReport actually computes (and why it cannot tie out)

`usp_mcc_ledger_status301` / `sp_mcc_ledger_status301` (the DueReport procs)
return three money columns from **three different sources**:

- `balance` = `account_master.currentbalance` — the reconciled number.
- `deposits` = `SUM(account_detail.amount) WHERE credittype = 1` filtered on
  **`depositedate`**.
- `testcharges` = `SUM(patient_tests.test_rate)` filtered on
  `patient_tests.updateddate` — **not from the ledger at all**, and it counts
  test rows regardless of whether they were ever charged.

Measured over one 7-day window:

| column | legacy figure | what actually happened (ledger) | error |
|---|---|---|---|
| testcharges | Rs 64,61,857 | Rs 68,45,836 debited | **-5.6%** |
| deposits | Rs 56,32,502 | Rs 81,83,341 credited | **-31%** |

The deposits gap closes to ~-4.5% when recomputed on `addeddate` instead of
`depositedate` (Rs 78,17,439) — the rest is the backdating in §3, plus
credittypes 2 and 3 that the legacy column drops.

**Neither period column reconciles against the balance shown beside it.** A
ported screen that puts them in the same row is presenting three numbers that
do not add up and inviting the lab to trust the arithmetic.

---

## 5. The charge-once latch (`tbl_med_mcc_patient_tests.amount_checked`)

4,957,271 test rows.

| amount_checked | rows | last updateddate |
|---|---|---|
| TRUE (charged) | 4,925,366 | live |
| NULL | 31,486 | 2026-08-03 |
| FALSE | 419 | 2020-02-09 (dead value) |

So **31,905 rows (0.64%) were never charged, worth Rs 1,02,04,015 of test
value.** That headline number is misleading, and the split is the point:

| | rows | value |
|---|---|---|
| patient's samples never reached status ≥ 2 — **not yet chargeable** | 26,011 | Rs 84,68,256 |
| **sample WAS accessioned (status ≥ 2) — never billed** | **5,518** | **Rs 16,68,046** |
| no sample row at all | 376 | Rs 67,713 |

Of the accessioned-but-uncharged: **342 rows / Rs 60,814 / 151 clients** are
within the last 90 days (still recoverable), and 5,176 rows / Rs 16,07,232 /
658 clients are older than that. Age of the whole uncharged set by registration
date: 4,328 rows (Rs 8,19,519) in 0–90d, 6,759 (Rs 12,66,623) in 91–365d,
20,818 (Rs 81,17,873) older than a year.

**The honest "money the lab never billed" figure is Rs 16.7 lakh, not
Rs 1.02 crore.** The rest is work in progress and pre-accession attrition.

The latch is a latch, not a constraint: in the last 30 days, **137
(patient, test name, client) groups were charged more than once — 147 extra
ledger rows, Rs 29,423 double-charged.**

Index note: the table carries **two identical indexes** on
`(amount_checked, updateddate)` — `index_patient_tests_amount_updatedate` and
`index_tests_amount_updateddate` — duplicated dead weight on 4.96M rows.

---

## 6. The report lock, measured

Infinity's `ReportLockRepository` (api/src/Infinity.Api/Reports/) reads, in
order: the patient's own bill (`tbl_billing_patient_detail.Balance` by `medid`)
and, only if the patient has no bill of their own,
`account_master.currentbalance` against `unit_master.creditlimit` (a NEGATIVE
floor), with `unit_master.PerminentUnlock` overriding everything.

**`creditlimit` — populated, but thinly:**

| value | clients |
|---|---|
| NULL | **2,111 (58%)** |
| negative (a real allowance) | 1,400 |
| 0 | 92 |
| positive (meaningless; Infinity correctly ignores) | 19 |

Most common: **-1 on 381 clients** (an allowance of one rupee), -1000 (283),
-100 (156), -500 (151), -2000 (87), -5000 (61). `PerminentUnlock = 1` on 130
clients.

**Lock counts today:**

| rule | clients locked |
|---|---|
| Infinity's rule (balance < negative floor, PerminentUnlock wins) | **1,218** (421 of them IsActive) |
| the LIS rule in `usp_mcc_ledger_status301` (balance ≤ 0 unless allowed) | **1,770** (521 active) |
| clients holding a LIVE temporary unlock right now | **66** |
| of 948 clients with a negative limit AND owing: over their limit | 395 (101 active) |

Three divergences Role C must resolve, not inherit:

1. **Infinity does not read `tbl_med_mcc_lockunlock` at all.** That table
   (2,332 rows, one per client, actively used — last row added 2026-08-15 by
   SAGAR1920, typical grants of 1–8 hours) is the LIS's "let them through for
   the next N hours" mechanism, exposed as `LockUnlock_MCC.aspx`. **66 clients
   are inside a live unlock window as of now** and Infinity would still lock
   their reports.
2. **The NULL-limit case diverges at exactly zero.** The LIS expression is
   `creditlimit < currentbalance` — with `creditlimit` NULL (58% of clients)
   that is UNKNOWN, so the client falls through to LOCKED at balance ≤ 0,
   including balance exactly 0. Infinity treats NULL as floor 0 and unlocks at
   0. **676 clients sit at exactly zero today.**
3. The older `sp_mcc_ledger_status` variant locks on
   `currentbalance < 0 AND expire_unlock < GETDATE()`, i.e. it treats an
   EXPIRED unlock as the trigger and shows nothing at all for a client that
   never had an unlock row. It is incoherent. Do not port it.

**B2C side:** `tbl_billing_patient_detail` — 23,342 bills, **2,310 with a
balance above zero, Rs 12,20,040 outstanding.** Small next to the client
wallets, but it is the branch the lock hits first.

**And the lock has almost nothing to do with the top of the dues list:**

| | clients owing | amount owed |
|---|---|---|
| `PerminentUnlock = 1` | **83** | **-Rs 18,55,88,950 (83.8%)** |
| everyone else | 1,770 | -Rs 3,59,17,100 |

16 of the 22 largest debtors are permanently unlocked.

---

## 7. Client scoping, and how sub-clients roll up

- **`account_master.mcccode` = `tbl_med_mcc_unit_master.id`** — the int
  surrogate, NOT `MCCUnitCode`. Proven by zero orphans in every direction:
  account_master ↔ unit_master both ways, `account_detail.mcccode` (0 unmatched
  clients), 90d ledger `mccid` (0 unmatched). Same key the report lock already
  uses (`a.mcccode = u.id`).
- **`MCCUnitCode` hygiene is clean** — 3,622 codes, **0** with leading or
  trailing whitespace, **0** case-insensitive duplicates. Infinity's
  `UPPER(u.MCCUnitCode) = @code` is safe here (unlike the inward vailids).
- **Sub-clients / franchises:** `tbl_med_mcc_unit_franchise_mapping`, **88
  pairs** (`mcc_code` = parent → `sub_franchise_code` = child). Every client,
  parent or child, has its own wallet row.
  **The charge posts to the PARENT's `mccid`, with the child's code written
  into `ledger.description`** — that is exactly what `@SUBFRANCHISE` does in
  `sp_mcc_test_account_101`. Verified:

  | description (child) | child's own id | posted to mccid | parent code | 90d rows |
  |---|---|---|---|---|
  | AG0235A | 5006 | 5005 | AG0235 | 4,063 |
  | AG0050A | 819 | 778 | AG0050 | 1,898 |
  | J&K0001 A | 457 | 452 | J&K0001 | 1,798 |
  | Generic Diagno Lab | 5067 | 428 | UP0035 | 1,561 |
  | AG0146A | 2242 | 2241 | AG0146 | 1,473 |
  | UK0089 | 4774 | 4772 | KRISHAN | 1,140 |
  | HP0002B | 946 | 435 | HP0002 | 877 |
  | UP0001B SCIENTIFICAL PATH LABS | 648 | 84 | UP0001 | 310 |

  **So dues already roll up — no aggregation needed, and none must be added or
  the money doubles.** But the rollup is not universal: of the 88 mapped
  children, **27 carry their own non-zero balance and 31 have their own ledger
  history**. A screen that shows only parents will hide those; a screen that
  shows all clients flat is correct and complete.
- `description` is **free text, not a code FK** — 21,620 of 530,969 90d rows
  (4.1%) carry a value; some are names ("Generic Diagno Lab"), some are
  self-references (DL0214 tagged onto its own account's rows, 8,223 of them).
  Display it; never join on it.
- **Legacy sales scoping:** `tbl_med_user_sales_mcc_mapping` — 11,541 rows,
  250 users, 2,893 of 3,622 clients mapped. `…ledger_status301 @type = 2`
  restricts the report to the caller's mapped clients; `@type = 1` shows
  everything. `usp_mcc_ledger_status301` adds a `BusinessUnitCode` filter.
  Infinity's own client-code scope must be the gate — this mapping is a
  reporting convenience, and 729 clients are in nobody's list.

---

## 8. What contradicts a plain reading of the legacy code

1. **`sp_mcc_test_account_101` looks like the balance writer. It only INSERTs
   a ledger row.** The `UPDATE account_master` lives in the caller. Anyone
   reading the proc to learn "how the balance changes" learns nothing.
2. **The ledger looks like a charge log** (`test_transactions`, `testcharges`).
   It is a signed running-balance ledger: 12.9% of 90d rows are payments whose
   `testcharges` is a CREDIT, with no patient and a blank vailid.
3. **`currentbalance` looks like "how much they have". Negative means they
   OWE.** Displaying it raw inverts every number on the screen. Infinity's
   `usp_inf_client_accounts` already flips it once and exposes `owed`; reuse
   that convention.
4. **`lastupdatedby`/`lastupdateddate` look like the balance's audit trail.**
   NULL on 99.9% of rows; only Telo ever wrote them. There is no "as of".
5. **`debit_flag` looks like the debit/credit switch on the deposits book.**
   NULL on 99.997% of rows. `credittype` is the real classifier.
6. **The DueReport's period columns cannot be reconciled with the balance
   beside them** (§4): charges come from `patient_tests.test_rate` and not the
   ledger (-5.6% in one week), deposits are filtered on an operator-editable,
   backdatable `depositedate` (-31%).
7. **`creditlimit` looks like credit policy.** 58% of clients have none, and
   381 have "-1".
8. **The dues total looks like receivables.** 84% of it (Rs 18.56 crore) sits
   behind `PerminentUnlock`, and **63% (Rs 14.02 crore) belongs to 1,179
   accounts with no ledger movement for over a year** — including two branch
   accounts, RUDARPUR (-Rs 5.90 crore, last ledger row 2024-07-15) and ROORKEE
   (-Rs 5.62 crore, 2025-01-13), which between them have **one** recorded
   payment row in the entire history of the deposits table.
9. **The real collectible worklist is tiny.** Active clients that have traded
   in the last 90 days AND owe money: **257 clients, Rs 26,62,610** — 1.2% of
   the headline. Staleness of all 3,622 balances by last ledger movement:

   | last movement | accounts | owed |
   |---|---|---|
   | 0–7 days | 1,228 | -Rs 7,75,05,408 |
   | 8–30 days | 215 | -Rs 10,16,505 |
   | 31–90 days | 187 | -Rs 4,98,386 |
   | 91–365 days | 508 | -Rs 23,00,413 |
   | **> 1 year** | **1,179** | **-Rs 14,01,82,198** |
   | never | 305 | 0 |

10. **`account_master` has no unique constraint on `mcccode`.** Today it is 1:1
    by luck and by `IF NOT EXISTS` in three writer procs racing each other.
11. **`tbl_med_mcc_lockunlock` is alive and Infinity has never read it** —
    66 live unlocks right now (§6).
12. **`tbl_med_mcc_patient_tests` carries two identical indexes** on
    `(amount_checked, updateddate)`.
13. **The lab is still double-charging occasionally** despite the latch —
    Rs 29,423 across 137 groups in 30 days.

---

## 9. For Role C — what is SAFE to display, and what must be COMPUTED

### Safe to display as authoritative

- **`-account_master.currentbalance` as "amount owed."** Reconciles to 0.098%
  of movement; 99.8% of active accounts match their ledger exactly (§0).
- **`tbl_med_mcc_test_transactions` as the statement of movements**, including
  its stored `currentbalance`/`closingbalance` — the table has no edit path and
  no delete path.
- **Sign convention** (negative = owes) and **whole rupees**.
- **Client identity**: `mcccode → unit_master.id`; `MCCUnitCode` is unique and
  whitespace-clean; sub-client charges already roll up to the parent.
- **`PerminentUnlock` and `creditlimit`** as stored values — but label them
  honestly (58% of clients have no limit).

### Must be computed, or must not be shown

- **`totaldeposited`** — do NOT display as "total paid". It reads 0 for the two
  largest debtors and 200 for MDCARE against Rs 32 lakh of debt. Not reconciled
  by this review. Compute from the ledger's credit rows if the number is wanted.
- **"Balance as of"** — `lastupdateddate` is NULL on 99.9%. Derive from
  `MAX(ledger.transdate)` for the client.
- **Any period figure** (deposits in a range, charges in a range) — compute from
  the ledger's own signed movements over `transdate`. Never from
  `patient_tests.test_rate`; never from `account_detail.depositedate`. If the
  lab asks for a payments list, key it on `addeddate` and show `depositedate` as
  a separate, clearly-labelled operator-entered field.
- **"Locked"** — compute at read time with the same expression the report lock
  uses, and raise the two divergences in §6 as decisions before building:
  (a) does Infinity honour `tbl_med_mcc_lockunlock` (66 clients affected right
  now), and (b) is a zero balance locked (676 clients)? Do not let a dues screen
  and the report lock answer this differently.
- **"Never billed"** — compute as `amount_checked IS NULL` **AND** the patient
  has a sample at `sample_status >= 2`. The bare `amount_checked IS NULL` count
  is 6× larger and is mostly work in progress (§5).
- **Ageing (30/60/90 buckets)** — **not derivable.** There are no invoices, only
  a running balance; nothing in this schema says which rupee is 60 days old. If
  the lab wants ageing, it has to be walked out of the ledger movements
  explicitly, and that must be its own decision, not an unlabelled column.

### Build directives

1. **The worklist must default to a filter** — active client, traded in the last
   90 days, owing. Otherwise the screen opens on Rs 22 crore that is 84%
   permanently unlocked and 63% more than a year dead, and the first thing the
   lab learns is not to trust it.
2. **P2 is READ-ONLY.** A payment write path already exists
   (`usp_telo_record_mcc_payment`, which updates master + detail atomically
   under `UPDLOCK, HOLDLOCK`). Do not add a second one, and do not write to
   `account_master` from a read screen.
3. **No new indexes are needed.** `account_master` is 3,622 rows; the ledger is
   indexed on `(mccid, transdate)` for the per-client statement and
   `(transdate, patientid)` for the date sweep. Do not add a `SUM(testcharges)`
   query — read the running balance.
4. **Show both books when a number is disputed**: the ledger movement (which
   moved the balance) and the `account_detail` payment row (which the LIS
   screens show). They agree to 0.8%, and where they do not, the operator needs
   to see both, not an average.
5. Surface the five drifting accounts in §0 to the lab once, by name. They are
   the entire measured error in the system.

---

## 10. Open questions for the lab (P2 decision log)

1. Do the RUDARPUR / ROORKEE / SAMARPAN-class internal accounts belong in a
   dues screen at all, or are they settled outside the LIS? Rs 18.5 crore of
   the total hangs on the answer.
2. Should Infinity honour `tbl_med_mcc_lockunlock` temporary unlocks (66 live
   now)? Today it does not, and the LIS does.
3. Is a client at exactly zero balance locked or not? The LIS says locked for
   the 58% with no credit limit; Infinity says unlocked. 676 clients.
4. Is Rs 16.7 lakh of accessioned-but-never-charged work (5,518 test rows, 658
   clients) something the lab wants surfaced as a worklist, or written off?
5. Who may see the dues screen — the whole client list, or only the caller's
   mapped clients (`tbl_med_user_sales_mcc_mapping`, which covers 2,893 of
   3,622 clients and leaves 729 unmapped)?

---
*Role B, F3, 2026-08-17. All queries SELECT-only against production Noble via
an ad-hoc PowerShell SqlClient helper, deleted after use; credentials read from
the staging container environment and never written to disk. No rows written,
no DDL, no temp objects, no stored procedure executed — every procedure body
was read from `sys.sql_modules`.*
