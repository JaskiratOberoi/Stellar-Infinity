# F1 — Sample transit / inward tracking: behaviour contract

Role A (legacy analyst) output for Phase P1 of the port plan
(`docs/agent-port-plan.md`). Source of truth: the **NOBLE deployed copy**, which
is AHEAD of the dev tree (see §1). Production table:
`dbo.tbl_acc_inward_sample_tracking` (233,075 rows; 58,085 scans/90d).

Everything here is read from code. Claims that only production data can settle
are collected in §12 (open questions) for Role B.

---

## 1. Source files and which copy is authoritative

| File | Copies | Verdict |
|---|---|---|
| `MedCis.UI\Worksheet\Inward.aspx(.cs)` | dev tree, `NOBLE\`, `NOBLE\NOBLE\` | **`NOBLE\MedCis.UI\Worksheet\Inward.aspx(.cs)` is authoritative.** The dev tree and the nested `NOBLE\NOBLE\` backup are the same OLDER version. NOBLE adds: (a) Excel export button `btnExport` + `VerifyRenderingInServerForm` override, (b) PCC-user scoping (`PCC_Id > 0` forces the client filter and disables `ddlPcc`), (c) grid `PageSize` 100 instead of 20, (d) column width tweaks. |
| `MedCis.Business\Worksheet\AccessionClass.cs` | all three copies **identical** | Any copy. Inward methods at lines 168–243. |
| `MedCis.Business\Utilities.cs` | NOBLE differs from dev only in one dropdown caption ("--Select Client--" vs "--Select PCC--") | NOBLE authoritative. |
| `MedCis.Business\Pcc\WorksheetClass.cs` | NOBLE differs from dev | NOBLE authoritative (accession side-effect methods). |
| `MediCis.DAL\Med.dbml` / `Med.designer.cs` | table + sproc definitions | identical for this table across copies. |

Everything is LINQ-to-SQL (`MedDataContext`) — **no hand-built SQL strings
anywhere in this feature**, so the usual unparameterised-SQL FIX pattern does
not apply here. The only raw database objects touched are two stored
procedures: `dbo.sp_user_activity_log` and `dbo.sp_mcc_test_account_101`
(signatures in §8).

## 2. Complete list of readers/writers of `tbl_acc_inward_sample_tracking`

Raw `grep -ri` of the entire `E:\Listec Genomics` tree (including NOBLE, NOBLE\NOBLE,
WebApplication1, Razor, Razor2, Payment, ICMR, `.sql` files — the repo's Grep
tool skips NOBLE, a raw grep was used):

- `MedCis.UI\Worksheet\Inward.aspx.cs` — the ONLY page. Reads and writes.
- `MedCis.Business\Worksheet\AccessionClass.cs` — the only business class:
  `GetInwardDetails`, `CheckInwardVailid`, `GetVailSlno`, `SaveInward`
  (+ `GetVailClientCode` which reads `tbl_med_mcc_patient_samples`).
- `MediCis.DAL\Med.dbml` / `Med.designer.cs` — mapping only.
- **No stored procedure in the tree touches the table.** Only 3 `.sql` files
  exist in the whole tree; none mention it. (Server-side objects — triggers,
  jobs, procs living only in the DB — are invisible from code: Role B Q1.)
- `Utilities.cs` line 1261 defines `public class InwardSamples { vailId, vailDate, adddedby }` —
  defined, **never referenced anywhere**. Dead code; do not port.

So the feature's entire surface is one page + four business methods. There is
no handler, no NOBLE-only extra page, no report that reads it.

## 3. Table shape (from `Med.dbml` lines 1324–1341)

```
dbo.tbl_acc_inward_sample_tracking
  id                      int identity PK
  vailid                  varchar(50)  NULL     -- the vial/sample barcode ("SID")
  patient_id              int          NULL     -- FK-ish → tbl_med_mcc_patient_master.id (assoc in dbml)
  scan_datetime           datetime     NULL     -- first scan at this business unit
  scan_by                 varchar(50)  NULL     -- "username- Scan DT:dd-MM-yyyy" (composite string, see §6)
  bunit                   varchar(50)  NULL     -- BusinessUnitCode (string) of the scanning unit
  received_one            varchar(50)  NULL     -- username of 2nd scan at same unit
  received_one_datetime   datetime     NULL
  received_two            varchar(50)  NULL     -- username of 3rd scan
  received_two_datetime   datetime     NULL
  received_three          varchar(50)  NULL     -- username of 4th scan
  received_three_datetime datetime     NULL
  slno                    int          NULL     -- per-bunit, per-day running number (see §6)
