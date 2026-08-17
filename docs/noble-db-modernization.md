# Noble DB: census, modern replica design, and bidirectional replication

*Measured live against the production `Noble` database on 2026-08-17. Every
number in this document came from a query run that day, not from memory or the
LISTEC source tree.*

This is the plan for standing up a modern database on this machine that
mirrors Noble in real time, becomes Infinity's primary store, and pushes
Infinity's writes back into Noble so Telo and LISTEC keep working unchanged.

---

## 1. What Noble actually is

### The platform

| Fact | Value | Consequence |
|---|---|---|
| Engine | SQL Server 2019 **Standard**, 15.0.2000.5 (**RTM, zero CUs**) | CDC and Change Tracking both available on Standard. RTM-with-no-patches is itself a finding — CU fixes for CDC bugs are absent. |
| Recovery model | FULL | Log-based capture is viable; log will grow once CDC holds it. |
| Snapshot isolation / RCSI | **OFF** | Readers block writers today. The replica removes this pain for Infinity reads. |
| Collation | `Latin1_General_CI_AI` | Case- and accent-insensitive comparisons. PostgreSQL equivalent needs a nondeterministic ICU collation, or `citext`/`lower()` discipline on the columns where it matters (usernames, client codes, test codes). |
| CDC / Change Tracking | both currently disabled | Nothing to inherit; we choose fresh. |

### The shape

166 tables, 1,645 columns, 185 procedures, 7 views, 7 triggers. Better bones
than the folklore suggests: **151 tables have primary keys, 135 have identity
columns, and there are 158 real foreign keys**. This is not a keyless swamp;
it is a coherent mid-2010s schema with legacy sediment around it.

Rough taxonomy of the 166:

- **Clinical core (~15 tables, ~99% of data volume)** — patients, samples,
  ordered tests, results, transactions, clinical PDFs.
- **Catalogue & pricing (~20)** — test master, profiles, parameters, normal
  ranges, rate lists per PCC type, special rates.
- **Billing (~5)** — `tbl_billing_patient_detail` + test detail + receipts
  (the tables Telo/Infinity billing writes).
- **Organisation (~15)** — centres (`unit_master`, 3,620 rows), users,
  doctors, customers, departments, business units, signatures.
- **Telo/Infinity's own tables (~30)** — `telo_*` (roles, capabilities,
  accounts, txn ledger, gold card, invoice config…) and `inf_*` (audit
  tables, auto-auth, instruments). Already modern: append-only triggers,
  proper vocabulary constraints.
- **Inventory module (~25)** — low volume, self-contained FK cluster.
- **Instrument interfaces (~15, `T_*`)** — machine result staging
  (`T_Machine_Result`, `T_Machine_Log`), mostly keyless, times stored as
  varchar. Interface plumbing, not records.
- **Dead weight (~20)** — `Tests$` (an Excel import!), `person`, `Gender`,
  `AgeType`, `Patients_Backup_Last100`, `T_Map_Master1001`, empty `tbl_online_*`,
  `temp_*` copies of the core tables. Do not migrate.

### Where the bytes are

| Table | Rows | Size | What it is |
|---|---:|---:|---|
| `tbl_med_mcc_patient_clinicaldata` | 568,840 | **21.9 GB** | Uploaded PDFs/images as `varbinary(max)` |
| `tbl_med_mcc_patient_test_result` | **68.3M** | 21.9 GB | One row per analyte per sample |
| `tbl_med_mcc_patient_test_result_attachment` | 7,023 | 5.6 GB | More embedded binaries |
| `tbl_med_mcc_patient_samples` | 5.5M | 2.3 GB | One row per SID |
| `TBL_MED_USER_ACTIVITY_LOG` | 15.9M | 1.3 GB | Legacy click log |
| `tbl_med_mcc_patient_master` | 3.4M | 0.7 GB | One row per registration (not per person) |
| `tbl_med_mcc_test_transactions` | 5.5M | 0.7 GB | Test status transitions |
| `tbl_med_mcc_patient_tests` | 5.0M | 0.5 GB | Ordered tests per registration |

Those figures are **base table data only** (heap/clustered pages). The MDF
on disk is 151 GB, and the reconciliation is worth spelling out because it
was the census's own first error — the initial scan counted only
`index_id IN (0,1)` and reported 55 GB:

| Component | Size |
|---|---:|
| Base table data (the 55 GB above) | 55 GB |
| **Nonclustered indexes** | **~68 GB** |
| Free space inside the MDF | 25 GB |
| Internal/system allocations | ~3 GB |
| **MDF file** | **151 GB** |

**57.8 GB of that index weight sits on one table** —
`tbl_med_mcc_patient_test_result`, which carries **16 indexes on 21.4 GB of
data**, a 2.7× index-to-data ratio. Reading the definitions tells the story:
five are `_dta_index_…` (Database Engine Tuning Advisor output applied
verbatim, one of them 8 keys + 6 includes at ~17 GB), the rest are named
`NonClusteredIndex-20190418…20220328` — dated accretion. **Seven of the
sixteen lead on `vailid`**, i.e. they are near-duplicates of each other.
`patient_samples` (13 indexes, 6.9 GB on 2.2 GB of data) and
`patient_master` (12 indexes) show the same pattern.

Two consequences. Every result write — the hottest write in the lab —
maintains 16 indexes; combined with RCSI being off, this is the mechanical
explanation for the write latency the LIS is known for. And the replica
sized from *data*, not from the MDF: the *relational* payload worth
modernising is ≈ 25 GB, which lands in PostgreSQL with roughly half a dozen
deliberately chosen indexes per hot table instead of sixteen accumulated
ones. The 150 GB file does not predict a 150 GB replica.

### Which indexes are actually used (measured, after the VIEW SERVER STATE grant)

**Calibration first: the instance restarted at 01:26 UTC and these counters
were read 8.2 hours later**, so this is one working day's morning-to-mid-
afternoon traffic. That is ample to identify what is *hot*; it is NOT enough
to declare an index dead, because weekly and month-end work has not run. Any
pruning of Noble itself should re-read these after a full month.

**`tbl_med_mcc_patient_test_result`** — in 8.2 hours, seven indexes totalling
**≈15.7 GB served essentially no reads** while paying full write cost:

| Index | Size | Reads | Writes |
|---|---:|---:|---:|
| `NonClusteredIndex-20190418-133420` | 4.45 GB | **0** | 59,385 |
| `index_result_vailid_patientid` | 3.61 GB | **0** | 1,958 |
| `NonClusteredIndex-20220108-153032` | 1.99 GB | **0** | 79,232 |
| `NonClusteredIndex-20201231-214832` | 1.70 GB | 1 scan | 62,982 |
| `NonClusteredIndex-20191102-143530` | 1.70 GB | 76 | 59,385 |
| `NonClusteredIndex-20220328-212349` | 1.29 GB | **0** | 2,825 |
| `NonClusteredIndex-20201231-221816` | 0.94 GB | **0** | 59,385 |

The genuinely hot paths are few and they agree with each other: the PK
(453k seeks + 206k lookups), and four indexes leading on **`vailid`** —
`_dta…K3_K19` (157k), `IX_patient_test_result_vailid` (156k),
`_dta…K3_K4_K1` (39k), `IX_result_vailid` (35k). *Four near-duplicate
indexes are splitting the same access pattern.* In the replica that is
**one** index: `result(sample_id)`, plus `result(sample_id, test_id)` if
measurement justifies it.

One unexplained reading, recorded rather than rationalised: the 16.86 GB
`_dta…K7_K2_K1_K3_K2320_K4_K21_K6…` shows 8,936 seeks but only **1** write,
where its siblings on the same table show ~59,000. It is not disabled and
not filtered (checked). Something about how it is maintained differs and I
cannot account for it from here; it does not change the conclusion, since
it is demonstrably read.

**`tbl_med_mcc_patient_samples` — the structural finding.** The clustered
index is **`_dta_index_…_c_…__K7`, i.e. clustered on `sample_status`** — a
DTA artifact on a *mutable, low-cardinality* column (10 distinct values,
non-unique). The real PK `(id, vailid)` is merely nonclustered.

This is the single worst thing in the schema, and it is expensive in three
compounding ways:

1. A sample's life is a sequence of status transitions (registered →
   received → in progress → authorised → printed). Because the row's
   physical position is *keyed on status*, *every transition physically
   relocates the row* in a 2.2 GB clustered index. Five moves per sample,
   5.5M samples.
2. The clustered key is non-unique, so SQL Server appends a hidden 4-byte
   uniquifier to every row.
