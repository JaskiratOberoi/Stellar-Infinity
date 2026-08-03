# The LIS Worksheet — how it actually works, and what Infinity should do instead

Source analysed: `E:\Listec Genomics` (LISTEC Genomics LIS — ASP.NET WebForms .NET 4.8,
LINQ-to-SQL, SQL Server database `Noble`). This is the live production system Infinity
already reads from.

This document has two halves:

- **Part I — the legacy worksheet as-built.** Result entry, authorisation, audit trail,
  and instrument interfacing, with file/line references so every claim is checkable.
- **Part II — what Infinity should build.** The same workflow, with the defects fixed and
  a real audit trail, expressed against Infinity's existing capability model.

---

# Part I — The legacy worksheet as-built

## 1. The two-screen shape

The worksheet is two grids on one page, `MedCis.UI/Worksheet/SampleWorksheet.aspx`
(and a near-identical twin `Worksheet.aspx`):

1. **The sample list** (`gvSample`) — one row per vial. Filters at the top (date range,
   status, client code, SID, department, business unit) feed a single stored procedure,
   `dbo.usp_worksheet_sample02072020`, which returns 33 columns of which the grid binds 8.
   This is already documented exhaustively in the LIS repo at
   `docs/worksheet-data-fetch.md`, and Infinity's `ReportsRepository` already consumes the
   newer JSON variant `usp_listec_worksheet_report_json`.

2. **The result entry grid** (`gvWorksheet`) — opens in a modal when the technologist
   clicks a SID. One row per analyte.

Sample statuses (`tbl_med_mcc_patient_samples_status_master`, verified live):

| Code | Label | Set by |
|---|---|---|
| 1 | Sample Sent | PCC work-order pages |
| 2 | Sample Registered | Accession / Inward |
| 3 | Rejected | Accession, `RejectSample` |
| 4 | Partially Tested | result save |
| 5 | Tested | result save |
| 6 | Partially Authorized | result save |
| 7 | Authorized | result save |
| 8 | Partially Printed | report print |
| 9 | Printed | report print |
| 10 | Pending | sample comment (see defect 1) |

## 2. Where result rows come from

Result rows are **not** created at ordering time. They are materialised lazily, as a side
effect of a method named like a getter: `WorksheetClass.GetTestsBySampleId(sid, busId)`
(`MedCis.Business/Pcc/WorksheetClass.cs:913-996`) inserts the skeleton rows on first view or
accession, inside a `TransactionScope`. It expands the ordered tests into a flat row set:

- `testtype = 'Test'` — a standalone analyte (`paramid` NULL)
- `testtype = 'Param'` — one parameter inside a multi-parameter test
- `testtype = 'Head'` — a display heading; seeded `auth = true` so it never gates counts
- `testtype = 'Profile'` — a profile grouping row; likewise pre-authorised

Two snapshot columns are frozen at creation and never recomputed:
`testnormal_range` (from the `ReportType = 'Report'` range row) and `testunit`. That is
correct instinct — the range printed on the report must be the range in force when the
result was produced — but nothing else in the row is versioned.

## 3. The result entry grid, control by control

`SampleWorksheet.aspx:380-540`:

| Column | Control | Bound to |
|---|---|---|
| TestName | `lblTestname` | `testname` |
| **AB** (abnormal) | `chkAbnormal` | **hard-coded `Checked="false"`** — see defect 5 |
| **Value** | `txtValue` (multiline, 1 row, width 90) | `value` |
| Desc | `lbDesc` → modal with `txtMulti` (1000×400 textarea) | `value` — the narrative editor |
| Normal Range | hover panel `popNormalRanges` | `testnormal_range` (the snapshot) |
| Unit | `lblTestunit` | `testunit` |
| **Auth** | `chkAuth`, plus a header `chkAuthAll` with `AutoPostBack` | `auth` |
| Graph | `imgAtt` → attachment modal | gated on the `attachment` bit |
| Comments | hover panel → `txtComments` | `comments` |