```

Key semantic discovered in code (§6): **one row = one (vialid, business unit)
pair**, not one row per vial. A vial travelling PCC → hub → HO gets one row per
unit it is scanned at. Within a unit, the four scans land in
`scan_*`, `received_one*`, `received_two*`, `received_three*` in strict
positional order. Nothing links or orders the rows of one vial across units
except their timestamps.

## 4. Access control

- Page requires forms-auth (`Page.User.Identity.IsAuthenticated` else redirect
  `~/login.aspx`).
- Page permission: `utl.CheckUserPage(55, usertypeid)` on first load only
  (not on postbacks); failure → `~/Error.aspx?id=Inward`.
  Implementation (`Utilities.cs` 1221):

  ```csharp
  var temp = dt.tbl_med_security_masters.Where(c => c.menuid == pageId && c.usertype == usertypeId).FirstOrDefault();
  ```

  **Row-presence check only** — the `_read`/`write`/`_delete` bit columns on
  `tbl_med_security_master` are IGNORED. Having any row for (menuid 55,
  usertype) grants full read+write. Which usertypeids have that row is data →
  Role B Q2.
- Navigation: the menu is built from `tbl_med_security_master` joined to
  `tbl_med_menu_master` (`SecurityMasterClass.GetMenuByUserType`), so the link
  and the permission come from the same row. `page_url` for menuid 55 is data
  → Role B Q2.
- **No scope check on the scan itself**: any user who passes page 55 can scan
  ANY vialid — including another client's — and cause the §7 side effects.
  Only the LIST view is scoped (§5).

## 5. Read path — the grid

### 5.1 UI fields (all in one filter row; no validators anywhere on the page)

| Control | Type | Behaviour |
|---|---|---|
| `ddlPcc` | DropDownList | Client filter. Filled by `FillCombo("PCC")`: all `tbl_med_mcc_unit_masters` ordered by `MCCUnitCode` (no IsActive filter — inactive clients listed), value = `id`, item 0 = `--Select Client--`. If user's `Business_Unit_id > 1`, filled by the overload filtering `tbl_med_mcc_unit_master.BusinessUnitCode == Business_Unit_id` (NB: `mcc_unit_master.BusinessUnitCode` is an **int** referencing `business_unit_master.id`, unlike the string `business_unit_master.BusinessUnitCode` — same name, different type/meaning). If user's `PCC_Id > 0`: dropdown disabled and pre-selected to their PCC. |
| `txtSearchSid` | TextBox, placeholder "SID" | **Exact** match against `vailid` (trimmed). No prefix/like search. |
| `txtFdate` / `txtTdate` | TextBox + AjaxControlToolkit CalendarExtender, format dd/MM/yyyy | Default = today (both). Empty on postback → reset to today. Parsed with `Convert.ToDateTime` (server culture). Window built as `from 00:00:01` to `to 23:59:59` — the first second of the from-day and the last second of the to-day are half-excluded. |
| `btnSearch0` "List" | Button | `LoadGrid()`. |
| `txtVailId` | TextBox, `AutoPostBack="True"`, `ontextchanged="TextBox1_TextChanged"` | The scan box. See §6. |
| `Button1` "Inward" | Button | Also runs `CheckInward()` (manual alternative to the auto-postback). Doubles as the only feedback surface (text mutates to "No Workorder!"). |
| `btnExport` "Export" (NOBLE only) | Button, PostBackTrigger (full postback) | Excel export, §5.4. |

No field is required; there is no client-side JS beyond what ASP.NET
AutoPostBack/UpdatePanel emit; there is no printing on this page.

### 5.2 The query — `AccessionClass.GetInwardDetails` (lines 168–211), verbatim

```csharp
var t = (from c in dt.tbl_acc_inward_sample_trackings
         where
         (c.scan_datetime >= fDat && c.scan_datetime <= tDat) &&
         (strSid == string.Empty || c.vailid == strSid) &&
         (bunitId == "0" || c.bunit == bunitId) &&
         (mccCode == 0 || c.tbl_med_mcc_patient_master.tbl_med_mcc_unit_master.id == mccCode)
         orderby c.slno descending
         select new {
             id = c.id, slno = c.slno, vialid = c.vailid,
             scandate = c.scan_datetime, scanby = c.scan_by,
             name = c.tbl_med_mcc_patient_master.name,
             gender = c.tbl_med_mcc_patient_master.gender == 1 ? "M" : "F",
             bunit = c.bunit,
             client = c.tbl_med_mcc_patient_master.tbl_med_mcc_unit_master.MCCUnitCode,
             rec1 = c.received_one, rec2 = c.received_two, rec3 = c.received_three,
             rec1date = c.received_one_datetime, rec2date = c.received_two_datetime, rec3date = c.received_three_datetime,
             tests = dt.tbl_med_mcc_patient_samples.Where(dd => dd.vailid == c.vailid).FirstOrDefault() != null
                     ? dt.tbl_med_mcc_patient_samples.Where(dd => dd.vailid == c.vailid).FirstOrDefault().testnames.Replace(",",", ") : "",
         }).ToList();