3. Every one of the 12 nonclustered indexes carries the clustering key as
   its row locator, so all of them embed `sample_status` — making each
   wider *and* forcing each to be updated on every status change.

It also explains the 491,988 key lookups counted against that clustered
index in 8.2 hours.

**In the replica**: `sample` clusters on its own identity, `sid` gets a
unique index (replacing `trigger_PreventDuplicate`), and status is a plain
indexed column — ideally a partial index on the few open statuses, since
worklist queries only ever ask for those. Four samples indexes also showed
zero reads, including one named — literally — **`<Name of Missing Index,
sysname,>`**: somebody pasted a tuning-advisor suggestion into production
without replacing the placeholder, and it has been costing 45,928 writes a
day since, for no reads.

**`tbl_med_mcc_patient_master`**: PK dominates (766k seeks); five indexes
totalling 0.49 GB served zero reads. Telo's own
`IX_telo_patient_master_mobile_number` is used (188 seeks) — worth keeping
as a real index on the person/registration split.

### The pathologies the new schema must fix

1. **No people, only registrations.** `patient_master` is 3.4M *visits*;
   the same human appears once per registration with no linking identity.
2. **Money is `int`** — whole rupees, 35 columns. Fine for this business
   today; the replica keeps integer paise-free semantics but as `numeric`.
3. **Sex/age as magic numbers** — `gender 1/2`, `age_type 1/2/3` with the
   decode ring living in application code, replicated in every consumer.
4. **Duplicated fact columns** — patient name/age/sex copied into the billing
   header; sample date on both patient and sample; denormalised by habit,
   not by design.
5. **Uniqueness by trigger** — SID uniqueness is enforced by
   `trigger_PreventDuplicate` (AFTER INSERT + `ROLLBACK`), not a unique
   constraint — and the samples PK is the odd composite `(id, vailid)`,
   an identity plus the natural key fused together. Bill numbers have no constraint at all (see
   `db/scripts/billnumber_*.sql` in the Telo repo).
6. **App-maintained timestamps are unreliable**: **41.7M of 68.3M result rows
   have NULL `updateddate`**. Half the receipt/detail tables have no
   modified-stamp column at all. *This single fact rules out timestamp
   polling as a sync mechanism and mandates engine-level change capture.*
7. **Blobs in the hot tables** — 28 GB of PDFs inline in transactional
   tables, backed up and log-shipped with every clinical write.
8. **The `updatedby`/`addedby` varchar(50) columns** double as our origin
   channel (`telo:<uid>`, `inf:<uid>`, `inst:<code>`) — a pathology that
   became load-bearing. The new schema carries origin as a real column.

---

## 2. The target: PostgreSQL 17

Chosen over "newer SQL Server" because the goals are longevity, performance,
and freedom from per-core licensing on a growing platform:

- Logical replication, `NOTIFY`, and partitioning are first-class — the
  Infinity worklist/dashboard patterns map directly.
- `jsonb` for the places Noble abuses text (instrument payloads, config).
- No licensing cliff when this outgrows one machine.
- Runs in the same Docker estate the whole platform already deploys to.

### Design rules for the new schema (`stellar` database)

