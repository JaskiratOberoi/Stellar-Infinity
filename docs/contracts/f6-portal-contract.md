# F6 — Client portal (reporting half): behaviour contract

Role A (legacy analyst) output for the CLIENT PORTAL phase of the port plan
(`docs/agent-port-plan.md` §3), promoted ahead of P2 (dues) at the user's
request. Source of truth: the **NOBLE deployed copy**, cross-checked against
the **release package** it was built into (see §1 — this settles which of the
five Workorder forks actually exists in production).

Everything here is read from code. Claims only production data can settle are
collected in §9 for Role B. No `E:\` file was modified; no database was queried.

Already measured against Infinity staging on 2026-08-17 with a real client
login (DL0214) and **not re-derived here**: the reporting worklist works and is
correctly scoped (1,233 reports, 1 centre, every row their own code); report
open 200; report PDF 200 `application/pdf` ~1.7 MB; Smart Report 200; accounts
ledger shows only their own account; the report filter feed returns only their
own client code; accessioning queues return 200 with zero rows; nav served is
Dashboard / Orders / Accessioning / Patient orders / Catalogue / Accounts /
Reporting. The rate-list `billing:view` → `rate:manage` leak found and fixed
the same day is not repeated below; §8 lists the OTHER instances of that class,
which are worse.

---

## 1. Which copy is authoritative, and what is actually deployed

| Artefact | Verdict |
|---|---|
| `E:\Listec Genomics\MedCis.UI\Pcc\` (dev tree) | Stale. Identical to `NOBLE\NOBLE\` for every Pcc file. |
| `E:\Listec Genomics\NOBLE\MedCis.UI\Pcc\` | **Authoritative source.** Six files are newer than the dev tree: `Payment.aspx.cs` (2023-02-08), `razorCheckout.aspx.cs` (2023-01-21), `SampleStatus.aspx(.cs)` (2023-03-22 / 2023-03-13), `WebForm2.aspx.cs` (2023-03-22), `Workor.aspx(.cs/.designer.cs)` (2023-05-13). |
| `E:\Listec Genomics\NOBLE\NOBLE\MedCis.UI\Pcc\` | Older backup, byte-identical to the dev tree. Ignore. |
| **`NOBLE\MedCis.UI\obj\Release\Package\PackageTmp\Pcc\`** | **The build that shipped.** Timestamps match the NOBLE sources exactly (Workor 2023-05-13, SampleStatus 2023-03-22), so this is the deployed manifest, not a stale artefact. |

The package is the most important discovery in this contract, because it
collapses the "~20 pages" the plan assumed into **19 files, of which only 12 are
real screens**, and it settles the Workorder question without any database
query. `PackageTmp\Pcc\` contains exactly:

```
CourierStatus.aspx  Customers.aspx  Doctors.aspx  PatientWorkOrder.aspx
Payment.aspx        PrintBill.ashx  PrintBill.aspx  SampleStatus.aspx
Stylesheet1.css     WebForm1.aspx   WebForm2.aspx   Workor.aspx
autotext.asmx       ccavRequestHandler.aspx  ccavResponse.aspx
hrf.aspx            mrf.aspx        report_handler.ashx  wa.aspx
```

**Not deployed** (present in source, excluded from the package):
`Worder.aspx`, `Workorder.aspx`, `Workorder_om.aspx`, `Workorder_OM1.aspx`,
`SampleSent.aspx`, `checkout.aspx`, `razorCheckout.aspx`, `razorCallback.aspx`,
`SmsResult.ascx`.

Two corroborations that these are genuinely dead rather than merely missed:

- `SampleSent.aspx.cs` still declares `namespace MedCis.UI.Pcc` and imports
  `MedCis.Business` / `MediCis.DAL`. The whole solution moved to `LISTEC.*`
  namespaces years ago. It cannot compile against the current assemblies —
  it is orphaned source, not a shipped page.
- **Razorpay is not deployed at all** (`checkout`, `razorCheckout`,
  `razorCallback` all excluded), and NOBLE's `Payment.aspx.cs` has the
  Razorpay redirect commented out. See §5.3.

## 2. The client-reachable surface, enumerated

### 2.1 How reachability is decided

Two independent mechanisms, and they do **not** agree — which is the root of
most of §8.

1. **The menu.** `Site2.Master.loadMenus` → `SecurityMasterClass.GetMainMenuItems(usertypeId)`
   then `GetMenuByUserType(usertypeId, titleId)` (`MedCis.Business\General\SecurityMasterClass.cs`
   lines 84–104, 106–120). Both read `tbl_med_security_master` joined to
   `tbl_med_menu_master`, filtered `is_title == true`, ordered by
   `menu_master.order`. Link text = `page_title`, href = `page_url`.
2. **The page gate.** `Utilities.CheckUserPage(pageId, usertypeId)`
   (`MedCis.Business\Utilities.cs` 1221–1232):

   ```csharp
   var temp = dt.tbl_med_security_masters
                .Where(c => c.menuid == pageId && c.usertype == usertypeId)
                .FirstOrDefault();
   if (temp != null) isRet = true;
   ```

   Row-presence only — the `_read`/`write`/`_delete` bit columns are ignored,
   exactly as F1 recorded for page 55. Fired **only inside `!IsPostBack`**;
   every postback on every Pcc page is ungated.

`SaveMenusForUser` (`SecurityMasterClass.cs` 55–82) writes
`security_master.menuid = menu_master.id` and `menu_titleid = menu_master.menu_id`.
So **the integer passed to `CheckUserPage` is `tbl_med_menu_master.id`**, the
same key the menu joins on: menu link and page gate come from one row. That is
the good news. The bad news is §2.3.

### 2.2 Page → menu id → disposition

Menu ids read from `CheckUserPage(<id>, …)` in each `.aspx.cs` under
`NOBLE\MedCis.UI\Pcc\`. "Deployed" means present in `PackageTmp\Pcc\`.

| Page | Menu id | Deployed | What it is | Reachable by |
|---|---|---|---|---|
| `SampleStatus.aspx` | **26** | yes | **The reporting screen.** Worklist + report links. §3. | Client-granted (this is the portal's centre of gravity) |
| `WebForm2.aspx` | **27** | yes | **The report viewer/downloader** (Crystal `ex.rpt` / `ex2.rpt` / `cs.rpt`). §3.3 | Client-granted |
| `Workor.aspx` | **25** | yes | **The one surviving work-order screen.** §2.4 | Client-granted |
| `PatientWorkOrder.aspx` | 25 | yes | Older twin of Workor, same menu id. §2.4 | Same grant as Workor — *cannot* be separated |
| `WebForm1.aspx` | 25 | yes | Third twin (a "print/registration" fork). Same id. | Same grant |
| `Customers.aspx` | 23 | yes | Client's own referring-customer master | Client-granted |
| `Doctors.aspx` | **24** | yes | Client's own referring-doctor master | Client-granted |
| `mrf.aspx` | **46** | yes | **Material Request Form** — client orders vials/kits/consumables from the lab. NOT a report handler. | Client-granted |
| `hrf.aspx` | **47** | yes | **Help Request Form** — client raises a support ticket / requests a visit. NOT a report handler. | Client-granted |
| `CourierStatus.aspx` | **44** | yes | Dispatch/docket tracking for returned hard-copy reports | Client-granted |
| `Payment.aspx` | 22 *(gate commented out)* | yes | Online top-up entry point → redirects off-site. §5.3 | **Any authenticated user** |
| `PrintBill.aspx` / `PrintBill.ashx` | *none* | yes | Bill PDF — **and inserts a CASH receipt from the query string.** §5.4 | **Any authenticated user** |
| `report_handler.ashx` | *none* | yes | Cached report PDF by SID. §3.5 | **Any authenticated user** |
| `ccavRequestHandler.aspx` / `ccavResponse.aspx` | *none* | yes | CCAvenue handshake, orphaned (§5.3) | **Any authenticated user** |
| `autotext.asmx` | *none* | yes | Autocomplete over the full test/profile catalogue codes | **Any authenticated user** |
| `wa.aspx` | *none* | yes | WhatsApp send test harness, hard-coded phone `9849112653` | **Any authenticated user** — DROP |
| `Worder` / `Workorder` / `Workorder_om` / `Workorder_OM1` | 25 | **no** | Dead forks. §2.4 | — |
| `SampleSent.aspx` | 24 | **no** | Dead (wrong namespace, cannot compile) | — |
| `checkout` / `razorCheckout` / `razorCallback` | *none* | **no** | Razorpay, dead. §5.3 | — |

The client landing page is **not** in `Pcc\` at all: `Default.aspx.cs` line 25
redirects any `PCC_Id > 0` user to `~/Admin_General/das-cli.aspx`, a dashboard
with **no `CheckUserPage` call of any kind** and a `private static string
currentClientCode` shared across every concurrent request in the app domain
(`das-cli.aspx.cs` line 14).

Two more handlers sit outside `Pcc\` but are on the client's report path:
`Worksheet\clihis.ashx` (clinical-history PDF by SID, no gate) and `g.aspx`
(encrypted-SID report PDF with letterhead, no gate).

### 2.3 The menu-id namespace is REUSED across groups — a real privilege collision

`CheckUserPage` compares only `menuid == pageId`. Nothing scopes the id to a
folder or a module. Grepping every `CheckUserPage` call in
`NOBLE\MedCis.UI` shows the same integer serving unrelated screens:

| Menu id | Pcc page (client-facing) | ALSO unlocks |
|---|---|---|
| **25** | `Pcc\Workor` + `PatientWorkOrder` + `WebForm1` | `Admin_Technical\EditSample_Master.aspx` (re-type a sample after registration) and `Admin_General\User_Department_Mapping.aspx` |
| **46** | `Pcc\mrf.aspx` | `Billing\Bill.aspx` — the lab-wide billing worklist |
| **44** | `Pcc\CourierStatus.aspx` | `Admin_Technical\Organism.aspx` |
| **24** | `Pcc\Doctors.aspx` | `Pcc\SampleSent.aspx` (dead) |
| **22** | `Pcc\Payment.aspx` | `Admin_General\Birthdays.aspx` |

Granting a client usertype the work-order screen therefore also grants it a
catalogue-editing screen. In practice both of those collisions are moot,
because those two pages have their gate commented out anyway (§2.4/§8) — which
is the point: nothing in this system actually confines a client to `Pcc\`.

### 2.4 The five Workorder variants are one flow, and four of them are dead

The plan asked for a diff and the union rather than five screens. The diff:

Control sets from the `.designer.cs` files (`NOBLE\MedCis.UI\Pcc\*.aspx.designer.cs`):

| Fork | Controls | Delta vs `Workorder.aspx` (the common ancestor) |
|---|---|---|
| **`Workor.aspx`** (deployed, 2023-05-13, 94 KB code-behind) | 60 | **adds** `FileUpload1`, `mpeCliHis`/`btnCliHis`/`divCliHis` (clinical-history attach), `txtMRNID`, `txtSRF` (external order number), `txtEmail`, `HyperLink2`, two `FilteredTextBoxExtender`s; **drops** `btnPrint`, `tblDuplicate`, `txtAmountPaid`, `txtPatEmail`/`txtPatMob`, `RadioButton1..3`, `btnSearchMcc`/`txtSearchMCC`, three watermark extenders |
| `Workorder.aspx` | 65 | baseline |
| `Workorder_om.aspx` | 63 | + `txtRefDoctor3` (a third referring-doctor free-text) |
| `Workorder_OM1.aspx` | 51 | + `txtRefDoctor3`, `GridView2`, `lblAmt` |
| `Worder.aspx` | 61 | + `chkBill`, `lblRefCust`/`lblRefDoctor` labels |
| `PatientWorkOrder.aspx` | 58 | ≡ `Workorder` minus one watermark extender |

All six call `CheckUserPage(25, …)`, all six write the same staging tables, all
six differ only in which optional fields are on screen. **Four are excluded
from the release package.** `PatientWorkOrder.aspx` and `WebForm1.aspx` ship but
nothing links to them — a tree-wide grep for inbound references to any Workorder
variant returns *zero* hits outside the files themselves, so all of them are
reachable only via `tbl_med_menu_master.page_url` for menu 25 (Role B Q3).

**The union to port is `Workor.aspx`'s field set**, which is a superset of the
live behaviour: patient (initial/name/age/age-type/gender/mobile/email),
sample date + hour + minute, referring doctor (dropdown *or* free text),
referring customer (dropdown *or* free text), clinical history text, an
optional clinical-history PDF, MRN and SRF/order-number, one row per sample
with a client-typed SID, and a test/profile/master-profile picker priced off
the client's own rate type.

Write path (`Workor.aspx.cs` `btnSubmit_Click` 400–500, `submitData` 782):
rows land in **`temp_med_mcc_patient_master` / `temp_med_mcc_patient_sample` /
`temp_med_mcc_patient_test`** with `sample_status = 1` (SampleSent) and
`Business_unit_code = user.Business_Unit_id`; a second action,
`SubmitAllPatientsByMcc(ddlPcc.SelectedValue, username, "")`, promotes the whole
staged batch to the live tables. The staging table is the legacy answer to
"a client half-typed an order and walked away".

## 3. The reporting journey, in full

### 3.1 Finding a report — `SampleStatus.aspx` (menu 26)

Filters, from `LoadGrid()` (`SampleStatus.aspx.cs` 197–324) and the markup:

| Control | Semantics |
|---|---|
| `ddlMcc` | Client filter. Filled by `Utilities.FillCombo(ddl,"PCC")` — see §8 #4. For `PCC_Id > 0` it is pre-selected and `Enabled = false`; for a client whose `tbl_med_mcc_unit_franchise_mappings` is non-empty it is **left enabled** and refilled by `FillComboPCCSUBPCC(PCC_Id)` = self ∪ mapped sub-franchises. `sub_pcc_id` users are pinned to their sub-code. |
| `txtMccCode` | Textbox, disabled, shows the code. Its use in the query is **commented out** (line 242) — dead. |
| `txtFdate` / `txtTodate` | Default both = today. Window is `from 00:00:01` to `to 23:59:59` — the same half-open bug F1 recorded. Parsed with `Convert.ToDateTime` (server culture). |
| `txtPname` | Patient name; `"0"` sentinel means "no filter". |
| `txtRegNo` | PID (integer). `Convert.ToInt32` with no `TryParse` → `FormatException` on anything non-numeric. |
| `txtVailId` | SID. **Always ANDed with the date window**, so searching last month's SID with the default dates returns nothing. |
| `ddlStatus` | 1 Sample Sent, 2 Registered, 3 Rejected, 4 Partially Tested, 5 Tested, 6 Partially Authorized, 7 Authorized, 8 Partially Printed, 9 Printed, 10 Pending. (`Utilities.SampleStatus` at line 1098 disagrees — it has `PartiallyPrinted=8, Pending=9` and no `Printed`. The dropdown is what the proc is fed; the enum is stale.) |
| `ddlDeptNo` | Department. |
| `txtTestcode` | Test code. |
| `chkTat` | TAT-breach flag → `@TAT = 1`. |

Query: **`dbo.usp_pcc_samplestatus(@mccId, @fdate, @tdate, @patname, @pid, @sid,
@status, @deptid, @testcode, @TAT, @userid)`** — a stored procedure whose body
lives only in the database (Role B Q1). Result columns, from
`Med.designer.cs` class `usp_pcc_samplestatusResult`:

```
ID  pid  MCCUnitCode  age  sex  age_type  age_type_id  SampleDateTime  name
vailid  testnames  RegdDate  RegdTime  sample_status  sid  status  status_desc
Sample_Comments  Sample_ClinicalHistory  UserMapping  Sta  Micro  short_name
Cli  Bunit  BCode  tat  billnumber
```

Note what the proc does NOT take: **no business-unit parameter.** The `@bunitId`
plumbing exists only in `PopulateDate()`, a paged variant that calls
`USP_SAMPLE_WORKSHEET` and is **entirely dead** (its only caller `b_click` is
wired from `AddPagingButton`, which is commented out at line 42). So on the
reporting screen the scope is `@mccId` alone — one client code as a *string*.
P1's finding that legacy forced both a client filter and a unit filter holds for
`Inward.aspx` and for `Customers`/`Doctors` (§4), but **not** here.

Two post-query filters applied in C#:

- if the user has rows in `tbl_med_user_sales_mcc_mapping`, rows are reduced to
  those with `UserMapping != null` (a sales-rep territory filter that also
  applies to client logins if anyone ever mapped one).
- account lock, §3.4.

Per row the client sees: client code, PID (link), patient name, SID (link),
test names, registration date, registration time, status (link), a
culture-and-sensitivity icon when `Micro` is true, and a clinical-history
download link `../Worksheet/clihis.ashx?id=<sid>`. Repeated PID/name/code cells
are blanked on consecutive rows of the same patient. Row background is set by
status name (`GetRowBackground`, 403–435). Footer shows `PID# n - SID# m`.
There is a hidden `Bill#` column linking `~/Billing/Billx.aspx?id=<pid>`
(`Visible="false"`, markup line 404) — hidden, not removed, and the target has
no gate (§8 #2).

Export: `btnPrint_Click` (568–619) renders the hidden `gvExport` GridView's HTML
into the response as `MCC_ORDER_LIST.xls` with
`ContentType application/vnd.ms-excel` — HTML masquerading as `.xls`, no size
cap, same anti-pattern F1 flagged. **It only ever contains rows when
`status == 1`** (Sample Sent): `gvExport.DataBind()` is called in the
`if (status == 1)` branch only (lines 266–276), never in the `else`. Exporting
an Authorized worklist silently produces an empty spreadsheet.

### 3.2 Which rows offer a report link

`hpVailSt` (SID-level) and `hlPatientReport` (patient-level) carry
`Enabled='<%# Eval("Sta") %>'` — a `bool` computed **inside the stored
procedure**. `dlVailStatus_ItemDataBound` (451–468) applies the same rule
client-side using `GetSampleStatusByVailId`: `sampleStatus <= 6` → link
disabled and `NavigateUrl` nulled. Taken together the intent is clear —
**a report is offered from status 7 (Authorized) upward**, so partial and
un-authorised results are not linked. Whether `Sta` in the proc really is
`sample_status >= 7` is Role B Q1: it is the single most important line of SQL
in this feature and it is not in the source tree.

Whatever `Sta` says, **it is presentation only**. `WebForm2.aspx` does not
re-check status. Typing the URL for a status-5 SID renders whatever the Crystal
report has (§3.3).

### 3.3 Opening and downloading — `WebForm2.aspx` (menu 27)

`SampleStatus` links to `../Pcc/WebForm2.aspx?sid=<key>&type=<VAIL|PAT|CS>` in a
fancybox iframe. Three modes:

| type | key | Crystal report | Meaning |
|---|---|---|---|
| `VAIL` | SID | `../Reports/ex.rpt` | one sample's report |
| `PAT` | PID | `../Reports/ex2.rpt` | all of a patient's authorised samples, one document |
| `CS` | SID | `../Reports/cs.rpt` | culture & sensitivity |
| `ALG` | SID | (falls through to `ex.rpt`) | allergy — routed in the scope branch but never in `LoadReport`; a fossil |

The page renders inline in a `CrystalReportViewer` with `DisplayToolbar = false`
and `SeparatePages = false`, then offers three actions:

- **`Button2`** → `LoadReportSelect(false)` — PDF **without** letterhead.
- **`Button3`** → `LoadReportSelect(true)` — PDF **with** letterhead.
- **`Button4`** → emails the PDF (with letterhead) to a free-text address the
  client types into `txtEmail`, over SMTP credentials from `appSettings`, with
  a hard-coded Noble Diagnostic Centre signature block in the body.

`LoadReportSelect` (162–248) does three things before it exports:

1. `type=VAIL|CS` → `WorksheetClass.ChangeSampleStatus(sid)`; `type=PAT` →
   the same for every sample of that patient with `sample_status >= 7`.
   `ChangeSampleStatus` (`Pcc\WorksheetClass.cs`): `6 → 8`, `7 → 9`, `8 → 8`,
   anything else unchanged. **Downloading from the client portal mutates the
   sample's status to Printed.**
2. `Utilities.GetUserLog(user, "", sid|pid, "Printed <from>-<to>", now, "", "")`
   → `sp_user_activity_log`. This is the only audit of a client report download.
3. `reportdocument.ExportToHttpResponse(PortableDocFormat, Response, true, …)`.

The filename argument is `vailId + "_" + vailId != string.Empty ? vailId :
patId.ToString() + "_Report"` — `+` binds tighter than `?:`, so this is
`("SID_SID" != "") ? SID : …` and always evaluates to the bare SID. Harmless,
but it means the letterhead/no-letterhead PDFs are indistinguishable by name.

**One report at a time.** There is no multi-select, no "download all", no zip.
The nearest thing to a batch is `type=PAT`, which merges one patient's
authorised samples into a single document.

There is no separate print action: printing is the browser printing the inline
Crystal viewer, or printing the exported PDF.

### 3.4 Can a client see a report when money is owed?

Yes and no, and the distinction matters for the port because it is **not** the
same rule as Infinity's 423.

The gate is `WorksheetClass.GetMccStatus(mccUnitCode)` (per row, in
`gvSample_RowDataBound`) and `GetMccStatusByMccId100(mccId)` (per page, in
`LoadGrid` and in `WebForm2.Page_Load`). Body of `GetMccStatus`:

```csharp
if (mccStatus.PerminentUnlock == true || acc.currentbalance > 0)          return true;
if (mccStatus.creditlimit < 0 && mccStatus.creditlimit < acc.currentbalance) return true;
if (isExpireDate != null && isExpireDate > DateTime.Now)                   return true;   // tbl_med_mcc_lockunlock
return false;                                                                             // LOCKED
```

So the lock is a **prepaid-wallet / credit-line check on the CLIENT ACCOUNT**
(`tbl_med_mcc_account_master.currentbalance` vs
`tbl_med_mcc_unit_master.creditlimit`, with a `PerminentUnlock` override and a
time-boxed manual unlock in `tbl_med_mcc_lockunlock`) — **not** a per-bill
"this invoice is unpaid" check. An individual unpaid patient bill does not hide
a report; running the centre's account below its negotiated credit line hides
*every* report for that centre.

When locked:
- `SampleStatus` disables the whole grid and pops "This MCC Account was locked,
  Contact Medcis..." (lines 305–312).
- `WebForm2` disables `Button2`/`Button3`, writes an activity-log row
  `"UnAthorized Printing Access…"`, and redirects to `~/Error.aspx?id=Print`
  (lines 50–63).
- A sub-client (`sub_pcc_id > 0`) is judged on its **parent's** account
  (line 388 and 303–304) — one franchise's overdraft locks all its branches.

Infinity's 423 is the same *shape* (scope → lock → row) but almost certainly a
different *predicate*; reconciling the two is a build decision, not a reading
(§9 Q4).

### 3.5 hrf.aspx and mrf.aspx are NOT report handlers — verified

The brief flagged these as likely report handlers. They are not:

- **`mrf.aspx` = Material Request Form.** `lblPageTitle = "Pcc > Material
  Request Form"`. A client raises a requisition for consumables against
  `tbl_inventory_client_request_master` / `tbl_inventory_client_request_form`:
  item, units, **price**, requested qty; the lab fills approved qty, issued
  qty, barcode range from/to, courier name and docket number (stored as
  `"courier|docket"` in one column). Status ≥ 2 freezes the client's rows.
  Column 9 (the lab-only action column) is hidden for `usertypeid != 1`.
- **`hrf.aspx` = Help Request Form.** `lblPageTitle = "Pcc > HRF"`. A support
  ticket, stored by **repurposing the QC reconstitution table**
  `tbl_technical_dc_reconstitutional`: `control_name` = `"T|"` or `"G|"` +
  request text, `control_lot_number` = the reply, `expirty_date` = date+time of
  requested visit, `last_vail_taken` = issued-to, `number_of_vails` = the
  raiser's `PCC_Id`, `number_of_vails_remaining` = the raiser's user id.
  Scoped by `pccId` in `GetHRF`. An SMS fires to the client on reply.

The actual report handler is **`report_handler.ashx`**, and it is the worst
thing in this contract:

```csharp
public void ProcessRequest(HttpContext context) {
    if (context.Request.QueryString.Count == 1) {
        var temp = db.tbl_med_mcc_patient_reports
                     .Where(f => f.vailid == context.Request.QueryString[0]).FirstOrDefault();
        if (temp != null && temp.vail_report_document != null) {
            context.Response.ContentType = "application/pdf";
            context.Response.AppendHeader("Content-Disposition", "inline;filename=" + temp.vailid + ".pdf");
            context.Response.BinaryWrite(temp.vail_report_document.ToArray());
```

No `CheckUserPage`. No client scope. No status check. `GET
/Pcc/report_handler.ashx?<any SID>` returns that patient's cached report PDF to
**any authenticated user**, client logins included. The two-argument branch
additionally renders a fresh Crystal PDF and inserts it into
`tbl_med_mcc_patient_report` over a **hard-coded production connection string
with credentials in source** (`Data Source=183.82.97.60,1434; … User
ID=medcis_owner;Password=…`, line 78), and sets `Content-Length` to a filename
string.

`Worksheet\clihis.ashx` has the same shape for clinical history —
`GetPatientCliHis(id)` = `Where(e => e.filene == id && e.filetype == "HISTORY")`,
no scope check — and `g.aspx` will export any report as PDF with letterhead
given an encrypted SID, also without a gate.

### 3.6 The IDOR in the report viewer — the single most serious finding

`WebForm2.Page_Load` (lines 35–76), reproduced faithfully:

```csharp
PCC_ID = objWork.GET_MCC_CODE_BYID(Request.QueryString[0], "VAIL"|"PAT", user.PCC_Id);

if (PCC_ID > 0 && user.PCC_Id > 0) {
    isEnable = objWork.GetMccStatusByMccId100(PCC_ID);
    if (!isEnable) { …log…; Response.Redirect("~/Error.aspx?id=Print"); return; }
    else { LoadReport(); LoadGraph(); ShowSms(); }
} else {
    LoadReport();          // ← no scope check, no lock check
    LoadGraph();
}
```

And `GET_MCC_CODE_BYID` (`Pcc\WorksheetClass.cs` 2619–2641):

```csharp
if (TYPE == "VAIL") {
    if (LOGIN_PCCID == dt.tbl_med_mcc_patient_samples.Where(e => e.vailid == ID)
                         .FirstOrDefault().tbl_med_mcc_patient_master.mcc_code)
        ret = …mcc_code;          // else ret stays 0
}
```

It returns the client code **only when the sample belongs to the caller**, and
`0` otherwise. `WebForm2` then treats `0` as "not a PCC user" and takes the
`else` branch, **which renders the report anyway.**

The check is inverted. It does not decide whether you may see the report; it
decides only whether the account-lock rule applies to you. Consequences:

1. Any client login can read **any** patient's report by editing `?sid=` — full
   cross-client PHI exposure through the portal's own viewer.
2. A client whose own account is **locked** can bypass the lock by requesting a
   SID that is not theirs (mismatch → `else` → renders).
3. A **sub-client** (`sub_pcc_id`) reading their OWN sample also mismatches
   (the comparison is against `PCC_Id`, the parent), so sub-clients are
   silently in the unchecked branch for everything they legitimately open.
4. `SampleStatus`'s `Sta` flag never reaches this page, so an un-authorised or
   partially-authorised SID renders whatever `ex.rpt` currently contains.

This is the same class as the rate-list leak the user already fixed, but the
payload is patient results rather than prices.

## 4. Everything else a client-code login can do

One-line verdict each. "Already in Infinity" is against the measured DL0214
session; "MISSING" means no equivalent surface exists.

| Capability | Legacy page | Verdict |
|---|---|---|
| Report worklist, search, open, download PDF | `SampleStatus` + `WebForm2` | **Already in Infinity** (measured: 1,233 rows, correct scope, 200 + 1.7 MB PDF) — but Infinity is missing the *client-facing* framing, §6 |
| Report emailed to an address the client types | `WebForm2.Button4` | **MISSING** — and see §8 #12 before porting |
| Culture & sensitivity report | `WebForm2?type=CS` | **MISSING** — F7 (micro) is ASK-gated, and P1's Role B found micro configured but unused |
| Patient-level combined report (all authorised samples) | `WebForm2?type=PAT` | **PARTIAL** — Infinity has per-SID PDF and a bulk endpoint; a per-PATIENT merge is not the same thing |
| Bulk download of several reports | — | Legacy has **none**; Infinity already has `POST /reports/pdf/bulk` with per-SID gating. Infinity is *ahead*. |
| Clinical-history PDF download | `clihis.ashx` | **MISSING** (and the legacy one is ungated) |
| Clinical-history PDF upload against a SID | `SampleStatus.btnUpload_Click` | **MISSING** — attachments exist in Infinity for lab users; client upload is a separate decision |
| Sample status / where-is-my-sample | `SampleStatus` status column + colour bands | **PARTIAL** — Infinity's reporting worklist carries status; the transit legs from F1 (`tbl_acc_inward_sample_tracking`) are not surfaced to clients |
| Dispatch / courier docket tracking | `CourierStatus` | **NOT WANTED** — the plan already records 11 rows ever; DROP unless the lab objects |
| Account balance + ledger | `Default.aspx` balance label, `Admin_General\Accounts` | **Already in Infinity** (measured: own account only) |
| Online top-up | `Payment.aspx` → off-site CCAvenue | **MISSING**; §5.3 says decide before building |
| Bill/receipt PDF | `PrintBill.aspx/.ashx` | **SHOULD NOT PORT as written** (§5.4); Infinity has `PrintInvoice` |
| Raise a work order / register a patient | `Workor.aspx` | **Already in Infinity** (`order:create`, `order:b2b`, `patient:create`) |
| Batch-submit staged orders | `SubmitAllPatientsByMcc` | **PARTIAL/ASK** — is the `temp_*` staging step worth porting, or does Infinity's draft order cover it? |
| Referring-doctor master (client's own) | `Doctors.aspx` | **MISSING** |
| Referring-customer master (client's own) | `Customers.aspx` | **MISSING** |
| Material/consumable requisition | `mrf.aspx` | **MISSING** — real workflow, small table, self-contained |
| Help/support request + visit request | `hrf.aspx` | **MISSING** — and if ported it needs its own table, not the QC one |
| Edit a Sample-Sent order | link to `Worksheet\EditWorkOrder.aspx?id=<sid>&type=mcc`, enabled only when `status == 1` | **PARTIAL** — Infinity has `OrderDetail`; the "client may edit until we accession it" rule is the part to port |
| Scan samples inward | `Worksheet\Inward.aspx` (menu 55) | Already decided in P1: Infinity denies clients `order:accession`; lab to confirm |
| Test catalogue at the client's own rate | `Workor.TEST_PRICES` → `GetMccRateTypeId(pcc)` | **Already in Infinity** (Catalogue is in the client nav) |
| Change own password | `Admin_General\ChangePassword.aspx` (no gate — self-service) | **Already in Infinity** (`UserSettings`) |
| Client dashboard | `Admin_General\das-cli.aspx` | **Already in Infinity** (Dashboard) — but see §8 #3 |

## 5. Authentication, session, and what PCC_Id / Business_Unit_id actually do

### 5.1 One user table, one login page, plaintext passwords

Client-code accounts are rows in the **same `tbl_med_user_master`** as lab
staff. There is no separate portal, no separate credential store, no separate
login page.

`LoginClass.UserAuth` (`MedCis.Business\LoginClass.cs`):

```csharp
dt.tbl_med_user_masters.Where(c => c.Username == strUsername
                              && c.password == strPassword
                              && c.IsActive == true).FirstOrDefault();
```

**Passwords are stored and compared in plaintext.** `UserchangePassword`
writes the new value straight into the column. `web.config` sets
`<forms … passwordFormat="Clear">` for good measure. On success:
`FormsAuthentication.SetAuthCookie(username, false)`,
`Session["loginUser"] = GetLoginUserDetails(username)`, activity-log row,
redirect to `Default.aspx`.

`login.aspx.cs` also ships a **"remember me" that writes the password to a
plaintext cookie** (`Response.Cookies["pwd"]`, 15-day expiry) and reads it back
into the password box on load — `RememberMe.Checked = true` by default. In the
NOBLE copy the writer (`LoadRememberMe`) is defined but never called, so today
only the *reader* runs; any client whose browser still holds a `pwd` cookie from
an older build is auto-filling it.

Session: `<sessionState mode="InProc" timeout="30">`, forms timeout 120 with
sliding expiration, `<authorization><deny users="?"/></authorization>` app-wide
with one exception (`lbg.ashx`, the login background image). **So every
"ungated" page in §2 still requires *a* login — the exposure is
authenticated-but-unauthorised, i.e. any client can reach it.**

`Site2.Master` re-reads `Session["loginUser"]` on every non-postback and caches
the user type in **`static int usertypeId`** — a field shared by every
concurrent request in the worker process, and the value
`repMainMenu_ItemDataBound` uses to build the submenus. Under concurrency a
client can be served another user type's menu.

### 5.2 PCC_Id, sub_pcc_id, Business_Unit_id

`tbl_med_user_master` (from `Med.designer.cs` line 14972) carries:
`usertypeid`, `Username`, `password`, `Email`, `Phone`, `State`,
`Business_Unit_id`, `PCC_Id`, `sub_pcc_id`, `IsActive`, `employee_id`, plus two
associations to `tbl_med_mcc_unit_master`: `tbl_med_mcc_unit_master` (via
`PCC_Id`) and `tbl_med_mcc_unit_master1` (via `sub_pcc_id`).

- **`PCC_Id > 0` is what makes an account "a client login."** No page tests
  `usertypeid == 2|7|12` to decide client-ness; every one of them tests
  `PCC_Id > 0`. Usertype only decides which menu ids you hold.
  (`Workor.aspx.cs` 753/756 are the only two usertype literals in `Pcc\`:
  type 7 hides grid column 7, type 2 auto-opens the clinical-history modal.)
- **`sub_pcc_id`** = a franchise branch. When set, the effective code is
  `tbl_med_mcc_unit_master1.MCCUnitCode`, the client dropdown is pinned and
  disabled, the order total is hidden (`txtTotal.Visible = false`), and the
  balance label is hidden on the dashboard — a sub-client sees volume, not
  money. Critically, **billing and locking roll up to the parent**: the lock is
  evaluated on `PCC_Id`, and `RejectSample` refunds against
  `mccUser.PCC_Id`.
- **Roll-up in the other direction** is `tbl_med_mcc_unit_franchise_mapping`.
  A parent whose `tbl_med_mcc_unit_franchise_mappings.Count > 0` gets an
  **enabled** client dropdown filled by `FillComboPCCSUBPCC(PCC_Id)` = itself ∪
  its mapped children (`Utilities.cs`), so a franchise head office can switch
  between its branches on `SampleStatus` and `Workor`. This is the one
  legitimate case where a client sees more than one client code, and Infinity
  must model it (§9 Q6).
- **`Business_Unit_id`** is the lab branch. P1 measured 667 active client users
  carrying one. On the *reporting* screen it does nothing —
  `usp_pcc_samplestatus` takes no unit parameter and the paged variant that did
  is dead code. It bites on `Customers.aspx` / `Doctors.aspx` / `mrf.aspx`,
  where `FillCombo(ddl,"PCC", Business_Unit_id)` narrows the client list to
  `tbl_med_mcc_unit_master.BusinessUnitCode == Business_Unit_id` and
  `GetCustomers/GetDoctors(search, pccCode, bunit)` filters on both, and on
  `Inward.aspx` as F1 recorded. So P1's "both a client filter AND a unit
  filter" is true of the reference masters and inward, and **false of
  reporting** — worth knowing before someone ports a unit filter the reporting
  screen never had.

### 5.3 Online payments: CCAvenue live-ish, Razorpay dead

- **Razorpay: dead.** `checkout.aspx`, `razorCheckout.aspx` and
  `razorCallback.aspx` are all excluded from the release package, and NOBLE's
  `Payment.aspx.cs` has the Razorpay redirect commented out. In the source they
  carry **live keys in plaintext** (`rzp_live_WkPQZRp1nVK63k` + secret) and hold
  `orderId`/`email`/`phone`/`amount`/`ccode` in `public static` fields — process-wide
  shared state that would cross-contaminate concurrent payers. `razorCallback`
  credits `tbl_med_mcc_account_detail` + `sp_mcc_test_account_101` from
  `Session["loginUser"].PCC_Id` with an idempotency check on
  `chequeorddnummber`.
- **CCAvenue: partly live, partly orphaned.** `ccavRequestHandler.aspx`
  (working key `D2EBCBEA…`, access code `AVON85GE…` hard-coded) and
  `ccavResponse.aspx` **are** deployed, but nothing links to them: NOBLE's
  `Payment.aspx` instead does

  ```csharp
  Response.Redirect("https://noble.listec.in/ccavDefault.aspx?amount=" + txtAmount.Text
      + "&mc=" + PCC_Id + "&email=" + email + "&phone=" + mobile
      + "&city=" + … + "&zip=" + … + "&state=" + … + "&code=" + mcccode);
  ```

  — an **unsigned, unauthenticated GET to a separate site** carrying the client
  id, amount and contact details in the query string. `ccavDefault.aspx` is not
  in this tree; the `Razor\` project (`Default/Payment/Request/Response.aspx`)
  is its sibling and its `Response.aspx.cs` body is **entirely commented out**
  in this copy, with hard-coded `http://183.82.121.72:1082/…` redirects.
  Whether the deployed `noble.listec.in` copy is live is Role B Q7 — and
  `Payment.aspx`'s own `CheckUserPage(22)` is commented out, so *any*
  authenticated user can start a top-up.

### 5.4 `PrintBill` writes money on a GET

`PrintBill.aspx.cs` / `PrintBill.ashx.cs`, no gate of any kind:

```csharp
int patId  = Convert.ToInt32(Request.QueryString[0]);
string userName = Request.QueryString[1];
int amount = Convert.ToInt32(Request.QueryString[2]);
obj.patientid = patId; obj.paymode = "CASH"; obj.received_by = userName;
obj.received_date = DateTime.Now; obj.payment_refrence = "New"; obj.amount = amount;
dt.tbl_med_mcc_patient_billings.InsertOnSubmit(obj); dt.SubmitChanges();
```

A **GET** request from any authenticated user inserts a cash receipt against any
patient for any amount, attributed to any username, and returns the bill PDF.
`received_by` is taken from the URL, not from the session, so the audit trail is
attacker-chosen.

## 6. Where Infinity is already right, and what "client framing" still means

The substrate the brief measured is real and is the right shape: scope →
capability → lock → row, with out-of-scope returning 404 (`ReportPdfEndpoints`
`GateAsync`: `scopes.GetReportClientCodesAsync` → `NotFound()` on deny, then
`repo.GetBySidAsync(scope.ClientCodes, sid)`, then 423). `InfinityRoles` already
maps LIS usertypes 2 / 7 / 12 → `client`, and `UnrestrictedReporters`
deliberately excludes `client`. Filters (`SampleFilters.tsx`) are a strict
superset of `SampleStatus`'s except for TAT and test-code, and add PID, hour
bounds, business unit and department. Bulk PDF exists, which legacy never had.

What is *not* yet right is that a client is being shown the lab's application:
**Accessioning is in the client's nav and returns an empty queue** — correctly
scoped, but a lab screen with nothing in it, offered to an audience that has no
business accessioning. That is the client-framing gap, and it is cheaper to fix
than anything else in the table below.

## 7. THE GAP TABLE — legacy capability → Infinity status → what building it takes

This is the build brief. "WORKS, measured" means measured against Infinity
staging with the DL0214 client login on 2026-08-17 and needs no build.
Effort notes name the concrete artefacts, in the SQL → API → UI order the
ground rules require.

| # | Legacy capability | Legacy source | Infinity status | What building it would take |
|---|---|---|---|---|
| G1 | Sign in with an LIS client-code account, land on a client-appropriate home | `login.aspx` → `Default.aspx` → `das-cli.aspx` | **WORKS, measured** | Nothing. `InfinityRoles.LisUsertypeMap` already maps usertypes 2/7/12 → `client`. |
| G2 | Report worklist scoped to own client code(s) | `SampleStatus.aspx` + `usp_pcc_samplestatus` | **WORKS, measured** (1,233 rows, 1 centre) | Nothing for the base case. See G3/G4 for the edges. |
| G3 | Franchise parent sees self ∪ mapped sub-franchises | `FillComboPCCSUBPCC` + `tbl_med_mcc_unit_franchise_mapping` | **MISSING** (measured scope was "1 centres") | `ScopeRepository.GetReportClientCodesAsync` gains a recursive/1-level union over `tbl_med_mcc_unit_franchise_mapping` where the caller's `PCC_Id` is the parent. Derived server-side from the caller's user row only — never from a posted code. One SQL change + a scope unit test per Role D's escape-attempt suite. |
| G4 | Sub-client (`sub_pcc_id`) sees its own branch code, not the parent's | `SampleStatus` lines 209–212 | **UNKNOWN — verify before building** | The measured login was a plain `PCC_Id` client. Confirm whether Infinity's scope resolver reads `sub_pcc_id` at all; if it resolves on `PCC_Id` only, every sub-client sees the parent's whole book. One-line check, potentially a one-line fix, but it is a cross-client leak if wrong. |
| G5 | Filter by SID / patient / PID / date / status / department | `SampleStatus` filter row | **WORKS, measured** — Infinity is a superset (adds hour bounds, business unit, test) | Nothing. |
| G6 | Filter by test code and by TAT breach | `txtTestcode`, `chkTat` → `@testcode`, `@TAT` | **PARTIAL** — Infinity filters by test; no TAT-breach toggle | Add a TAT predicate to the reporting read proc and one checkbox to `SampleFilters`. Needs the lab's TAT definition first (the legacy one lives inside `usp_pcc_samplestatus`, Role B Q1). |
| G7 | SID search that ignores the date window | — (legacy ANDs them, quirk #18) | **VERIFY** | Confirm Infinity's SID search is date-independent; if not, drop the date predicate when an exact SID is supplied. |
| G8 | Open one report inline | `WebForm2?sid=&type=VAIL` → `ex.rpt` | **WORKS, measured** (200) | Nothing. |
| G9 | Download one report PDF | `WebForm2.Button2/3` | **WORKS, measured** (200, `application/pdf`, ~1.7 MB) | Nothing. |
| G10 | Letterhead / no-letterhead toggle on the PDF | `ex.rpt` parameter 1 (`Button2`=false, `Button3`=true) | **UNKNOWN — verify** | Check whether `/reports/{sid}/pdf` exposes a header flag. Collection centres print on their own stationery; losing the plain variant would be a visible regression. If absent: one query-string flag through `ReportPdfEndpoints` → the renderer, one toggle in `ReportViewer`. |
| G11 | Patient-level combined report (all authorised samples of one patient in one document) | `WebForm2?type=PAT` → `ex2.rpt`, samples `sample_status >= 7` | **MISSING** | New read (`SELECT vailid … WHERE patient_id = @pid AND sample_status >= 7`, scope-gated), a merge in the PDF renderer, and a PID-level action on the worklist. The bulk endpoint is close but concatenates by SID list, not by patient. |
| G12 | Download several reports at once | *legacy has none* | **WORKS — Infinity is ahead** (`POST /reports/pdf/bulk`, per-SID gating, `skipped` list) | Nothing. Record it so no one "restores parity" downward. |
| G13 | Un-authorised / partial results must not be offered | `Sta` from the proc + `sampleStatus <= 6` in `dlVailStatus_ItemDataBound` | **PARTIAL — enforced client-side only in legacy** | Infinity must gate on the SERVER: a status below the release threshold returns 404/409 on `/reports/{sid}/pdf`, not merely a disabled link. Confirm the current gate; if it is only a list filter, add it to `GateAsync` alongside scope and lock. |
| G14 | Any-SID report access must fail | `WebForm2` renders on scope-check FAILURE (§3.6) | **WORKS, measured** — Infinity 404s out-of-scope before existence | Nothing to build. Add an explicit Role D probe: client login requests a foreign SID's PDF, expect 404 (not 403, not 200). |
| G15 | Report blocked when the centre's account is locked | `GetMccStatus` / `GetMccStatusByMccId100` | **PARTIAL — predicate mismatch** | Infinity returns 423 on a balance lock. Legacy's rule is `PerminentUnlock OR currentbalance > 0 OR (creditlimit < 0 AND creditlimit < currentbalance) OR unexpired tbl_med_mcc_lockunlock`. Reconcile: read the three inputs (`mcc_unit_master.PerminentUnlock`, `.creditlimit`, `mcc_account_master.currentbalance`, `mcc_lockunlock.expire_unlock`) in `ReportLockRepository` and match the legacy set (Role B Q4). A sub-client must be judged on its PARENT. |
| G16 | Downloading marks the sample Printed (6→8, 7→9) | `ChangeSampleStatus` | **MISSING** | A `usp_inf_report_mark_printed` that transitions 6→8 / 7→9 only, writes an `inf_result_audit`-pattern row (actor, ip, old, new), and is called from the download route AFTER a successful render, in one transaction. Do not fire on a failed render — legacy does. |
| G17 | Audit of who downloaded which report | `GetUserLog(…, "Printed …")` → `sp_user_activity_log` | **PARTIAL/UNKNOWN** | If Infinity does not already log report downloads, add an append-only audit row per download (actor, sid, ip, variant). Cheap, and it is the only forensic trail the legacy portal has. |
| G18 | Email a report PDF to an address the client types | `WebForm2.Button4` | **MISSING — and ASK before building** | Needs SMTP config, a template, recipient logging (legacy logs none), and a lab decision about client-initiated egress of PHI. Do not build on a reading of the old code; put it to the lab. |
| G19 | Culture & sensitivity report | `WebForm2?type=CS` → `cs.rpt` | **MISSING — ASK (F7 micro)** | Gated on F7. P1's Role B found micro configured but effectively unused; confirm before any build. |
| G20 | Allergy report | `type=ALG` routed but never rendered | **SHOULD NOT PORT** | Dead in the legacy code path and dead in the data (plan §1: 172,982 historic rows, 0 samples in 90d). Record in the decision log. |
| G21 | Download a patient's clinical-history PDF | `Worksheet\clihis.ashx?id=<sid>` | **MISSING** | Reuse the attachments feature's pattern: scope-gated read of `tbl_med_mcc_patient_clinicaldata WHERE filene=@sid AND filetype='HISTORY'`, magic-byte validation on the way out, correct Content-Type and honest filename. **Must** filter on `filetype` or it will serve QR PNGs (quirk #27). |
| G22 | Upload a clinical-history PDF against a SID | `SampleStatus.btnUpload_Click` | **MISSING** | The attachments repository already exists (`AttachmentRepository.cs`); add a client-scoped write path, magic bytes not extension, size cap, and replace-semantics that actually replace (quirk #14). Needs a lab decision on whether clients may attach at all. |
| G23 | Excel export of the worklist | `SampleStatus.btnPrint_Click` | **MISSING** | A real CSV/XLSX from the same scoped read, correct Content-Type, honest extension, row cap. Legacy's is HTML-as-`.xls` and only works on one status filter — build it right, not the same. |
| G24 | Sample status / where-is-my-sample, with the transit legs | status column + `tbl_acc_inward_sample_tracking` (F1) | **PARTIAL** | Infinity's worklist shows status. Surfacing F1's scan legs to a client is a small read on top of the P1 work: scope-gated `SELECT` over the tracking table by SID, rendered as a timeline. Cheap, and it is the question clients actually ring the lab about. |
| G25 | Account balance and ledger | dashboard label + `Admin_General\Accounts` | **WORKS, measured** (own account only) | Nothing. |
| G26 | Online top-up (CCAvenue) | `Payment.aspx` → `noble.listec.in/ccavDefault.aspx` | **MISSING — decide first (Role B Q7)** | If live: a signed server-to-server integration with idempotency on the gateway reference, credit written through one audited path, and keys in configuration, not source. If dead: DROP, and rotate the keys that are in the repository. Do not port the unsigned query-string redirect under any circumstance. |
| G27 | Bill / receipt PDF for a patient | `PrintBill.aspx/.ashx` | **SHOULD NOT PORT as written** | Infinity has `PrintInvoice`. The legacy handler's *write* (a cash receipt from the URL) must never be reproduced; the *read* is already covered. |
| G28 | Raise a work order, register a patient, pick tests at the client's own rate | `Workor.aspx` | **WORKS, measured** (`order:create`, `order:b2b`, `patient:create`, Catalogue in nav) | Field-by-field parity against §2.4's union is still owed: MRN, SRF/order number, sample date+hour+minute, referring doctor/customer as dropdown **or** free text, client-typed SID per sample row, clinical-history text and PDF. Each missing field is a small `NewOrder` addition. |
| G29 | Stage an order and batch-promote it later | `temp_med_mcc_patient_*` + `SubmitAllPatientsByMcc` | **PARTIAL — ASK** | Decide whether Infinity's draft order covers it. If the lab relies on "type ten patients, submit once", it is a batch action over existing draft orders, not a new table. |
| G30 | Edit an order until the lab accessions it | `SampleStatus` → `EditWorkOrder.aspx?id=&type=mcc`, link enabled only when `status == 1` | **PARTIAL** | Infinity has `OrderDetail`. Port the RULE: a client may edit only while `sample_status = 1`, and only within scope. Note the legacy target's own gate is commented out (quirk #2 class). |
| G31 | Client's own referring-doctor master | `Doctors.aspx` (menu 24) | **MISSING** | CRUD over `tbl_med_mcc_doctor` scoped by `PCC_Id` **and** `Business_Unit_id` (legacy filters on both). Small proc + endpoint + screen. Gate on Role B Q13 — if orders mostly use the free-text fallback, drop it. |
| G32 | Client's own referring-customer master | `Customers.aspx` (menu 23) | **MISSING** | Identical shape over `tbl_med_mcc_customer`. Same Role B gate. |
| G33 | Material/consumable requisition to the lab | `mrf.aspx` (menu 46) | **MISSING** | `tbl_inventory_client_request_master` + `_form` already exist and hold real columns. Client raises + tracks; lab approves, issues, sets barcode range and courier/docket. Split the `"courier|docket"` composite into two columns on the way. Gate on Role B Q12. |
| G34 | Help / visit request to the lab | `hrf.aspx` (menu 47) | **MISSING** | Worth porting as a workflow, **not** as a schema: give it its own table instead of the repurposed QC one (quirk #24). Gate on Role B Q12. |
| G35 | Dispatch / courier docket tracking | `CourierStatus.aspx` (menu 44) | **SHOULD NOT PORT** | Plan §1 records 11 rows ever. Confirm (Role B Q14) and close it in the decision log. |
| G36 | WhatsApp send harness | `wa.aspx` | **SHOULD NOT PORT** | Scaffolding with a hard-coded phone number, shipped to production. DROP. |
| G37 | Change own password | `ChangePassword.aspx` | **WORKS** (`UserSettings`) | Parity proof owed per gate 3, nothing else. |
| G38 | Client dashboard | `das-cli.aspx` | **WORKS** (Dashboard in the client nav) | Chart-level parity proof owed; `das-cli` has no gate and a `static` client code, so parity means "the numbers", not "the code". |
| G39 | **Do not show clients lab screens** | — (legacy shows them far worse) | **FIX in Infinity** | Remove `Accessioning` from the client nav and deny the route for `client` (it already returns zero rows — this is framing, not scope). Cheapest item in the table and the most visible to the audience. |
| G40 | Client-code accounts must not reach lab billing / client-master / MIS screens | quirks #2, #3 — all deployed and reachable today | **N/A in Infinity (no equivalent pages exposed) — but VERIFY** | Role D should sweep every Infinity route with a `client` token and assert 403/404 on each. The legacy failure mode was *commented-out gates*, which no test would have caught; the equivalent risk here is a route added without a capability. |

## 8. KEEP / FIX register

Ordered by severity, with the cross-client and commercial leaks first, as
asked.

| # | Behaviour | Verdict | Justification |
|---|---|---|---|
| 1 | **`WebForm2` renders any SID's report when the scope check FAILS** (§3.6) — inverted branch; also bypasses the account lock and covers every sub-client's own reads | **FIX (critical)** | Cross-client PHI disclosure through the portal's primary screen. Infinity already does this correctly (scope → 404); the contract records it so no one "restores parity" by copying the branch. |
| 2 | **`Billing\Bill.aspx`, `Billx.aspx`, `Dues.aspx`, `DueReport.aspx`, `Billreceipts.aspx` have their `CheckUserPage` commented out or absent, and are deployed** | **FIX (critical)** | Same class as the rate-list leak just fixed, larger blast radius: `Dues`/`DueReport` are every client's outstanding balance, `Bill` is the lab-wide billing worklist, `Billx?id=<pid>` is any patient's itemised bill — and `SampleStatus` still carries a (hidden) link to `Billx`. Any client login reaches all five today. |
| 3 | **`Admin_General\MccUnit_Master.aspx` gate commented out**; `das-adm.aspx`, `das-fin.aspx`, `frm_mcc_franchise_mapping.aspx` have none; `Sales\mis_active.aspx` commented out; `Downloads\index|general.aspx` commented out | **FIX (critical)** | `MccUnit_Master` is the client master — every centre's rate type, credit limit and lock state. `das-fin` is the finance dashboard. All deployed, all reachable by a client login. |
| 4 | **`FillCombo(ddl, "PCC")` loads EVERY `tbl_med_mcc_unit_master` row** (active and inactive) into the dropdown, then selects the caller's and sets `Enabled=false` | **FIX** | `disabled` is a rendering attribute. The complete client roster of the lab ships in the HTML of every Pcc page a client opens. Infinity's filter feed already returns only the caller's codes — keep it that way. |
| 5 | **`report_handler.ashx`, `Worksheet\clihis.ashx`, `g.aspx` serve report / clinical-history PDFs with no permission and no scope check** | **FIX (critical)** | Enumerable by SID by any authenticated user. `report_handler` additionally embeds a production connection string with credentials in source (line 78). |
| 6 | **`PrintBill.aspx` / `.ashx` insert a CASH receipt from query-string parameters on a GET, with `received_by` taken from the URL** (§5.4) | **FIX (critical)** | Financial write with no auth, no CSRF, no idempotency and a forgeable actor. Do not port the write at all; Infinity's `PaymentCapture` path is the only way money moves. |
| 7 | **Menu-id namespace is reused across modules** (§2.3): id 25 = client work order *and* `EditSample_Master`; id 46 = client MRF *and* lab billing | **FIX** | A permission model where granting a client one screen grants a lab screen cannot be ported as-is. F4 (permission governance) should treat this as the concrete requirement: capabilities, not shared integers. |
| 8 | **`CheckUserPage` ignores the `_read`/`write`/`_delete` bits and runs only on `!IsPostBack`** | **KEEP as fact → F4** | Same finding as F1 #16/#17. Record it; do not invent bit semantics the LIS never enforced. Infinity checks capability per request already. |
| 9 | **`Site2.Master.usertypeId` and `das-cli.currentClientCode` are `static`; `razorCheckout` uses `public static` for order id / email / amount** | **FIX** | Process-wide mutable state on a per-user value. Under concurrency it serves one user's menu (or payment context) to another. |
| 10 | **Passwords are plaintext in `tbl_med_user_master.password`; `login.aspx` reads a plaintext `pwd` cookie into the password box** | **FIX** | Shared credential store with lab staff; a client-portal breach is a lab breach. The cookie *writer* is already dead — remove the reader too. |
| 11 | **`ChangeSampleStatus` on download: 6→8, 7→9** — a client opening a PDF advances the lab's sample status to Printed | **KEEP (semantics), FIX (mechanics)** | "Printed" genuinely means "the client has it", and the lab reads this status. But it must be an audited state transition (actor, old, new — ground rule 6), not a side effect of rendering a document, and it must not fire when the render fails. |
| 12 | **`WebForm2.Button4` emails a report PDF to a free-text address typed by the client**, over a shared SMTP account, with no confirmation and no record of the recipient | **FIX / ASK** | Only `"Printed <from>-<to>"` is logged — the destination address is never stored, so an exfiltrated report leaves no trace of where it went. If the lab wants client-initiated email, it needs recipient logging and a confirmation step. |
| 13 | **`SampleStatus.btnUpload_Click` accepts a client PDF by `Path.GetExtension(...) == ".pdf"` only** | **FIX** | Extension, not magic bytes; no size cap (ground rule 7). |
| 14 | **Replacing an existing clinical history silently loses the new file** | **FIX** | `cldata` is re-fetched, `DeleteOnSubmit`+`SubmitChanges`, then the *deleted* entity is mutated; because its `id != 0` the insert is skipped, so `SubmitChanges` writes nothing. Unticking the box instead creates a duplicate row. |
| 15 | **`Sta` (report link enabled) is computed in the proc and enforced only in the grid** | **FIX** | Presentation is not a permission. Whatever "authorised enough to release" means, the *server* must enforce it on the render/download route. Infinity's `report:release` / status gate is the right home. |
| 16 | **The Excel export only ever contains rows when the status filter is "Sample Sent"** | **FIX** | `gvExport.DataBind()` sits inside the `status == 1` branch only. Exporting any other view yields an empty file with no error. |
| 17 | **HTML rendered as `application/vnd.ms-excel` named `MCC_ORDER_LIST.xls`, no size cap** | **FIX** | Same as F1 #19; ground rule 7. |
| 18 | **Date window `00:00:01`–`23:59:59`, always ANDed with the SID search** | **FIX** | Same as F1 #14. An exact SID lookup should not be silenced by a date default. Infinity's filters already default sensibly; keep SID search date-independent. |
| 19 | **`Convert.ToInt32(txtRegNo.Text)` / `Convert.ToDateTime(txtFdate.Text)` with no `TryParse`; the whole of `LoadGrid` wrapped in `catch { lblMsg.Text = ".."; }`** | **FIX** | Every failure — bad date, non-numeric PID, dead proc, locked account — surfaces to the client as two dots. |
| 20 | **The account lock is a prepaid-balance / credit-line check, not a per-bill check; a sub-client is locked by its parent's balance** | **KEEP** | This is the commercial arrangement the lab actually operates. Infinity's 423 must be reconciled to it, not the other way round (§9 Q4). |
| 21 | **Franchise parents get an ENABLED client dropdown covering self ∪ mapped children** | **KEEP** | Legitimate multi-code visibility. Infinity's scope resolution must express it, and must derive the set server-side from `tbl_med_mcc_unit_franchise_mapping` — never from a posted dropdown value. |
| 22 | **Client-typed SIDs on the work order** (`txtVailId` per sample row, `sample_status = 1`) | **KEEP** | Collection centres pre-barcode. This is what F1's "no-workorder scan" orphans later adopt. |
| 23 | **Orders stage through `temp_med_mcc_patient_*` and are promoted in a batch by `SubmitAllPatientsByMcc`** | **KEEP (as a fact) → ASK** | It is the legacy draft mechanism. Whether Infinity's order model needs an equivalent is a design question, not a defect. |
| 24 | **`hrf.aspx` stores help-desk tickets in `tbl_technical_dc_reconstitutional`, a QC table, via repurposed columns** | **FIX if ported** | Porting the workflow is reasonable; porting the column abuse is not. New table, or don't build it. |
| 25 | **`wa.aspx`** — WhatsApp send harness with a hard-coded phone number, deployed, ungated | **DROP** | Scaffolding shipped to production. |
| 26 | **`autotext.asmx`** exposes the full test / profile / master-profile code list to any authenticated caller | **KEEP, low** | The catalogue is already in the client nav in Infinity; codes are not commercially sensitive on their own. Note it so it is not mistaken for a leak later. |
| 27 | **`Enc.GenerateQRCode` writes QR images into `tbl_med_mcc_patient_clinicaldata` with `filene = "QRCODE"`, `filetype = <vailid>`** — the same table clinical history uses with the fields swapped | **FIX** | Two record types distinguished by which column holds which value. Any port must read `filene`/`filetype` exactly as legacy does or it will serve QR PNGs as clinical history. |
| 28 | **`Accessioning` appears in the client nav in Infinity and returns an empty queue** | **FIX** | Correctly scoped, wrongly offered. A client should not be shown a lab queue; §6. |

## 9. OPEN QUESTIONS for Role B (settle from production data)

1. **`usp_pcc_samplestatus` — dump the body.** It is the single most important
   object in this feature and it is not in the source tree. Specifically:
   (a) how is `Sta` computed — is it `sample_status >= 7`? (b) how is `Micro`
   computed? (c) does `@mccId` match `MCCUnitCode` exactly, or `LIKE`? (d) does
   `@mccId = '0'` really mean "all clients"? (e) does it filter by
   business unit anywhere internally? (f) does it join sub-franchises?
   Also dump `USP_SAMPLE_WORKSHEET` for comparison, and confirm nothing else
   (trigger, job, second app) writes `tbl_med_mcc_patient_report`.
2. **Menu grants.** `SELECT menuid, usertype, _read, write, _delete FROM
   tbl_med_security_master WHERE menuid IN (22,23,24,25,26,27,44,46,47)`
   joined to `tbl_med_usertype` — exactly which usertypes hold each, and do
   types 2 / 7 / 12 hold anything outside that set? Cross-check against
   `tbl_med_menu_master` for `page_title` / `page_url` / `is_title` / `order`
   on those ids.
3. **Which page is menu 25?** `tbl_med_menu_master` `page_url` for id 25 —
   `Pcc/Workor.aspx`, `PatientWorkOrder.aspx` or `WebForm1.aspx`? The package
   ships all three and nothing links to any of them; only this row decides.
   Confirm the four excluded forks are absent from `page_url` entirely.
4. **The lock, quantified.** How many `tbl_med_mcc_unit_master` rows have
   `PerminentUnlock = 1`? Distribution of `creditlimit` (how many negative,
   i.e. genuine credit lines)? How many centres are locked right now by
   `GetMccStatus`'s predicate? How many rows in `tbl_med_mcc_lockunlock` and
   how many unexpired? **Does Infinity's 423 predicate select the same set of
   centres today?** — this is the reconciliation that decides whether the port
   changes anyone's commercial terms.
5. **Client logins, active and real.** How many `tbl_med_user_master` rows have
   `PCC_Id > 0 AND IsActive = 1`? How many by `usertypeid` (2 / 7 / 12 /
   other)? How many have `sub_pcc_id` set? How many appear in
   `TBL_MED_USER_ACTIVITY_LOG` with a `LogIn` row in the last 30 / 90 days —
   i.e. how much of the portal is genuinely used, and by whom?
6. **Franchise roll-up.** Row count and shape of
   `tbl_med_mcc_unit_franchise_mapping`; how many parents have children; do any
   children have children; do any client users sit on a parent code whose
   mapping set is non-empty (these are the accounts that legitimately see more
   than one client code)? Do any `sub_pcc_id` users also carry a `PCC_Id`
   pointing at a *different* parent than their sub-code's mapping?
7. **Are online payments live?** Count and date range of
   `tbl_med_mcc_account_detail` rows with `deposittype IN (5, 8)` (Razorpay's
   `5` / CCAvenue's `8`) or `Reason LIKE 'RazorPay%'`; last such row. And is
   `https://noble.listec.in/ccavDefault.aspx` still serving? If the last
   online payment is years old, `Payment.aspx` + both gateways are a DROP and
   the hard-coded live keys are a credential-rotation ticket, not a build.
8. **Report download volume.** From `TBL_MED_USER_ACTIVITY_LOG`, count rows
   where `FUNCTION_PERFORMED LIKE 'Printed%'` in 90d, split by whether the user
   has `PCC_Id > 0` — how much reporting traffic is actually *client* traffic?
   And count `'UnAthorized Printing Access%'` rows: those are locked clients
   hitting the report viewer, which sizes the lock's real-world impact.
9. **Has the IDOR been exercised?** `tbl_med_mcc_patient_report` /
   activity-log rows where the acting user's `PCC_Id` does not match the
   sample's `mcc_code`. A non-zero count is an incident, not a finding.
10. **`tbl_med_mcc_patient_report` cache.** Row count, size on disk, how many
    SIDs have a cached PDF vs render-on-demand, and whether the cached PDF is
    ever invalidated when results are amended (the code never deletes one).
11. **Clinical history from clients.** Rows in
    `tbl_med_mcc_patient_clinicaldata` with `filetype = 'HISTORY'` — how many,
    added by whom (client vs lab), and how many duplicate `filene` values
    (quirk #14's duplicate path)? Separately, how many `filene = 'QRCODE'`
    rows, for sizing.
12. **MRF and HRF liveness.** Row counts and 90-day activity for
    `tbl_inventory_client_request_master` / `_form`, and for
    `tbl_technical_dc_reconstitutional` rows whose `control_name` starts with
    `T|` or `G|` (the HRF discriminator) vs genuine QC rows. These decide
    whether §4's two MISSING workflows are worth building.
13. **Customers and doctors.** Row counts in `tbl_med_mcc_customer` /
    `tbl_med_mcc_doctor` grouped by client code, and how many orders in 90d
    actually reference `ref_doctor` / `ref_customer` (vs the free-text
    `ref_doctor_other` / `ref_customer_other` fallbacks) — this decides whether
    the two client-owned masters are a port or a drop.
14. **CourierStatus.** Confirm the plan's "11 rows ever" against the current
    table, and check whether any of them are recent. If confirmed, DROP it in
    this phase's decision-log entry.
15. **Staged orders.** Row counts and age distribution in
    `temp_med_mcc_patient_master` / `_sample` / `_test` — are there abandoned
    drafts sitting there, and how long do real ones live before
    `SubmitAllPatientsByMcc` promotes them?

---
*Role A, F6 (client portal, reporting half), 2026-08-17. Sources: the NOBLE
deployed tree and its `obj\Release\Package\PackageTmp` manifest (authoritative),
diffed against the dev tree and the nested `NOBLE\NOBLE\` backup; all paths
under `E:\Listec Genomics`. No `E:\` file was modified; no database was queried.*