```

Caller-side parameters (`LoadGrid`, NOBLE Inward.aspx.cs):

- `bunitId` = `"0"` (no filter) unless the user's `Business_Unit_id > 1`, in
  which case it is the user's `tbl_med_business_unit_master.BusinessUnitCode`
  (string). **HO (Business_Unit_id == 1, or null/0) sees every unit's rows;
  branch units see only rows whose `bunit` equals their code exactly** —
  which, per §6, is every row they created.
- `mccCode` = `ddlPcc.SelectedValue` if index > 0, else 0; **overridden** by
  the user's `PCC_Id` when `PCC_Id > 0` (client-portal users are locked to
  their own client).
- `strSid` = trimmed `txtSearchSid`.
- The date window ALWAYS applies — searching an old SID with today's default
  dates returns nothing. (Operationally significant; port must decide, §11 Q-K7.)

### 5.3 Grid presentation

Columns: SlNo, VialId (bold), Name/Tests ("name- M|F", then "Tests : …"),
Inward Date/By (`dd/MM/yy HH:mm` + scan_by), Client/Bunit ("MCCCODE | BUNIT"),
then **three columns all headed "Received1"** showing `rec1`, `rec2`, `rec3` —
usernames only; the three `rec*date` values are selected but never displayed
anywhere. Paging 100/page (NOBLE), numeric pager, `DataKeyNames="id"`.
EmptyDataTemplate: literal text "No archives found...".

Projection quirks:

- `gender == 1 ? "M" : "F"` — null gender (including every no-workorder row,
  where the patient join is empty) renders **"F"**… except that null
  propagation happens SQL-side: LINQ-to-SQL renders CASE WHEN gender = 1 …
  ELSE 'F', so NULL → 'F'. Wrong-sex display for unknowns. FIX.
- Rows with `patient_id` NULL (no-workorder scans) show empty name/client but
  DO appear — unless the client filter (`mccCode != 0`) is on, in which case
  the null-join predicate excludes them silently. A PCC-scoped user therefore
  NEVER sees their own no-workorder scans. FIX-flavoured but see §11.
- `orderby slno descending` with slno resetting daily per unit (§6): a
  multi-day or multi-unit listing interleaves unrelated days/units in
  descending-slno order, not chronologically. KEEP the visible ordering
  intent (newest first within a day), FIX the cross-day interleaving.

### 5.4 Export (NOBLE only)

`btnExport_Click`: turns off paging, `PageSize = 1000` (irrelevant once
paging is off), reloads the grid, renders the GridView's HTML into the
response with `ContentType application/vnd.ms-excel`,
`content-disposition: attachment;filename=sampletracking.xls`. It is HTML
pretending to be `.xls` (Excel shows a format warning), no size cap, honours
whatever filters are set. FIX: Infinity produces a real export (correct
content type, correct filename/extension) per ground rule 7.

## 6. Write path — the scan flow

### 6.1 Keystroke mechanics

There is NO custom JavaScript. The scan box `txtVailId` has
`AutoPostBack="True"`; ASP.NET wires `onchange` → `__doPostBack`. All controls
sit in an UpdatePanel with default `ChildrenAsTriggers`, so the postback is
async (partial render). The flow an operator (or barcode gun) experiences:

1. Page load and every postback end with `txtVailId.Focus()` (called in BOTH
   the `!IsPostBack` branch and unconditionally after it, and again at the end
   of `CheckInward`) — the cursor always returns to the scan box, enabling
   continuous gun scanning.
2. Gun types the vial id and sends its terminator (Enter or Tab). Either blurs
   or submits — the `change` event fires first → async postback →
   `TextBox1_TextChanged` → `CheckInward()`. (`Button1` "Inward" reaches the
   same method for manual entry. There is no DefaultButton; a bare Enter with
   an unchanged textbox falls through to the form's first submit button —
   "List" — which merely reloads the grid.)
3. `CheckInward()` starts with `System.Threading.Thread.Sleep(1000)` — a
   deliberate 1-second server-side delay on EVERY scan (presumably a debounce
   /pacing hack). 58k scans/90d ≈ 16 wasted server-seconds an hour. FIX.
4. After the write, `txtVailId.Text = ""`, grid reloads, focus returns. Ready
   for the next scan. Throughput is therefore ~1 scan/sec + roundtrip.

### 6.2 `CheckInward()` logic, exactly (NOBLE Inward.aspx.cs 144–256)

Let `BU` = `((tbl_med_user_master)Session["loginUser"]).tbl_med_business_unit_master`
(the user's business unit row — a user with NULL `Business_Unit_id` throws NRE
at the first dereference; the page effectively requires a business unit).

```csharp
obj = objAcc.CheckInwardVailid(strVailId, BU.BusinessUnitCode);
// = dt.tbl_acc_inward_sample_trackings.Where(ee => ee.vailid == vailid && ee.bunit == bUnitCode).FirstOrDefault();
```

**Branch NEW (no row for this vial AT THIS UNIT):**

```csharp
obj = new tbl_acc_inward_sample_tracking();
obj.vailid = txtVailId.Text;                       // NOT trimmed (lookup was trimmed) — FIX
obj.scan_by = Page.User.Identity.Name + "- Scan DT:" + DateTime.Now.ToShortDateString();
obj.scan_datetime = DateTime.Now;
obj.patient_id = objAcc.GetVailClientCode(txtVailId.Text.Trim());
// = tbl_med_mcc_patient_samples.Where(ee => ee.vailid == vailId).FirstOrDefault()?.patient_id
if (obj.patient_id == null) {
    Button1.Text = "No Workorder!"; Button1.CssClass = "btn btn-danger";
    //return;                                       // commented out — row is SAVED ANYWAY
} else { Button1.Attributes.Add("CssClass", "btn btn-success"); }
obj.slno = objAcc.GetVailSlno(BU.BusinessUnitCode);
obj.bunit = BU.BusinessUnitCode;
```

`GetVailSlno` (AccessionClass 218–226):

```csharp
DateTime fdate = Convert.ToDateTime(DateTime.Now.ToShortDateString()).AddHours(0).AddMinutes(0).AddSeconds(0.1);
var obj = dt.tbl_acc_inward_sample_trackings.Where(ee => ee.scan_datetime >= fdate && ee.bunit == bUnitCode).ToList();
if (obj == null) return 1; else return obj.Count() + 1;
```

→ `slno` = (count of this unit's scans since 00:00:00.1 today) + 1: a
**per-unit, per-day sequence**. Read-then-insert with no lock — two
simultaneous scanners duplicate slno. The `obj == null` branch is dead
(`ToList()` never returns null). `.AddSeconds(0.1)` misses rows scanned in the
day's first 100 ms. Note `scan_by` embeds the date a second time as text —
`varchar(50)` means a username longer than ~30 chars overflows and the INSERT
throws. FIX (store username only; timestamp already in `scan_datetime`).

**Branch EXISTING (row exists for this vial at this unit) — the checkpoints:**

```csharp
if (obj.bunit != BU.BusinessUnitCode) { obj.bunit = obj.bunit + "->" + BU.BusinessUnitCode; obj.scan_datetime = DateTime.Now; }
else obj.bunit = BU.BusinessUnitCode;
```

The first branch is **provably dead code**: the lookup filtered
`ee.bunit == bUnitCode`, so `obj.bunit` always equals the current unit. The
"A->B" concatenated-bunit rows can never be created by this code path (if any
exist in production they predate this logic → Role B Q3). Cross-unit transit
is instead represented by a brand-new row (branch NEW), because the
(vailid, bunit) lookup misses.

```csharp
if      (obj.received_one   == null) { obj.received_one   = Page.User.Identity.Name; obj.received_one_datetime   = DateTime.Now; }
else if (obj.received_two   == null) { obj.received_two   = Page.User.Identity.Name; obj.received_two_datetime   = DateTime.Now; }
else if (obj.received_three == null) { obj.received_three = Page.User.Identity.Name; obj.received_three_datetime = DateTime.Now; }
```

**This is the complete semantics of the three checkpoint pairs**: they are not
named stages (not "received at lab / received at department / …"). They are
simply the 2nd, 3rd and 4th scan of the same vial at the same business unit,
by whoever was logged in, in arrival order. The ONLY ordering enforcement is
this null-cascade (one cannot fill `received_two` before `received_one`).
Nothing prevents the same user filling all three in three seconds, and the
**5th and later scans are silent no-ops** on the tracking row (no error, no
feedback, but the §7 side effects still run). Who the slots "should" be is
convention in the lab's heads, not in code → Role B Q4.

`SaveInward` (AccessionClass 237–243): `InsertOnSubmit` when `id == 0`, then
`SubmitChanges()`. No update-audit of any kind; LINQ-to-SQL optimistic
concurrency on all columns (a concurrent change → ChangeConflictException →
unhandled).

### 6.3 UI feedback quirks of the scan

- On "No Workorder!": button turns red with that text, **but the row is still
  inserted** (the `return` is commented out) — orphan tracking rows with
  `patient_id NULL` are a designed-in outcome. And on the NEXT successful
  scan the button text is never reset — it stays "No Workorder!" (only its
  CSS class flips to green) until a full page reload. FIX (feedback), but
  the orphan-row insert itself is arguably the feature "log that a vial
  arrived even if no workorder exists yet" → §11, Role B Q5.
- On a successful checkpoint scan there is NO confirmation whatsoever except
  the grid refreshing.

## 7. Side effects on the sample — the dangerous half of the scan

After the tracking write, still inside `CheckInward`, guarded only by
`BU.id > 0` (always true when the page didn't already NRE):

```csharp
var samStatus = dt.tbl_med_mcc_patient_samples.Where(ee => ee.vailid == txtVailId.Text.Trim()).FirstOrDefault();
if (samStatus != null) {
    samStatus.business_unit_id = BU.id;      // EVERY scan reassigns the sample's business unit
    samStatus.modifieddate = DateTime.Now;   // modifiedby NOT set
    dt.SubmitChanges();
}
```

**Every scan, at any unit, silently overwrites
`tbl_med_mcc_patient_samples.business_unit_id`** to the scanner's unit — the
sample's "where is it" pointer. No audit, no old-value capture, `modifiedby`
untouched. This is the "silent status overwrite" pattern → FIX class (Infinity
must audit it), but the overwrite itself is the transit feature working as
designed: the last scanning unit owns the sample. KEEP behaviour + FIX audit.

**Auto-accession at HO** — only when `samStatus != null && Business_Unit_id == 1
&& samStatus.sample_status == 1` (status 1 = `SampleSent` per
`Utilities.SampleStatus` enum):

```csharp
bool isCheckTrans = objWork.CheckTransCash(lblVailId, lblTestcodes, lblTypes, Page.User.Identity.Name);
objWork.GetTestsBySampleId(lblVailId.Text.Trim(), 0);
objWork.UpdateSampleStatus(samStatus);
utl.GetUserLog(Page.User.Identity.Name, samStatus.patient_id.ToString(), samStatus.vailid, "Sample Registered", DateTime.Now, "", "");
```

That is: **scanning a sent sample at head office IS accession** — identical
method chain to `Accession.aspx.cs` (page 28, lines 200–258), which Infinity
already covers as the MERGED Accessioning feature. Effects, in order:

1. `CheckTransCash` (`NOBLE WorksheetClass.cs` 694–912): walks the sample's
   `testcodes`/`testtypes` CSV; for each un-`amount_checked` test/profile/
   master-profile row in `tbl_med_mcc_patient_tests`, resolves the price
   (special rate `tbl_med_mcc_test_special_rates` first, else the client's
   rate-type price), calls `dbo.sp_mcc_test_account_101(userId, mccid, now,
   balance, charge, balance-charge, testname, patientname, patientid,
   subfranchise)`, decrements `tbl_med_mcc_account_master.currentbalance`,
   sets `amount_checked = true`. Creates the client's account row on the fly
   if missing. If the balance goes negative it consults
   `GetMccStatusByMccId100` (auto-lock check; the SMS send is commented out).
   NB: a missing rate row (`temp00`/`objProfRate00` null with no special
   rate) throws NRE → the whole scan errors AFTER the tracking row and
   business-unit overwrite were already committed (no transaction across
   steps).
2. `GetTestsBySampleId(vailid, 0)` (913–996): if no result rows exist yet for
   the vial, expands tests/profiles/master-profiles into skeleton
   `tbl_med_mcc_patient_test_results` rows inside a `TransactionScope`
   (results only — nothing else is in the scope).
3. `UpdateSampleStatus(samStatus)` (2494–2505): re-fetches by vailid, sets
   `sample_status = 2` (Registered), `modifiedby = user`, `modifieddate=now`,
   and patient master `Status = 2`.
4. `GetUserLog` (`Utilities.cs` 1084): `dt.sp_user_activity_log(userId, pid,
   vailid, "Sample Registered", now, "", "")`. Uses
   `...Where(c => c.Username == username).SingleOrDefault().id` — duplicate
   usernames throw, unknown username NREs.

Note the scan does NOT set the CommentText/`GetTestsBySampleId` return, does
NOT check the client's dues/lock BEFORE registering, and none of §6+§7 shares
a transaction — a failure mid-chain leaves a half-accessioned sample.

**PCC users can scan.** Two commented-out lines
(`// txtVailId.Visible = false; // Button1.Visible = false;`) show the intent
to make the page read-only for client-portal users (`PCC_Id > 0`) — never
enacted. Whether any PCC usertype actually has page 55 is data → Role B Q2b.