Coded (non-numeric) results are handled by swapping `txtValue` for a `ddlValue` dropdown,
whose options come from `tbl_med_mcc_test_sample_data`. The option list is carried on the
result row in a column called **`mobile_number` (varchar 12)** — a repurposed field that
silently truncates any option set longer than 12 characters (`WorksheetClass.cs:1047, 1078,
1192, 1218`).

Above the grid sit a doctor/signatory dropdown (`ddlDoctor`), a sample comments box, a
clinical history box, and Save.

## 4. Reference ranges and the abnormal/auth decision

`WorksheetClass.GetTestAuthenticate(id, testValue)` (`WorksheetClass.cs:1777-1872`) is the
whole of the clinical decision logic:

```
if (!decimal.TryParse(testValue)) return null;        // non-numeric ⇒ no opinion
ranges = tbl_med_test_normalranges                     // or _param_normalranges for 'Param'
         where agetype = patient.age_type
           and testid  = row.testid
           and gender  = patient.gender
           and ReportType = 'Auth'                     // note: 'Auth' ranges, not 'Report'
foreach range:
    if patient.age between range.fage and range.tage:
        return value between range.fnormal and range.tnormal    // true = in range
```

Two range sets exist per test, distinguished by `ReportType`: `'Report'` (the human-readable
string printed on the report, snapshotted into `testnormal_range`) and `'Auth'` (numeric
`fnormal`/`tnormal` bounds used for this check). Ranges are keyed on **age type, age band,
and gender** — a real, if minimal, reference-range model.

The return value is tri-state and is used for two different things:

- `AutoAuthAndAbnormal()` (the "Check" button, `SampleWorksheet.aspx.cs:1400-1441`) ticks
  `chkAuth` for every result that comes back `true`.
- `txtValue_TextChanged1` does the same per cell as you tab out.

**So an in-range value auto-authorises itself.** The technologist presses Check, then Save,
and every normal result is signed out without anyone explicitly agreeing to it. Out-of-range
and non-numeric results are left unticked and require a human.

There is also derived-value logic — an "AC" (auto-calc) link that computes CBC absolute
counts from differential percentages — but it keys off **hard-coded test codes and English
test-name strings** (`SampleWorksheet.aspx.cs:1064-1395`). Renaming "Neutrophils %" silently
disables it. A `DC != 100` sanity check exists but does not block Save.

## 5. What Save writes

`btnSave_Click` walks the grid rows, sets `value` / `auth` / `abnormal` / `comments` on each
tracked entity, then calls `WorksheetClass.UpdateSampleResult(list, user, authBy)`
(`WorksheetClass.cs:1717-1776`), which submits and then recomputes the sample status:

```
vailCount  = rows for this SID where testtype not in ('Head','Profile')
valueCount = those with a non-empty value
authCount  = those with auth = 1

if sample_status != 9:                       // Printed is frozen
    log "Results Entered"
    valueCount == 0                                   -> 2   Registered
    0 < valueCount < vailCount and authCount == 0      -> 4   Partially Tested
    valueCount == vailCount and authCount == 0         -> 5   Tested
    valueCount > 0 and authCount > 0 and partial       -> 6   Partially Authorized
    all values and all auth (or authCount > 0)         -> 7   Authorized
                                                             + authorised_by = user
                                                             + signature_id  = ddlDoctor
                                                             + log "Authorized"
    if authCount partial: -> 6                         // post-hoc correction
```

Side effects that fire on reaching status 7: a WhatsApp document send with a generated QR
code, an SMS to the collection centre, and (for one hard-coded client code, `CPL-TS-262`) a
CallHealth HIES result push. The PDF snapshot call `save_binary_report.Save_Report` is
commented out at every call site.

The whole handler is wrapped in `try { … } catch (Exception ex) { lblMsg.Text = ex.Message; }`
with **no transaction**, and the raw exception text is rendered to the user.

## 6. Authentication and authorisation

### Login

`LoginClass.UserAuth` (`MedCis.Business/LoginClass.cs:18`) is a single LINQ query:

```csharp
dt.tbl_med_user_masters.Where(c => c.Username == user && c.password == pwd && c.IsActive == true)
```