- **`bigint identity` PKs everywhere**, `text` not `varchar(n)`, `timestamptz`
  in UTC (Noble's naive datetimes are IST wall-clock; the boundary converts —
  the same `NobleTime.ToIst` rule Infinity's API already applies).
- **Every table carries** `created_at`, `updated_at` (trigger-maintained, so
  they can never rot the way `updateddate` did), `origin text` (`telo:…`,
  `inf:…`, `listec`, `sync`), and `noble_id` — the legacy PK, uniquely
  indexed. `noble_id` is what makes bidirectional sync sane: every row knows
  its counterpart.
- **Real enums for the magic numbers** (`sex`, `age_unit`, `sample_status`)
  with the decode done once, at the sync boundary.
- **`person` table introduced** above registrations: match on
  (normalised name, sex, DOB-or-age@date, mobile) at sync time, curated
  merges later. Registrations keep working exactly as Noble's do; identity
  becomes a queryable layer instead of a rumour.
- **Binaries out of row**: `document` table with content hash + filesystem/
  object storage; the clinical tables reference documents.
- **Partitioning**: `result` and `sample_event` partitioned by month;
  Noble's 68M-row result table becomes prunable, and old partitions
  compress.
- **Constraints where Noble had triggers or nothing**: unique `(sid)`;
  unique `(mcc_id, bill_number)`; FKs with `on delete restrict`.
- The `telo_*`/`inf_*` tables (roles, capabilities, audit) are already
  well-designed; they port nearly 1:1.

Core entity sketch (details in the DDL when we build it):

```
org:        mcc(unit), business_unit, department, lab_user, doctor, customer, signature
catalogue:  test, profile, parameter, normal_range, rate_type, rate, special_rate
people:     person, registration (← patient_master), clinical_note, document
lab:        sample (← samples, unique sid), ordered_test, result (partitioned),
            sample_event (← test_transactions), attachment→document
money:      bill, bill_line, receipt, account_entry, gold_card, invoice_config
platform:   role, capability, session_version, audit_* (append-only, as today)
```

---

## 3. Replication: the honest design

The requirement is two flows, and they are **not symmetric**:

```
   Noble (SQL Server) ──── engine CDC ────▶  stellar (PostgreSQL)
      ▲                                            │
      └──── the SAME stored procedures ◀── outbox ─┘
             (usp_telo_*, usp_inf_*)
```

### Inbound: Noble → stellar (continuous, engine-level)

**SQL Server Change Tracking** on the hot tables, read by a **.NET sync
service** (`stellar-sync`, same stack as the API, same Docker estate) that
polls `CHANGETABLE(CHANGES …)` on a short interval, refetches the changed
rows by PK, transforms them into the modern schema (decode enums, split
blobs, stamp `noble_id`), and upserts into Postgres. Latency: seconds.

The mechanism was chosen by **measured permissions**, not preference. The
platform login (`nobleone`) is **db_owner on Noble but not sysadmin**
(verified via `IS_SRVROLEMEMBER`/`HAS_PERMS_BY_NAME`, 2026-08-17):

| Mechanism | Needs | nobleone has it? |
|---|---|---|
| CDC (`sys.sp_cdc_enable_db`) | **sysadmin** + SQL Agent running | ✗ (and Agent status is itself unreadable — server-scoped) |
| Change Tracking | ALTER on DB + ALTER on each table | ✓ verified for DB, results, samples |
| Timestamp polling | reliable `updateddate` | ✗ — 41.7M of 68.3M result rows are NULL |
| Triggers on Noble tables | adding our failure modes to LISTEC's writes | forbidden by "don't break the LIS" |

CT's trade-offs against CDC, all acceptable here: it records *that* a PK
changed and its version, not the old values — the sync refetches current
rows, so intermediate states within one poll interval collapse (fine for a
replica; the audit trail lives in `inf_result_audit`, not the sync).
It needs no SQL Agent, which removes the one prerequisite nobody can
currently check. Retention window (say 7 days) bounds how long the sync may
be down before a re-snapshot; auto-cleanup is built in. Composite PKs
(samples is `(id, vailid)`) are handled natively. If CDC's full change
history is ever wanted, obtaining sysadmin once upgrades the pipeline
without touching the target schema.

Enabling CT also wants `ALLOW_SNAPSHOT_ISOLATION` on (db_owner can), which
gives the initial load a consistent low-water mark: record
`CHANGE_TRACKING_CURRENT_VERSION()`, snapshot the 25 GB table-by-table
under snapshot isolation, then apply changes since that version — the
standard no-downtime bootstrap. The 28 GB of blobs stream out separately
into the document store, hash-deduplicated.

### Outbound: stellar → Noble (through the procedures, not row copying)

This is where naive designs corrupt data, so this design refuses generic
row-level writeback. **Noble remains the system of record for every shared
invariant while Telo and LISTEC exist.** Three rules:

1. **Allocation stays in Noble.** Bill numbers (`usp_telo_next_bill_number`
   under its app-lock), SIDs (dedup trigger), receipt ids — any number two
   systems could race for is allocated by Noble, never minted in Postgres.
2. **Writeback is procedure calls, not table writes.** When Infinity acts on
   a shared entity (place order, receipt, cancel, void, patient edit), the
   write goes to the **same `usp_telo_*`/`usp_inf_*` procedures it calls
   today** — synchronously, inside the user's request. The transaction
   either lands in Noble with all its guards (origin markers, scope checks,
   locks) or the user sees the failure immediately. CDC then echoes it back
   into Postgres within seconds, and the `origin` column tells the sync
   service *this came from us* — echo suppression is already built into the
   platform's data.
3. **Infinity-only entities never leave.** Auto-auth config, Infinity audit,
   attachments-metadata, person identity — rows Telo/LISTEC never read —
   live only in Postgres. Over time the set of "shared" entities shrinks;
   that is what "absorbing Telo" means at the data layer.

So "all changes replicated to the original in real time" is satisfied — but
by write-through, not by a second replication pipeline. A generic
PG→MSSQL row merger would bypass the app-locks and origin guards months of
work built, and two masters allocating bill numbers is precisely the
collision machine we just wrote `billnumber_unique_index.sql` to prevent.

The practical consequence for Infinity's code: repositories gain a
**read side pointed at Postgres** (fast, RCSI-free, modern) while the write
side keeps calling Noble procedures until a given entity is Infinity-owned.
This is the strangler pattern applied to a database.

### Conflict story

There isn't one, by construction: every row has exactly one writer. Shared
rows are written only via Noble (whoever calls the procedure); Infinity-only
rows are written only in Postgres. The `origin` column + `noble_id` mapping
make the sync idempotent and re-runnable from any point.

---

## 4. Phasing

1. ~~Enable Change Tracking on Noble~~ **DONE 2026-08-17.**
   `api/db/sync/01_enable_change_tracking.sql` applied to production: 18
   tables tracked, database-level CT on with 7-day retention and auto
   cleanup, `ALLOW_SNAPSHOT_ISOLATION` ON. Verified capturing live traffic
   immediately — version counter moved 0 → 86 within a minute, with 104
   result changes, 16 sample changes and 3 patient-master changes from real
   LISTEC/Telo activity; `CHANGETABLE` returns the composite `(id, vailid)`
   sample key correctly. CT internal tables at 0.4 MB, database ONLINE and
   MULTI_USER, writes landing normally.

   **Post-grant follow-ups, all now measured and clear:** the tempdb version
   store that `ALLOW_SNAPSHOT_ISOLATION` feeds sits at **1.1 MB** — noise,
   as expected with no long-running snapshot readers. **SQL Server Agent is
   Running/Automatic**, so CDC would in fact have been viable had the login
   been sysadmin; Change Tracking remains the right choice and is already
   deployed. Change Tracking's own internal tables were at 0.4 MB shortly
   after enablement. Nothing here blocks phase 3.
2. **Stand up PostgreSQL 17 + `stellar` schema** in Docker on this machine;
   DDL under `db/pg/` in the Infinity repo, migration-tracked.
3. **Build `stellar-sync`** (.NET worker): snapshot + CDC tail for those
   tables; prove row-count and checksum parity; run for a week alongside.
4. **Point Infinity's read repositories at Postgres** one screen at a time
   (worksheet first — it's the heaviest reader), behind a config flag,
   diffing responses in staging.
5. **Extend CDC to the remaining hot tables**; blobs migrate to the document
   store.
6. **Flip entities to Infinity-owned** as Telo absorbs into Infinity, ending
   with Noble as a read-only archive behind the sync.

Rollback at every phase is "point the flag back at Noble" — the write path
never left it.

---

## 5. Open questions for Jaskirat

- **Postgres blessing**: the design assumes PostgreSQL is acceptable as the
  "much more modern" target. (MSSQL 2022 in a container would also work but
  keeps licensing and changes little.)
- **Where do the 28 GB of PDFs land** — local disk on this machine, or a
  MinIO/S3 bucket in the Docker estate?
- ~~SQL Agent / CDC permissions~~ **Resolved 2026-08-17**: `nobleone` is
  db_owner, not sysadmin, so CDC is out of reach and Agent status is
  unreadable — but Change Tracking needs neither, and `nobleone`'s ALTER
  rights for it are verified. The design above reflects this.
- **Index usage stats stay unreadable** with any current login:
  `sys.dm_db_index_usage_stats` is server-scoped and needs VIEW SERVER
  STATE despite its name. The seven-duplicate-index finding rests on
  definitions, not observed traffic; one `GRANT VIEW SERVER STATE TO
  nobleone` from an admin session would let us measure which of the 16
  result-table indexes the engine actually uses.
- **This machine's role**: dev replica first, or is it intended to become
  the production Postgres host? Affects backup/HA design, not the schema.