## 8. Stored procedures touched (signatures from Med.dbml)

- `dbo.sp_user_activity_log(USERID int, PID nvarchar(50), SAMPLEID nvarchar(50), FUNCTION_PERFORMED nvarchar(50), FUNCTION_DATE datetime, IPADDRESS nvarchar(20), OTHER_INFO nvarchar(100))`
- `dbo.sp_mcc_test_account_101(USERID int, MCCID int, TDATE datetime, CBALANCE int, TESTCHARGES int, CLOSINGBALANCE int, tname nvarchar(100), vailid nvarchar(50), patientid int, SUBFRANCHISE nvarchar(50))`

Both are pre-existing shared infrastructure (accession/billing), not part of
F1's own schema. Their bodies live only in the DB → Role B if needed.

## 9. Error paths

There is no try/catch anywhere on the scan path and no message label on the
page. Every failure mode surfaces as an unhandled exception → UpdatePanel
async error (browser alert / ScriptManager error) with the tracking state
whatever the last `SubmitChanges` left:

| Failure | When | Result |
|---|---|---|
| User has no business unit | any scan | NRE at `BU.BusinessUnitCode` |
| `scan_by` > 50 chars | long username | SQL truncation error, row not inserted |
| Missing rate row | HO scan of status-1 sample | NRE AFTER tracking row + bunit overwrite committed |
| Duplicate/missing username | accession log step | Single/NRE, after status already set to 2 |
| Unparseable date text | List | FormatException (culture-dependent parse) |
| Concurrent edit of same row | simultaneous scans | ChangeConflictException |
| `GetInwardDetails` exception | List | caught and rethrown unchanged (pointless try/catch) |