**Passwords are stored in cleartext** in `tbl_med_user_master.password` (`nvarchar(50)`).
They are echoed back into the admin edit form (`MccUser_Master.aspx.cs:242`) and emailed to
new users in the body of the welcome message (`:162-163`). There is **no lockout, no
throttling, no CAPTCHA, no password policy, and no expiry** — the expiry procedure exists but
`UserMasterClass.GetExpiryDays()` is stubbed to `return false` and its only caller is
commented out.

On success: `FormsAuthentication.SetAuthCookie(user, false)` and
`Session["loginUser"] = <the full user entity>`. Forms auth timeout is 120 minutes; session
timeout is 30. There are **zero null guards on `Session["loginUser"]` across 566 uses**, and
`customErrors` is `Off` — so an idle user gets a full stack trace instead of a re-login.

`Site2.Master.cs:14` declares `static int usertypeId` — a static field on the master page,
shared across all concurrent requests. Under load, one user's menu can be built from
another's role.

### Page authorisation

`Utilities.CheckUserPage(pageId, usertypeId)` (`Utilities.cs:1221-1232`) tests only that a
row exists in `tbl_med_security_master` for that role and menu id. The stored `_read` /
`write` / `_delete` bits are **never read anywhere in the codebase** — anyone who can open a
page can save and delete on it. Most call sites sit inside `if (!Page.IsPostBack)`, so
**every Save button click is unchecked**. Around 28 pages have no check at all and ~17 have
theirs commented out, including `Worksheet/EditWorkOrder.aspx.cs:27`.

### Worksheet-specific permissions

`tbl_med_mcc_user_security_auth`, keyed by user type, is the closest thing to a capability
model. The worksheet consults four flags via `GetEditPatientInfo(user, type)`:

| Flag | Controls |
|---|---|
| `Auth` | whether `chkAuth` / `chkAuthAll` are enabled |
| `Result_Entry` | whether `txtValue` is enabled **when the cell is empty** |
| `Result_Edit` | whether `txtValue` is enabled **when it already has a value** |
| `Reject_Sample` | the reject link (hard-coded invisible in `SampleWorksheet`) |

The `Result_Entry` / `Result_Edit` split is genuinely good design — overwriting an existing
result is a different act from entering a new one. But **all four are UI-enable-only**.
`btnSave_Click` performs no server-side re-check. Worse: a disabled ASP.NET `CheckBox` posts
as *unchecked*, so a user without the `Auth` right who saves the page silently **clears every
existing authorisation on it**.

`GetEditPatientInfo` is also called four times *per grid row* inside `RowDataBound` — an N+1
storm that `Worksheet.aspx.cs` fixes by hoisting and `SampleWorksheet.aspx.cs` does not.

### Department scoping — implemented, never wired up

`tbl_med_user_department_mapping` maps users to departments, and
`Utilities.FillComboDepartmentMapping` (`Utilities.cs:485-514`) correctly restricts the
department dropdown to a user's mappings. It has **zero call sites**. The worksheet binds
*all* departments and merely pre-selects the user's first mapping, leaving the dropdown
enabled — so a haematology technologist can select biochemistry and enter results there.

### Re-editing an authorised report

`CheckSampleEnable` (`WorksheetClass.cs:2258-2283`) returns false for status 7 or 9, which
disables the grid and the Save button and reveals an "Edit" link. That link opens a modal
with a free-text reason box:

```csharp
protected void btnReason_Click(...) {                  // SampleWorksheet.aspx.cs:906-924
    if (txtReason.Text != string.Empty) {
        gvWorksheet.Enabled = true; btnSave.Enabled = true;
        utl.GetUserLog(user, pid, sid, txtReason.Text, DateTime.Now, "", "");
    }
}
```

**Any user who can open the worksheet can re-open an authorised report by typing any
non-empty string.** No role check, no supervisor approval, no minimum length, no amendment
record. The original value is overwritten in place and is unrecoverable. The only trace is
one log row containing the reason — truncated to 50 characters by the stored procedure's
parameter.

## 7. The audit trail

One table, `TBL_MED_USER_ACTIVITY_LOG`:

| Column | Type |
|---|---|
| `ID` | int identity |
| `USERID` | int NULL |
| `PID` | nvarchar(50) |
| `SAMPLEID` | nvarchar(50) |
| `FUNCTION_PERFORMED` | nvarchar(100) |
| `FUNCTION_DATE` | datetime |
| `IPADDRESS` | nvarchar(20) |
| `OTEHR_INFO` | nvarchar(100) *(sic)* |

Written through `dbo.sp_user_activity_log`, whose `@FUNCTION_PERFORMED` parameter is
`nvarchar(50)` while the column is `nvarchar(100)` — so anything longer is truncated on the
way in.

**What is logged in the worksheet path:** `"Results Entered"` on every save, `"Authorized"`
on reaching status 7, the free-text amendment reason, `"Sample Registered"`,
`"Sample Rejected"`, `"Patient Tests Changed"`, `"Printed <from>-<to>"`. Login events —
`"LogIn"`, `"LogInFailed"`, `"LogOut"`, `"Changed Password"`, `"UnAuthorized Access <page>"` —
plus around 30 master-data strings.

**What is wrong with it, in order of severity:**

1. **No before/after values.** A changed result is unrecoverable. `addedby` and `updatedby`
   on `tbl_med_mcc_patient_test_result` exist and are **never written** — attribution exists
   only at sample level (`authorised_by`, `signature_id`).
2. **The event is a free-text string, not a typed record.** There is no entity id, no field
   name, no structure. Auditing "who changed this potassium result" is impossible.
3. **`IPADDRESS` is always empty.** `UserMasterClass.GetUserLog` puts the IP in
   `OTHER_INFO` instead; every `Utilities.GetUserLog` call site passes `""`. The Audit Trail
   viewer has a column headed "IP" that binds `OTEHR_INFO`.
4. **Failed logins record the *server's* MAC address**, not the client's IP
   (`login.aspx.cs:76-77` calls `NetworkInterface.GetAllNetworkInterfaces()` server-side).
   Failures for unknown usernames get `USERID = NULL` and are then **invisible in the
   viewer**, because `AuditTrailClass` inner-joins to the user table.
5. **Four different wrappers write the log, two of them into the wrong columns.**
   `logBookClass.AddUserLog` puts the action string in `PID` and leaves
   `FUNCTION_PERFORMED` empty; `classCustomerRequestForm.AddUserLog` puts it in `SAMPLEID`.
   `UserActivity_LogClass.SaveActivity` builds the row and **never calls `SubmitChanges()`**.
6. **The log is an ordinary writable table** — no append-only constraint, no tamper
   evidence, no export from the viewer, and reading it is not itself audited.

## 8. Instrument interfacing — it does not exist

This is the clearest finding of the whole review. A full-tree search for `ASTM`, `HL7`,
`LIS2`, `SerialPort`, `System.IO.Ports`, `MLLP`, `TcpListener`, `FileSystemWatcher`,
`FtpWebRequest`, `ServiceBase`, `Quartz`, "analyzer", "instrument", "middleware",
"bidirectional" returns **zero genuine hits**. (Every apparent `ASTM` match is the substring
inside `l-astm-odified_date`.) There is no socket listener, no serial port, no file-drop
watcher, no scheduled service, no inbound result API. `Global.asax` starts no background
worker. No `tbl_*machine*` / `*device*` / `*instrument*` / `*queue*` table exists.

The only trace of intent is a **`machine_name varchar(20)` column** on the result table that
is read in exactly one tooltip (`WorksheetClass.cs:2524`) and **written nowhere**.

The single automated path that writes result values is an Excel upload,
`Worksheet/Extract.aspx` → `Button3_Click` (`Extract.aspx.cs:29-150`). It expects columns
`VAILID`, `TESTCODE`, `RESULT`, `CTVALUE`, reads them via `Microsoft.ACE.OLEDB.12.0`, and
then:

```csharp
objResult = results.Where(ee => ee.paramid == 3736 && ee.vailid == item.VAILID && ee.auth != true)
objResult.value = item.VALUE;
objResult.auth  = true;                    // ← no range check, no human review
sample.sample_status = (POSITIVE ? 5 : 7); // ← auto-releases
// then generates a QR code and WhatsApps the report to the patient
```