`btnSave_Click`, `GridView1_RowCommand`, `GridView1_RowDeleting`,
`chkReject_CheckedChanged`, `LinkButton1_Click`, `btnSearchMcc_Click` are all
dead/stubbed handlers left from the page this was cloned from (Department
master + Accession) — the grid has no edit/delete controls. Do not port.

## 10. Printing

Nothing is printed by this page. The only output artefact is the pseudo-`.xls`
export (§5.4).

## 11. Quirk register — KEEP / FIX

| # | Quirk | Verdict | Justification |
|---|---|---|---|
| 1 | One row per (vialid, business unit); new unit = new row; `received_1..3` = 2nd–4th scan at same unit, positional null-cascade | **KEEP** | This IS the data model of 233k production rows; Infinity must read and write it identically or history becomes unreadable. |
| 2 | 5th+ scan at a unit: silent no-op on tracking row, side effects still run | **KEEP** (behaviour) + surface it | Compatibility: don't invent a 4th slot; but Infinity should TELL the operator "already fully received" instead of silence. |
| 3 | No-workorder scan still inserts an orphan row (`patient_id NULL`), button goes red | **KEEP** | Chain-of-custody: the vial physically arrived; losing the scan because registration lags would be data loss. (Role B Q5 confirms orphans exist and get adopted.) |
| 4 | Every scan overwrites `tbl_med_mcc_patient_samples.business_unit_id` with no audit and without setting `modifiedby` | **KEEP** overwrite, **FIX** audit | The overwrite is the transit pointer working; the silence violates ground rule 6 — Infinity writes an audit row (actor/old/new). |
| 5 | Scan at HO of a status-1 sample performs full accession (billing debit, result skeletons, status→2) | **KEEP** | Live daily workflow — inward at HO is how samples get registered. Infinity must reuse its EXISTING accession path (one store), not clone this chain. |
| 6 | `scan_by` = "user- Scan DT:date" composite string in varchar(50) | **FIX** | Denormalised, truncation-prone; store username; timestamp already in `scan_datetime`. Reader must still parse legacy values for display. |
| 7 | `vailid` saved untrimmed while all lookups trim | **FIX** | Whitespace rows become unfindable by every query in the system. |
| 8 | `slno` per-unit per-day via count+1, no lock; `.AddSeconds(0.1)`; dead null-check | **FIX** mechanism, **KEEP** meaning | Keep "daily per-unit sequence" semantics (operators use it as today's tally); compute race-safely. |
| 9 | Dead "bunit A->B" concatenation branch (unreachable) | **FIX** (don't port) | Provably dead: lookup pre-filters bunit. Role B Q3 checks for fossil rows. |
| 10 | `Thread.Sleep(1000)` on every scan | **FIX** | Pure throughput tax; idempotency should come from design, not delay. |
| 11 | Grid: three columns all captioned "Received1"; checkpoint datetimes fetched but never shown | **FIX** | Copy-paste header bug; Infinity shows Received 1/2/3 with their timestamps. |
| 12 | NULL gender renders "F" | **FIX** | Wrong-sex display; render blank/— when unknown. |
| 13 | Client filter silently drops orphan (no-workorder) rows | **FIX** | LEFT-join semantics lost; PCC-scoped users can't see their own arrived-but-unregistered vials — the rows they most need. |
| 14 | Date window always ANDed with SID search; window is 00:00:01–23:59:59 | **FIX** | Exact-SID search should ignore dates (or Infinity keeps dates but defaults sensibly); use inclusive day bounds. |
| 15 | `orderby slno desc` interleaves days/units | **FIX** | Order by scan_datetime desc; slno stays visible. |
| 16 | `CheckUserPage` ignores `_read/write/_delete` bits | **KEEP** (as fact) → F4 | Faithfully model "row = access" until F4 (permission governance) replaces the scheme; do not invent bit semantics the LIS never enforced. |
| 17 | Permission checked only on `!IsPostBack` | **FIX** | Infinity checks capability on every request (its normal middleware). |
| 18 | No scope check on scan target: any page-55 user can scan any client's vial and trigger accession/billing | **KEEP** core, **ASK** edges | Cross-client scanning at hub/HO is the physical reality of a central lab. But Infinity should still apply ground rule 5 to the LIST/read side, and the lab should confirm whether branch units may scan vials of clients not mapped to them. |
| 19 | HTML-as-.xls export, no size cap | **FIX** | Ground rule 7: real format, correct Content-Type, honest filename. |
| 20 | PCC read-only intent commented out (PCC users can scan) | **ASK** (Role B Q2b decides if reachable) | If any PCC usertype has page 55, the lab must say whether client scanning is wanted; if none, moot. |
| 21 | Unhandled exceptions mid-chain leave half-accessioned samples (no transaction across §6–§7) | **FIX** | Infinity wraps scan + sample update (+ audit) in one transaction; accession reuses the existing audited path. |
| 22 | `FillCombo("PCC")` lists inactive clients | **KEEP** | Historic rows reference inactive clients; filtering would orphan the filter. Mark inactive visually if desired. |

## 12. OPEN QUESTIONS for Role B (settle from production data)

1. **Out-of-code writers**: does anything in the DATABASE write
   `tbl_acc_inward_sample_tracking` (triggers on it or on
   `tbl_med_mcc_patient_samples`, SQL Agent jobs, other apps)? Code shows the
   one page only; confirm via sys.triggers/sys.sql_modules text search and by
   comparing `scan_by` formats present in the data.
2. **Page 55 grants**: `SELECT usertype FROM tbl_med_security_master WHERE
   menuid = 55` (join `tbl_med_usertype` names, and `tbl_med_menu_master`
   row 55 to confirm `page_url` = Worksheet/Inward.aspx). (b) Do any of those
   usertypes belong to users with `PCC_Id > 0` (quirk 20)? (c) What are the
   `_read/write/_delete` values on those rows (all-ignored today)?
3. **Fossil bunits**: `SELECT DISTINCT bunit` — do any "A->B" concatenated
   values exist (dead branch §6.2), any NULLs, and do all values match
   `tbl_med_business_unit_master.BusinessUnitCode`? How many distinct units
   actually scan (drives whether multi-leg transit UI is needed)?
4. **Are the checkpoints used?** Fill rates of `received_one/two/three` (+
   datetimes) over the last 90d; typical delta between `scan_datetime` and
   `received_one_datetime`; are the fillers the SAME username as `scan_by` or
   different (i.e., are these real second-person hand-offs or double-scans)?
   Are all three ever full — does the 4-scan ceiling actually bind?
5. **Orphan scans**: how many rows have `patient_id IS NULL`, recent trend; do
   later matching workorders appear (same vailid in
   `tbl_med_mcc_patient_samples` created after `scan_datetime`), i.e. does
   anything ever ADOPT the orphan (code never backfills `patient_id`)? And the
   inverse: what share of samples registered in 90d have NO tracking row
   (is inward universal or optional)?
6. **slno reality**: does slno actually restart at 1 per unit per day; are
   there duplicate (bunit, day, slno) tuples (race in §6.2); NULL slnos?
7. **Multi-row vials**: distribution of rows-per-vailid (how many legs a vial
   really travels); any (vailid, bunit) DUPLICATE rows (possible if two async
   scans raced the 1-second sleep)?
8. **`scan_by` format drift**: distinct patterns (is it always
   "user- Scan DT:date"; any truncated at 50 chars)?
9. **Accession-by-inward share**: of samples reaching `sample_status = 2` in
   90d, how many have a user-activity-log "Sample Registered" row written at a
   time matching an Inward scan vs the Accession page — i.e. is Inward the
   PRIMARY accession path (drives how carefully P1 must integrate with
   Infinity's accession)?
10. **`tbl_med_mcc_patient_samples.business_unit_id`**: populated? Does it
    always equal the last scan's unit (§7 overwrite actually the live
    location pointer)? Does anything else read it (Role B: column usage scan)?
11. **Index check**: indexes on (vailid, bunit) and (scan_datetime, bunit) —
    58k scans/90d each also run the count query in `GetVailSlno`; Infinity's
    procs need to know what exists.
12. **Menu id 55 label**: `tbl_med_menu_master` row 55 title/url (for the
    port-inventory cross-check).

---
*Role A, F1, 2026-08-17. Sources: NOBLE deployed tree (authoritative) diffed
against dev tree; all paths under `E:\Listec Genomics`. No E:\ file was
modified; no database was queried.*