`TESTCODE` is parsed and **never used** — matching is purely on the hard-coded
`paramid == 3736`, a single COVID RT-PCR parameter. So this importer works for exactly one
analyte, auto-authorises without review, and auto-delivers to the patient.

The frozen `Payment\` clone contains the **earlier, generic version** of this page
(`Payment/Worksheet/Extract.aspx.cs:59-146`): a wide-format importer where *column headers
are test codes*, matching on `testcode` for `Test` rows and parameter code for `Param` rows,
and — importantly — running each value through `GetTestAuthenticate` to derive `auth` and
`abnormal` from the reference ranges rather than blindly setting true. **That wide format,
one row per vial and one column per analyte, is exactly the shape analyser middleware
exports.** It is the closest this codebase ever came to an instrument interface, and the
active project narrowed it down to one hard-coded parameter.

**Conclusion: whatever analyser integration the lab performs today happens outside this
repository** — most likely a person exporting CSV from middleware, reshaping it, and either
uploading it here or writing to SQL directly. Infinity is not replacing an instrument
interface; it is building the first one.

All other integrations are outbound only: CallHealth HIES (result push and ACK), WhatsApp,
SMS, SMTP, Razorpay, CCAvenue. The `.asmx` services (`dasweb`, `daswebs`, `autotext`) are
read-only dashboard feeds; `dasweb.asmx` is broken (its `Class=` directive names a class that
does not exist) and unreferenced. The `.ashx` handlers stream blobs outward — and two of
them, `graph.ashx` (result attachments) and `Doctor_Sign.ashx` (doctor signature images),
take an enumerable `?id=N` with **no authentication and no ownership check**.

## 9. Absent entirely

No repeat/rerun flag. No delta checking against a patient's prior result. No result
versioning — a re-edit overwrites in place. No critical-value detection: `CriticalClass.cs`
is almost entirely commented out and its one live method now returns reagent-reconstitution
reminders instead, leaving `tbl_med_mcc_critical_value_info` orphaned. No comment templates.
No QC module. No outsourcing state machine — `Outsourcing.aspx` is a filtered worklist keyed
on `tbl_med_test_master.cap_code == "1"`, with no vendor, send-out date, or receipt.

## 10. The defects that matter most for a rewrite

| # | Defect | Where |
|---|---|---|
| 1 | `UpdateComments` sets `sample_status = 10` whenever a sample comment is non-empty, and is called unconditionally right after the status computation — **silently discarding the 4/5/6/7 transition just calculated** | `WorksheetClass.cs:1957-1958`, called from `SampleWorksheet.aspx.cs:503` |
| 2 | Any user can re-open an authorised report with any non-empty reason string; no role check, no amendment record, value overwritten in place | `SampleWorksheet.aspx.cs:906-924` |
| 3 | `graph.ashx` and `Doctor_Sign.ashx` serve patient attachments and signature images unauthenticated over an enumerable id | `graph.ashx.cs:15-41`, `Doctor_Sign.ashx.cs:14-37` |
| 4 | The `Auth` permission is enforced only by disabling a checkbox; saving as a non-authoriser **clears** existing authorisations | `SampleWorksheet.aspx.cs:488` vs `:705-706` |
| 5 | `chkAbnormal` is hard-coded `Checked="false"` instead of bound to `Eval("abnormal")` — the stored flag never round-trips and a manual abnormal marking is lost on reopen | `SampleWorksheet.aspx:403` |
| 6 | Status arithmetic is order-dependent; `|| authCount > 0` can set 7 on a partly-filled panel before a later line corrects it to 6. Status 3 (Rejected) is never guarded | `WorksheetClass.cs:1750-1772` |
| 7 | No audit of result values at all (see §7) | — |
| 8 | Save has no transaction and swallows exceptions into a label; a failure mid-way leaves the sample half-updated | `SampleWorksheet.aspx.cs:468, 569-572` |
| 9 | Auto-calc keys off hard-coded test codes and English test-name strings | `SampleWorksheet.aspx.cs:1064-1395` |
| 10 | A production connection string with credentials is hard-coded in the page | `SampleWorksheet.aspx.cs:1721` |

---

# Part II — What Infinity should build

## 11. What carries over unchanged

These are the parts of the legacy design that are actually right, and Infinity should keep
their semantics so both systems can operate on `Noble` concurrently:

- **The row shape.** `testtype` ∈ `Test | Param | Head | Profile`, with `Head`/`Profile` as
  non-counting display rows. Any status arithmetic must exclude them, exactly as the legacy
  does, or a profile can never reach Authorized.
- **Range snapshotting.** `testnormal_range` and `testunit` are frozen onto the result row at
  creation. Keep this — the range on the report must be the range in force at the time.
- **The two range sets.** `ReportType = 'Report'` for the printed string, `'Auth'` for the
  numeric bounds. Ranges keyed on age type, age band, and gender.
- **The `Result_Entry` / `Result_Edit` split.** Entering a new value and overwriting an
  existing one are different privileges. Infinity currently has one capability,
  `result:enter`, covering both.
- **The status vocabulary 1–10.** Both systems write `sample_status`; Infinity must produce
  values the legacy UI renders correctly.

## 12. Capability model — the gap

Infinity's `Auth/InfinityRoles.cs` already defines what is needed for entry and
authorisation, and already encodes the right policy: **Technician has `result:enter` but not
`result:authorize`** — the separation the legacy system never enforced server-side.

Three capabilities are missing and should be added:

| New capability | Why |
|---|---|
| `result:amend` | Overwriting an existing value is not the same as entering an empty one — this is the legacy `Result_Edit` flag, and it is the gate that should have stopped defect 2. Lab Manager and above only. |
| `result:reopen` | Re-opening an authorised (status 7) sample. Must be **strictly above** `result:authorize`, must require a structured reason, and must write an amendment record. |
| `sample:reject` | The legacy `Reject_Sample` flag, currently unreachable in the UI. |

Every one of these must be enforced **server-side in the endpoint filter**, not by disabling
a control. The `RequireCapability` filter in `Auth/CapabilityAuthorization.cs` is already the
right mechanism — it applies at the route definition so an endpoint cannot ship ungated.

Department scoping should be enforced the way `ScopeFilter` already enforces MCC scope: a
technician mapped to haematology gets a *filtered* worklist, not a full one with a
pre-selected dropdown.

## 13. The audit trail Infinity needs

This is the single biggest departure from the legacy system, and the one the user asked
about by name. The legacy log records *that* something happened; Infinity must record *what
changed*.

Proposed `dbo.inf_result_audit` — append-only, one row per field change:

| Column | Purpose |
|---|---|
| `id` | bigint identity |
| `result_id` | FK to `tbl_med_mcc_patient_test_result.id` |
| `vailid`, `patient_id` | denormalised for query without a join |
| `action` | typed: `enter` / `amend` / `authorize` / `unauthorize` / `reopen` / `reject` / `import` |
| `field` | `value` / `auth` / `abnormal` / `comments` |
| `old_value`, `new_value` | **nvarchar(max), both populated** — this is the point |
| `reason` | required for `amend` and `reopen`; nvarchar(500), not 50 |
| `actor_user_id`, `actor_username` | username denormalised so a deleted user does not orphan the trail |
| `actor_ip`, `actor_user_agent` | genuinely captured, not blank |
| `source` | `ui` / `instrument` / `import` / `api` |
| `instrument_id` | when `source = instrument` |
| `occurred_at` | `datetimeoffset` |
| `origin` | `inf:<userId>` per the existing `Origin` convention |

Constraints that make it an audit trail rather than a log table: `DENY UPDATE, DELETE` to
the application login, index on `(vailid, occurred_at)` and `(result_id, occurred_at)`,
and — because Infinity writes to a database the legacy app also owns — the `origin` stamp so
Infinity's rows are always distinguishable.

Alongside it, **start writing the columns the legacy system left dead**: `addedby`,
`addeddate`, `updatedby`, `updateddate` on the result row itself. They cost nothing and they
make the current state self-describing.

Authentication events (`login`, `login_failed`, `logout`, `password_change`, `token_revoked`)
belong in a sibling `inf_auth_audit` with the *client* IP taken from the proxy chain with a
validated forwarded-for allow-list — not the unvalidated `HTTP_X_FORWARDED_FOR` read the
legacy uses, and not the server's own MAC address.

## 14. Result entry — the write path

A single transactional endpoint, `POST /api/samples/{sid}/results`, taking a batch of row
edits. In outline:

1. `RequireCapability(result:enter)`; MCC scope check on the SID; department scope check.
2. Load the current rows **inside the transaction**.
3. For each incoming edit, decide the required capability from the *current* state:
   empty → `result:enter`; non-empty and changing → `result:amend` (with a reason).
   Reject the whole batch on the first violation — no partial application.
4. Re-derive `abnormal` from the `'Auth'` ranges server-side. **Never trust a client-sent
   abnormal flag**, and never let it silently default to false the way `chkAbnormal` does.
5. Write the audit rows in the same transaction as the value changes.
6. Recompute `sample_status` with the corrected arithmetic — guard status 3 and 9, exclude
   `Head`/`Profile`, and do not let a partial authorisation reach 7.
7. **Do not touch `sample_status` when saving comments** (defect 1).

Authorisation is a separate endpoint, `POST /api/samples/{sid}/authorize`, gated on
`result:authorize`, which records the signatory. Auto-authorisation of in-range values should
be **opt-in per test**, not the implicit default the legacy "Check" button created — and
when it happens, the audit row's `source` must say so.

## 15. Instrument interfacing — building it for the first time

Since nothing exists, this is greenfield. The shape that fits both the domain and the
existing schema:

**Ingestion endpoint.** `POST /api/instruments/{instrumentId}/results`, authenticated with a
per-instrument API key or client certificate — not a user JWT. Accepts a normalised payload
of `{ sid, testCode, value, unit, flags, measuredAt, sequenceNo }`.

**A driver/middleware boundary.** Do not put ASTM or HL7 framing inside the API. Analysers
speak ASTM E1381/E1394 or HL7 v2 over serial or TCP/MLLP; that belongs in a small separate
worker per instrument that translates to the JSON above. This keeps the API testable and
means adding an analyser is a driver, not an API change.

**A staging table, not a direct write.** `inf_instrument_result_inbox` holding the raw
message, parse status, and match status. Results land there first, then a matcher resolves
`(sid, testCode)` to a `tbl_med_mcc_patient_test_result` row. Unmatched messages stay
visible and replayable rather than being lost in a `catch` block. This is what the Excel
importer's silent partial-failure mode should have been.

**Populate `machine_name`** — the column has been sitting there unused since the schema was
written, and it is exactly where the analyser id belongs.

**Never auto-authorise on ingestion.** Instrument results arrive as `value` set, `auth = 0`,
status → 4 or 5, awaiting a human. The COVID importer's `auth = true` with an automatic
WhatsApp to the patient is the specific pattern not to repeat. If a lab wants auto-release
for a defined set of tests, that is a per-test configuration flag with its own audit
`source`, reviewed deliberately.

**Keep the wide-format file importer too**, rebuilt from the generic `Payment\` version
rather than the COVID-specific one: column headers as test codes, values run through the
range check, matched on `testcode` / parameter code. It is how a lab onboards an analyser
that has no live interface, and it is what the labs are almost certainly doing by hand today.

## 16. Suggested build order

1. `inf_result_audit` + `inf_auth_audit` tables and the write helpers. Everything else
   depends on the trail existing first.
2. The three new capabilities and their server-side enforcement.
3. Read-only worksheet in the Infinity UI — the sample list already works through
   `ReportsRepository`; add the per-sample result grid with ranges, units, and flags.
4. The transactional result-entry endpoint and grid editing.
5. Authorisation and the signatory flow.
6. The amendment/re-open flow with a mandatory structured reason.
7. The instrument inbox and the first driver.
8. The wide-format importer.

Steps 1–2 are prerequisites for any write at all. Everything from step 4 onward is a write
against the live production `Noble` database shared with the running LIS, and per
`api/README.md` needs explicit sign-off before deployment.
