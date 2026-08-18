# F3 — Outstanding balances / dues: behaviour contract

Role A (legacy analyst) output for Phase P2 of the port plan
(`docs/agent-port-plan.md`). Legacy pages: `Billing\Dues.aspx` and
`Billing\DueReport.aspx`. Everything here is read from code; claims that only
production data can settle are collected in §13 (open questions) for Role B.

**Headline.** F3 is not one feature, it is *three money surfaces the LIS never
reconciled with each other*:

| # | "Due" | Where it lives | Who shows it |
|---|---|---|---|
| A | **Client wallet** — a running account per collection centre | `tbl_med_mcc_account_master.currentbalance` (stored, mutated in place) | Mcc_Account, LockUnlock, das-cli, Ledger reports |
| B | **B2C patient due, model 2** — derived | `SUM(tbl_med_mcc_patient_test.test_rate) − SUM(tbl_med_mcc_patient_billing.amount)` | **Dues.aspx**, Billx.aspx |
| C | **B2C patient due, model 1** — stored | `tbl_billing_patient_detail.Balance` / `amount_paid` | Bill.aspx, and **Infinity's 423 report lock** |

Dues.aspx reports **only B**. Infinity's report lock enforces **C** and **A**.
Nothing in either system reconciles B against C. That is the single most
important fact in this document.

---

## 1. Source files and which copy is authoritative

Unlike F1, **the NOBLE tree is NOT ahead here.** Verified by md5 across all
copies:

| File | Copies | Verdict |
|---|---|---|
| `MedCis.UI\Billing\Dues.aspx(.cs/.designer.cs)` | dev, `NOBLE\`, `NOBLE\NOBLE\` | **byte-identical** (`40694e51…`, `c3838e79…`, `c44a4a72…`) |
| `MedCis.UI\Billing\DueReport.aspx(.cs/.designer.cs)` | dev, `NOBLE\`, `NOBLE\NOBLE\` | **byte-identical** (`e24b0915…`, `df5fff34…`, `f6043603…`) |
| `Payment\Billing\Dues.aspx(.cs)` + `DueReport` | dev, `NOBLE\`, `NOBLE\NOBLE\` | a **separate ASP.NET project** (`namespace Payment.Billing`). Diffed line by line: identical logic, differs only in namespace, `using` order and whitespace. Not a second version — a copy-paste fork of the whole Billing folder. |
| `MedCis.Business\Utilities.cs` | NOBLE differs from dev | NOBLE authoritative — one caption only (`"--Select Client--"` vs `"--Select PCC--"`, line 241). |
| `MedCis.UI\razor_update.asmx(.cs)` | **NOBLE only** | NOBLE authoritative. Does not exist in the dev tree at all. **It writes a client balance** (§9.6). |

Citations below are to
`E:\Listec Genomics\NOBLE\MedCis.UI\…` / `…\NOBLE\MedCis.Business\…`.

**Deployment proof.** Both pages are present in the built package
`NOBLE\MedCis.UI\obj\Release\Package\PackageTmp\Billing\` — as are
`Pcc\PrintBill.aspx`, `Pcc\PrintBill.ashx` and root `razor_update.asmx`, the
three unguarded money writers in §9.

Everything is LINQ-to-SQL (`MedDataContext`). **There is no hand-built SQL
string anywhere in F3**, so the unparameterised-SQL FIX class from P1 does not
apply. Raw database objects touched: `dbo.sp_mcc_test_account_101`,
`dbo.sp_user_activity_log`, and two procedures the pages *declare but never
call* — `usp_bill_due_report`, `usp_bill_due_summary` (§7.4).

---

## 2. Access control — both pages are effectively ungated

```csharp
// Dues.aspx.cs 26-27 and DueReport.aspx.cs 24-25 — IDENTICAL, both commented out
//bool isAuth = utl.CheckUserPage(88, Convert.ToInt32(((tbl_med_user_master)Session["loginUser"]).usertypeid));
//if (isAuth == false) Response.Redirect("~/Error.aspx?id=Billing");
```

- **No page permission check.** The intended id was **88**. It is commented out
  on both pages. Any authenticated user who reaches the URL gets the page.
- The only gate is the app-wide `<deny users="?"/>` in
  `MedCis.UI\Web.config` 103-105 plus `Site2.Master.cs` 15-40, which only
  establishes `Session["loginUser"]` and builds the menu.
- **Nothing in the entire tree links to either page** — a tree-wide
  `grep -rin "Dues\.aspx\|DueReport\.aspx"` returns only the pages' own
  `@Page` directives and the publish profiles. Reachability is therefore
  entirely a function of `tbl_med_menu_master`/`tbl_med_security_master` rows
  (data → Role B Q1) or of somebody knowing the URL.
- For reference, the pages that *do* check: `Mcc_Account.aspx.cs` 21 uses
  `CheckUserPage(18, …)`, `LockUnlock_MCC.aspx.cs` 17 uses `21`.
- `CheckUserPage` itself (`Utilities.cs` 1221-1232) is a **row-presence check**
  — the `_read`/`write`/`_delete` bits on `tbl_med_security_master` are ignored,
  same as F1.

**There is no client scoping on either page.** See §4.1 / §5.1: the client
dropdown is read into a local `int MCC` and then **never used in the query**.
A collection-centre (PCC) user who opens Dues.aspx sees every patient of every
client — name, age, mobile number, referring doctor, charges, payments.

---

## 3. Tables and procedures F3 touches

From `NOBLE\MediCis.DAL\Med.dbml`.

```
dbo.tbl_med_mcc_account_master            (dbml 109-119)   -- the client wallet
  id              int identity PK
  mcccode         int        NULL   -> tbl_med_mcc_unit_master.id
  totaldeposited  int        NULL
  currentbalance  int        NULL   -- NEGATIVE = client owes the lab
  lastupdatedby   nvarchar(50) NULL -- never written by any code in the tree
  lastupdateddate datetime   NULL   -- never written by any code in the tree

dbo.tbl_med_mcc_account_detail            (dbml 91-108)    -- manual movements
  id, mcccode
  credittype       int  -- 1 Payment, 2 Credit, 3 Debit   (enum CREDIT_TYPE, MccAccountClass 435-438)
  deposittype      int  -- 1 DD, 2 Cheque, 3 Cash, 4 NEFT/iNet/Transfer,
                        --  5 Online, 6 Other, 7 Reject   (MccAccountClass 314-332)
  depositedate, amount(int), chequeorddnummber, Reason
  addedby, addeddate, updatedby, updatedate
  debit_flag       bit  -- *** "this PAYMENT has been marked inactive" ***, NOT a direction

dbo.tbl_med_mcc_test_transactions         (dbml 269-284)   -- the CHARGE ledger
  id, mccid, transdate
  currentbalance decimal(16,2)  -- balance BEFORE
  testcharges    decimal(16,2)
  closingbalance decimal(16,2)  -- balance AFTER
  userid, tname, vailid, patientid, description(=sub-franchise code)

dbo.tbl_med_mcc_patient_billing           (dbml 1186-1198) -- B2C receipts, model 2
  id, patientid, paymode varchar(50), amount int,
  payment_refrence varchar(200), remarks, received_by varchar(50), received_date

dbo.tbl_med_mcc_patient_test              (dbml 240-257)   -- B2C charges, model 2
  id, patient_id, test_id, test_code, test_name, test_rate int,
  test_type ('Test'|'Profile'|'Master'), amount_checked bit, updateddate, …

dbo.tbl_med_mcc_lockunlock                (dbml 181-194)   -- temporary unlock
  id, mcc_code, datetime_unlock, number_of_hours, expire_unlock, added*/updated*

dbo.tbl_med_mcc_unit_master               (dbml …989-990)
  creditlimit      int  NULL   -- stored NEGATIVE: -2500 = "may owe up to 2500"
  PerminentUnlock  bit  NULL   -- overrides every lock rule
  IsActive         bit         -- flipped automatically by SaveAccount (§9.1)
```

Procedures (signatures from `Med.dbml`):

```
dbo.sp_mcc_test_account_101(                                   -- dbml 1714-1726
    USERID int, MCCID int, TDATE datetime,
    CBALANCE int, TESTCHARGES int, CLOSINGBALANCE int,
    tname nvarchar(100), vailid nvarchar(50), patientid int,
    SUBFRANCHISE nvarchar(50)) RETURNS int
-- Body lives only in the DB (Role B Q2). Every call site treats it as
-- "append a row to tbl_med_mcc_test_transactions". NOTHING in the tree relies
-- on it changing currentbalance -- every caller does that itself in C#.
-- Note the money params are INT: this ledger cannot express paise.

dbo.usp_bill_due_report(FDATE, TDATE, BILL varchar(100), MOBILE varchar(20),
    MCC int, RECEIVEDBY varchar(50), type varchar(1))          -- dbml 2200-2220
    -> id, bill, billdate, name, rectype, age, RefDoctor,
       TestCharges, AmountPaid, Discount, Balance, url
dbo.usp_bill_due_summary(FDATE, TDATE) -> Employee, Amount     -- dbml 2266-2273
```

Both `usp_bill_due_*` are **called nowhere** — the calls are commented out on
both pages (`Dues.aspx.cs` 61, 149; `DueReport.aspx.cs` 59, 115). They are the
*intended* implementation of F3, abandoned in favour of the inline LINQ.
Their result shapes are the best statement of what the lab originally wanted:
note `Balance` and `Discount` as first-class columns and a `rectype`
discriminator that the LINQ has no equivalent of.

---

## 4. `Dues.aspx` — the patient-dues worklist

### 4.1 UI fields (all one filter row; **no validators anywhere on the page**)

| Control | Type | Behaviour |
|---|---|---|
| `ddlSearchMcc` | DropDownList, `AutoPostBack=True`, **no handler** | Filled by `FillCombo(ddl,"PCC")` (`Utilities.cs` 227-243): every `tbl_med_mcc_unit_master` ordered by `MCCUnitCode`, **no `IsActive` filter**, value = `id`, item 0 = `--Select Client--`. Read into `int MCC` at `Dues.aspx.cs` 49-50 and **never referenced again**. AutoPostBack with no `SelectedIndexChanged` handler → posts back and re-renders the *stale* grid (Page_Load only loads on `!IsPostBack`). |
| `txtBill` | TextBox + Watermark "Bill#" + `FilteredTextBoxExtender FilterType="Numbers"` | Exact match against `tbl_med_mcc_patient_master.order_number` (a **string** column). Sentinel `"0"` = no filter, so **searching for bill number `0` is impossible**. |
| `txtMobile` | TextBox, MaxLength 100, watermark "Mobile" | Exact match on `mobile_number`. Same `"0"` sentinel. No numeric filter despite the name. |
| `txtFdate` / `txtTdate` | TextBox + `CalendarExtender Format="dd/MM/yyyy"`, MaxLength 10 | Default = today (both), set with `DateTime.Now.ToShortDateString()` (**server culture**, not dd/MM). `readonly` attribute is added **only inside `!IsPostBack`** (lines 30-31) → after the first postback both boxes become freely editable. Parsed with `Convert.ToDateTime` (server culture) — a dd/MM string on an en-US server throws `FormatException`. |
| `ddlDue` | DropDownList, `AutoPostBack=True`, **no handler**, static items `Dues` / `Discounts` | Selects between two entirely different queries (§4.2, §4.3). |
| `btnSearch` "Search" | Button | `loadgrid()`. |
| `Button1` "Export" | Button, `<PostBackTrigger>` (full postback) | Excel export, §4.5. |
| `lblDue` | Label, width 250px | The single aggregate on the page (§4.4). |

No field is required. There is no client-side JavaScript beyond ASP.NET's own —
the two `<script>` blocks in `Dues.aspx` 211-265 (`checkAll`, `MouseEvents`)
reference checkbox columns **that this grid does not have**; dead copy-paste.
`Dues.aspx` 187 pulls jQuery over **plain `http://code.jquery.com`** into an
https page (mixed content, blocked by every modern browser — so it never
loads, and nothing depends on it). Line 188 has a stray `<%# Eval("name") %>`
outside any data-bound control.

### 4.2 The "Dues" query — `Dues.aspx.cs` 65-100, verbatim

```csharp
var dues = (from d in dt.tbl_med_mcc_patient_masters
            where d.addeddate >= fdate && d.addeddate <= tdate &&
            (mobile == "0" || d.mobile_number == mobile) &&
            (bill   == "0" || d.order_number  == bill)   &&
            ((d.tbl_med_mcc_patient_tests.Sum(ee => ee.test_rate)) -
             (d.tbl_med_mcc_patient_billings.Sum(ee => ee.amount) > 0
                ? d.tbl_med_mcc_patient_billings.Sum(ee => ee.amount) : 0)) > 0
            select new {
                id       = d.id,
                bill     = d.order_number,
                billdate = d.addeddate,
                name     = d.name,
                age      = d.age.ToString(),
                d.mobile_number,
                refDoctor = d.ref_doctor > 0 ? d.tbl_med_mcc_doctor.doctor_name : "",
                url      = "~/Billing/Billx.aspx?id=" + d.id.ToString(),
                testcharges = d.tbl_med_mcc_patient_tests.Sum(tc => tc.test_rate),
                AmountPaid  = d.tbl_med_mcc_patient_billings.Where(ee => ee.paymode != "Discount").Sum(ab => ab.amount) > 0
                            ? d.tbl_med_mcc_patient_billings.Where(ee => ee.paymode != "Discount").Sum(ab => ab.amount) : 0,
                discount    = d.tbl_med_mcc_patient_billings.Where(ee => ee.paymode == "Discount").Sum(ab => ab.amount) > 0
                            ? d.tbl_med_mcc_patient_billings.Where(ee => ee.paymode == "Discount").Sum(ab => ab.amount) : 0,
                Due = d.tbl_med_mcc_patient_tests.Sum(tc => tc.test_rate) -
                      ((… non-Discount sum, floored at 0 …) + (… Discount sum, floored at 0 …)),
            }).ToList();
```

Date window (lines 58-59):
`fdate = date 00:00:00`, `tdate = date 23:59:59` — inclusive at both ends
(unlike F1's 00:00:01 start), but sub-second activity in the last second of the
day is excluded.

**Semantics of a "due" here:** `SUM(test_rate) − SUM(all patient_billing rows)`.
There is **no stored due** in this model, and nothing anywhere reconciles it
against `tbl_billing_patient_detail.Balance` (model C).

Behaviours that fall out of that exact expression:

1. **The WHERE and the SELECT disagree.** The filter subtracts
   `Sum(ALL amounts)`; the projected `Due` subtracts
   `max(0, non-Discount) + max(0, Discount)` — two independently floored
   halves. With a *negative* billing row (a refund entered as a negative
   amount) the two differ, and a row can appear with a `Due` that does not
   match the predicate that admitted it.
2. **Discount detection is `paymode == "Discount"`, but the writer writes
   `"DISCOUNT"`** (`Billx.aspx.cs` 198). It only works because SQL Server's
   default collation is case-**in**sensitive. Under a CS collation every
   discount would be silently counted as a payment and the Discount column
   would be zero. → Role B Q6.
3. **The writer and the reader disagree on which column marks a discount.**
   `Billx.aspx.cs` 67-82 and 317-332 classify by `payment_refrence == "DISCOUNT"`;
   Dues.aspx and DueReport.aspx classify by `paymode`. Billx happens to write
   both, but `PrintBill.ashx` (§9.7) writes `payment_refrence = "New"` and
   `paymode = "CASH"`, and any historical row that set only one of the two is
   read differently by the two screens.
4. `Sum(test_rate)` on a patient with **no** test rows is SQL `NULL`;
   `NULL > 0` is false → such patients are silently excluded, however much
   they have paid.
5. A patient with **no billing rows** gets `Sum(amount) = NULL`;
   `NULL > 0 ? … : 0` → `0`, so `Due = full charges`. Correct, and the only
   place the ternary earns its keep.
6. **`age` is `d.age.ToString()` on a nullable int** — a NULL age renders as
   an empty string, not "—". Minor.
7. `refDoctor = d.ref_doctor > 0 ? … : ""` — a NULL `ref_doctor` yields the
   `else` branch server-side, so no NRE; correct by accident.
8. **No client filter, no business-unit filter, no scope of any kind.**
9. No ordering clause at all → the row order is whatever the plan produces.
   Paging (`PageSize=50`) over an unordered set can repeat and drop rows
   between pages.

### 4.3 The "Discounts" query — `Dues.aspx.cs` 110-140

Same shape; the predicate becomes
`(Discount sum > 0 ? Discount sum : 0) > 0`, i.e. "patients who received any
discount in the window". The projection is **identical**, including the `Due`
column — so in Discounts mode the grid's "Due" column still shows outstanding
money, but the summary label (§4.4) shows total discount. Two different numbers
on one screen with no labelling to say so.

### 4.4 Every number on screen, and where it comes from

| Column / label | Expression |
|---|---|
| Bill# (hyperlink) | `order_number`, link `~/Billing/Billx.aspx?id={patient.id}` |
| Bill Date | `Convert.ToDateTime(Eval("billdate")).ToShortDateString()` — `addeddate` = **registration** date, not a bill date |
| Patient Name / Age / Mobile / refDoctor | patient master |
| Test Charges | `SUM(tbl_med_mcc_patient_test.test_rate)` — **all** rows, regardless of `amount_checked`, regardless of sample rejection |
| Amount Paid | `SUM(amount) WHERE paymode <> 'Discount'`, floored at 0 |
| Discount | `SUM(amount) WHERE paymode = 'Discount'`, floored at 0 |
| Due | `TestCharges − (AmountPaid + Discount)` |
| `lblDue` | Dues mode: `"Dues " + dues.Sum(Due)`. Discounts mode: `"Discounts " + dues.Sum(discount)`. **Computed in memory over the materialised list**, so it is the total of the *whole filtered set*, not the page — the only screen aggregate that is honest about that. |

Empty grid text: `No records...`. Paging 50/page, numeric pager,
`DataKeyNames="id"`.

### 4.5 Export — `Dues.aspx.cs` 261-310

`Response.ContentType = "application/vnd.ms-excel"`,
`content-disposition: attachment;filename=Receipts.xls`, then
`GridView1.RenderControl(hw)` after `AllowPaging = false; loadgrid();`.

- It is **HTML pretending to be `.xls`** (Excel shows a format warning).
- The filename says **`Receipts.xls`** on the *dues* page — copy-pasted from
  DueReport (`CashReceipts.xls`, `DueReport.aspx.cs` 217) and never renamed.
- No row cap: with paging off, a wide date range renders the entire result set
  into memory and into the response.
- `GridView1.HeaderRow` is dereferenced unguarded (line 275) → **NRE on an
  empty result**, after `Response.Clear()` has already run.
- The Bill# column exports the raw ASP.NET `~/Billing/Billx.aspx?id=…` href,
  unresolved tilde and all.
- `VerifyRenderingInServerForm` is overridden to a no-op (311-314), the usual
  hack to let `RenderControl` run outside the form.

### 4.6 Dead code in `Dues.aspx.cs` — do not port

- `GridView1_RowCommand` (163-211): every branch empty or commented. The grid
  declares no `OnRowCommand`.
- `GridView1_RowDataBound` (227-236): finds `imgDel2` and attaches a delete
  confirm — **there is no `imgDel2` control in `Dues.aspx`**, and the grid
  declares no `OnRowDataBound`. Would NRE if ever wired.
- `GridView1_RowDeleting`, `GridView2_RowDeleting`, `gvDue_PageIndexChanging`
  (which pages a `gvDue` that does not exist on this page): stubs.
- `btnPrint_Click` (237-259): loads `Billing.rpt` with
  `ViewState["editId"]` — never set on this page → `Convert.ToInt32(null)`
  → 0. No button invokes it.
- `lstTests`, `objBill`, `bd` (lines 16-20): declared, never used.
- `Session["TESTS"] = null` (line 29): cargo-culted from Bill.aspx.

---

## 5. `DueReport.aspx` — despite the name, a **cash-collection** report

### 5.1 UI fields

Identical row to Dues.aspx except `ddlDue` is replaced by **`ddlUsers`**
(`AutoPostBack=True`, no handler), filled by `FillCombo(ddl,"Login")`
(`Utilities.cs` 280-299): all `tbl_med_user_master` **where `PCC_Id IS NULL`**
(i.e. lab users only), text = `Username`, value = `id`, item 0 =
`--Select User--`.

`ddlSearchMcc` is present, read into `int MCC` (lines 47-48), and — exactly as
on Dues.aspx — **never used in the query**.

### 5.2 The query — `DueReport.aspx.cs` 85-106, verbatim

```csharp
var amount = (from d in dt.tbl_med_mcc_patient_billings
              where d.received_date >= fdate && d.received_date <= tdate &&
              (loginUser == "0" || d.received_by.ToUpper() == loginUser.ToUpper()) &&
              (d.paymode.ToUpper() == "CASH") &&
              (bill   == "0" || d.tbl_med_mcc_patient_master.order_number  == bill) &&
              (mobile == "0" || d.tbl_med_mcc_patient_master.mobile_number == mobile)
              select new {
                  id       = d.patientid,
                  bill     = d.tbl_med_mcc_patient_master.order_number,
                  billdate = d.received_date,
                  refDoctor = …, name = …, age = …,
                  url      = "~/Billing/Billx.aspx?id=" + d.patientid.ToString(),
                  testcharges = d.tbl_med_mcc_patient_master.tbl_med_mcc_patient_tests.Sum(ee => ee.test_rate),
                  AmountPaid  = d.amount,
                  d.tbl_med_mcc_patient_master.mobile_number,
                  Due = d.tbl_med_mcc_patient_master.tbl_med_mcc_patient_tests.Sum(ee => ee.test_rate) - d.amount
              }).ToList();
```

- The grain is **one receipt**, not one patient. A patient with three cash
  receipts appears three times.
- `paymode.ToUpper() == "CASH"` — **card, online, cheque and DISCOUNT rows are
  excluded entirely.** This report cannot see any non-cash money. NULL
  `paymode` rows are excluded too (`UPPER(NULL)` is NULL).
- `Due = TestCharges − THIS RECEIPT`. It is not the patient's balance: with two
  receipts of 500 against 1,200 of tests, both rows show a "Due" of 700, and
  neither is right. **This column is wrong on every multi-receipt bill and on
  every discounted bill.**
- `loginUser` comes from `ddlUsers.SelectedItem.ToString()` — the item **text**
  — compared to `received_by`. Sentinel `"0"` = all users.
- `billdate` is `received_date` (receipt time) but is presented under the
  header **"Bill Date"**.

### 5.3 The user filter is not enforced — `DueReport.aspx.cs` 113-124

```csharp
if (((tbl_med_user_master)Session["loginUser"]).usertypeid == 1 ||
    ((tbl_med_user_master)Session["loginUser"]).usertypeid == 5)
{ /* both statements inside are commented out */ }
else
{
    ddlUsers.Enabled = false;
    ddlUsers.SelectedValue = ((tbl_med_user_master)Session["loginUser"]).id.ToString();
}
```

Three separate defects, all in the same twelve lines:

1. **It runs AFTER the grid is bound** (line 110-111). On first load a
   non-admin sees **every user's cash collection**, lab-wide, before the
   restriction is applied to a control that is no longer read.
2. **A disabled `DropDownList` does not post its value.** On the next postback
   `ddlUsers.SelectedIndex` is 0, `loginUser` reverts to `"0"`, and the filter
   is gone again — the P1 "disabled control posts back empty" pattern, here
   protecting money data.
3. `FillCombo("Login")` only lists users with `PCC_Id IS NULL`. If a
   client-portal user reaches this page,
   `ddlUsers.SelectedValue = <their id>` throws
   `ArgumentOutOfRangeException` because the value is not in the list.

Only usertypes **1** and **5** are treated as privileged, hardcoded. Which
usertypes those are is data → Role B Q1c.

### 5.4 The second grid is permanently empty

`DueReport.aspx` 165-210 renders a heading **"Summary of Amount Collected"** and
a `gvDue` grid with columns *Employee* / *Amount*. The only code that would
bind it (`usp_bill_due_summary`) is commented out at `DueReport.aspx.cs`
115-118. So the page always shows the heading plus the empty-data template
**"No Dues Collected..."** — a screen element that asserts, permanently and
falsely, that nothing was collected.

### 5.5 Grid columns and aggregate

Bill# (link) · Bill Date · Patient Name · Age · Mobile · refDoctor ·
Test Charges · **"Amount Paid"** (= `AmountPaid`) · **"Amount Paid"** again
(= `Due`) — `DueReport.aspx` 134-149: the Due column's `HeaderText` was never
changed from the column it was copied from. Two adjacent columns with the same
header showing different numbers.

`lblDue.Text = " Amount : " + amount.Sum(ee => ee.AmountPaid)` (line 108) — the
total cash in the window. This is the one genuinely useful number on the page.

Export: `CashReceipts.xls`, same HTML-as-xls mechanism and the same unguarded
`HeaderRow` (`DueReport.aspx.cs` 213-266). Same dead handlers as §4.6.

---

## 6. Model C — the *other* patient due nobody on these pages looks at

`classBilling.cs` operates on a completely separate table family:
`tbl_billing_patient_detail` (with **stored** `amount`, `discount_amount`,
`amount_paid`, `Balance`), `tbl_billing_patient_amount_receipt`,
`tbl_billing_patient_test_detail`.

- `GetBillList` (`classBilling.cs` 134-179) offers `recType == 2 ⇒ c.Balance > 0`
  — i.e. **Bill.aspx already has an "outstanding only" worklist**, over model C.
- `GetBillListAmount` 223-261 produces the summary line
  `#Patients / TestCharges / AmountPaid / Balance / Discounts / Total RecdToday`.
- The stored `Balance` is maintained by hand and **inconsistently**:
  - `AddReceipt` 321-331 **inserts the receipt and updates nothing** — the two
    lines that would adjust `amount_paid` and `Balance` are commented out
    (324-325). So recording a receipt through this path leaves `Balance`
    overstated.
  - `DeleteReceipt` 381-393 **does** adjust: `amount_paid -= amount`,
    `Balance += amount`. Deleting a receipt that was never added to
    `amount_paid` therefore drives both columns *negative*.
  - `UpdateDiscount` 338-353 does `Balance = Balance − discount_amount` with
    no memory of a previously applied discount → applying a discount twice
    subtracts twice.
- `DeleteBill` 262-278 hard-deletes the bill, its tests and all its receipts.
  No audit, no soft delete.

**Infinity's report lock reads exactly this `Balance`** (`ReportLockRepository.cs`
117-136). So the number that decides whether a patient's report is released is
the one maintained by the three methods above, while the number the lab looks
at on Dues.aspx is computed from a different table family entirely. They can
be arbitrarily far apart. → Role B Q7, the most important query in this
document.

---

## 7. Model A — the client wallet

### 7.1 How a wallet is created

`MCCUnitMasterClass.SavemccUnit` (17-34): saving a client inserts a
`tbl_med_mcc_account_master` row with `totaldeposited = 0, currentbalance = 0`
if none exists. `CheckTransCash` (`WorksheetClass.cs` 729-736) creates one
lazily too, on first charge. `DeleteMccUnit` (38-55) deletes the wallet rows
along with the client.

### 7.2 How it is debited — accession

`WorksheetClass.CheckTransCash` (694-912), reached from `Accession.aspx.cs` and
from `Inward.aspx.cs` (F1 §7). Per test / profile / master-profile row of the
sample, where `amount_checked IS NULL`:

```csharp
tbl_med_test_rates_with_pcc_type temp00 = … RateTypeId == mccAccount.tbl_med_mcc_unit_master.RateType
                                            && c.TestCode == item.test_id …;
var sprice = dt.tbl_med_mcc_test_special_rates.Where(ee => ee.testtype == "T"
                && ee.testid == item.test_id && ee.mcccode == mccCode).FirstOrDefault();
tempAmount = sprice != null ? sprice.rate : temp00.Price;      // NRE if no rate row

dt.sp_mcc_test_account_101(userId, mccAccount.mcccode, DateTime.Now,
    mccAccount.currentbalance, tempAmount, mccAccount.currentbalance - tempAmount,
    ooo.test_name, patname, item.patient_id, subPccCode);      // 766
mccAccount.currentbalance = mccAccount.currentbalance - tempAmount;   // 767
ooo.amount_checked = true; ooo.updateddate = DateTime.Now;
dt.SubmitChanges();
```

Facts that matter for F3:

- **The ledger row is written BEFORE the balance is changed, and the two are
  not in one transaction.** A failure between line 766 and the `SubmitChanges`
  at 772 leaves a ledger row whose `closingbalance` never happened.
- **`sp_mcc_test_account_101` is the ONLY record of a charge.** It writes
  `tbl_med_mcc_test_transactions`; **no `tbl_med_mcc_account_detail` row is
  created**. This is why the account_detail table can never sum to the balance
  (§10.2).
- `amount_checked` is the idempotency guard, and it is per test row, set inside
  the same `SubmitChanges` — read-then-write with no lock. Two concurrent
  accessions of the same sample can both see NULL and both charge.
- A missing rate row (`temp00 == null` with no special rate) throws NRE
  **after** earlier tests in the same loop have already been charged and
  committed. Partial debit, no rollback.
- `patname` is truncated to 49 chars (701-702) because the sproc parameter is
  `nvarchar(100)` but the column apparently is not — Role B Q2.
- The sub-franchise redirect (708-709, 725-728): when a user exists whose
  `sub_pcc_id` equals this client, the charge is posted to **that user's
  `PCC_Id`** instead — i.e. a franchise's charges land on its parent's wallet,
  while `chk` at line 875 re-reads the wallet by the *original* `mccCode` for
  the lock check. So for sub-franchises **the debited account and the
  lock-checked account are different accounts.**

### 7.3 How it is credited/adjusted — `MccAccountClass.SaveAccount` (17-84)

```csharp
if (obj.credittype == 1) {                       // Payment
    objMaster.totaldeposited = (objMaster.totaldeposited ?? 0) + obj.amount;
    objMaster.currentbalance = objMaster.currentbalance + obj.amount;   // both branches identical
    if (objMaster.currentbalance == null) objMaster.currentbalance = obj.amount;
    objMaster.totaldeposited = int.Parse(GetMccTotalAmountDeposited(objMaster.id.ToString()));   // ← line 46
}
if (obj.credittype == 2) objMaster.currentbalance += obj.amount;        // Credit
if (obj.credittype == 3) objMaster.currentbalance -= obj.amount;        // Debit
…
if (objMaster.currentbalance > 0) objMaster.tbl_med_mcc_unit_master.IsActive = true;
else                              objMaster.tbl_med_mcc_unit_master.IsActive = false;
```

- **Line 46 is a money bug.** `GetMccTotalAmountDeposited` (373-383) filters
  `c.mcccode == Convert.ToInt32(p)`, but it is handed
  **`objMaster.id`** — the identity PK of `tbl_med_mcc_account_master` — not
  `objMaster.mcccode`, the client id. Every payment therefore overwrites this
  client's `totaldeposited` with **some other client's** deposit total (or 0).
  The value is displayed as "Total Deposited" on `Mcc_Account.aspx`
  (`LoadCurrentBalances` 327-338) and is exposed by Infinity as
  `totalDeposited` (§10.1). → Role B Q4.
- Every `if (x < 0) … else …` in this method has **identical branches** — the
  sign handling was written, found unnecessary, and left in place. Harmless
  but it is what makes the method look more careful than it is.
- **The auto-lock lives here** (74-83): saving any account movement flips
  `tbl_med_mcc_unit_master.IsActive` purely on the sign of the resulting
  balance. A client with a negotiated `creditlimit` of −5,000 and a balance of
  −100 is deactivated by this line even though every lock rule in §8 says they
  are fine. No audit, no notification, no `lastupdatedby`.
- `lastupdatedby` / `lastupdateddate` on the wallet are **never written by any
  code in the tree**, though Infinity surfaces `lastUpdatedAt` (§10.1).

### 7.4 How a movement is reversed — `DeleteAccount` (85-152)

Reverses the balance by credit type, deletes the `account_detail` row, and
logs `sp_mcc_test_account_101(… cType + " Deleted" …)`. Notes:

- `cBalance` is captured as a **string** then `Convert.ToInt32`-ed (98, 145) —
  a NULL balance yields `""` → `FormatException`.
- The reversal for a Payment subtracts from both `currentbalance` **and**
  `totaldeposited` — but `totaldeposited` is recomputed from scratch on the
  next payment (line 46), so the two drift.
- `dt.sp_mcc_test_account_101(...)` runs **before** `dt.SubmitChanges()` (151),
  i.e. the ledger says the reversal happened before it is committed.
- The deleted row is gone. The only trace is the ledger row and a
  `GetUserLog` call from the page (`Mcc_Account.aspx.cs` 223) — which
  dereferences `objMcc.GetAccount(id)` **after** the row was deleted → NRE,
  swallowed by the surrounding catch, so **deletions frequently go unlogged.**

### 7.5 "Payment inactive" — `UpdateAccountInActive` (419-427)

`Mcc_Account.aspx.cs` 462-471 (`btnPay_Click`) sets
`tbl_med_mcc_account_detail.debit_flag = chkStatus.Checked`. That flag:

- **excludes** the payment from `GetMccTotalAmountDeposited` (378) and from
  `GetAccountsPayments` (256);
- **does not touch `currentbalance` at all.**

So marking a bounced cheque "inactive" removes it from the deposit total and
from the payments figure while leaving the credit sitting in the balance. The
screen then shows a deposit total and a balance that cannot both be right.
This is a *hide-a-debt* path. → Role B Q5.

---

## 8. Credit limits and the lock rules

Three near-identical implementations, all in `WorksheetClass.cs`:

| Method | Returns | Used by |
|---|---|---|
| `GetMccStatus(string mccCode)` 2005-2049 | bool | `Pcc\SampleSent.aspx.cs` 203, `Pcc\SampleStatus.aspx.cs` 377 |
| `GetMccStatusByMccId(int)` 2050-2085 | an **image path** | `MCCUnitMasterClass.GetMccUnits` 101, `GetMccUnitLockUnlock` 125 |
| `GetMccStatusByMccId100(int)` 2086-2122 | bool | `CheckTransCash` 880 (auto-lock probe), `SampleStatus.aspx.cs` 385 |

All three implement the same ladder (unlocked wins at the first hit):

```csharp
if (mccStatus.PerminentUnlock == true || acc.currentbalance > 0)        return UNLOCKED;
if (mccStatus.creditlimit < 0 && mccStatus.creditlimit < acc.currentbalance) return UNLOCKED;
if (isExpireDate != null && isExpireDate > DateTime.Now)                return UNLOCKED;   // tbl_med_mcc_lockunlock
return LOCKED;
```

- `creditlimit` is stored **negative**; only a negative value is an allowance.
- Boundary: `creditlimit < currentbalance` is **strict**, so a balance exactly
  equal to the limit is **LOCKED**.
- `isExpireDate` comes from `tbl_med_mcc_lockunlocks[0].expire_unlock` — the
  **temporary unlock** granted by `LockUnlock_MCC.aspx` (`btnSave_Click` 97-135:
  `expire_unlock = now + txtHours`). One row per client, overwritten each time;
  no history of past unlocks.
- `GetMccStatusByMccId` 2054 fetches `tbl_med_user_masters.Where(c => c.id == MccId)`
  into `temp` and never uses it — it is looking up a *user* by an *MCC* id.
  Dead, and misleading.
- `MCCUnitMasterClass.GetMCCExpireStatus` (153-167) is a **fourth**, different
  rule — `expire_unlock <= now && currentbalance <= 0` → inactive — used by the
  Sales ledger screens (`LedgerBalance.cs` 41, 68). It ignores `creditlimit`
  and `PerminentUnlock` entirely, so the Sales screens show a different
  lock state than the admin screens for the same client.

**What the LIS lock actually does: nothing enforceable.** The only effects are
`hlPatientReport.Enabled = false` and siblings on client-portal grids
(`SampleStatus.aspx.cs` 379-383, `SampleSent.aspx.cs` 203-208) — it greys out
a hyperlink. The report handlers themselves (`g.aspx`, `hrf`, the `.rpt`
exports) have no balance check. On the lab side the check is **commented out**
(`SampleWorksheet.aspx.cs` 326 and `Worksheet.aspx.cs` 295: `bool isActive = true;//
objWork.GetMccStatus(...)`). And `SampleSent.aspx.cs` 203 passes
`lblPatientId.Text` into `GetMccStatus(string mccCode)`, which looks the value
up as an `MCCUnitCode` and then dereferences `.FirstOrDefault().id` with no
try/catch — an NRE unless that label really holds a client code. → Role B Q9.

`CheckTransCash` 872-907 is the **auto-lock**: when a charge takes the balance
below zero it calls `GetMccStatusByMccId100` and, if locked, would have sent an
SMS and disabled sub-franchises — **every statement in that block is commented
out** (886-903). The auto-lock therefore has no effect at all today; the only
automatic locking that actually happens is the `IsActive` flip in
`SaveAccount` (§7.3).

`MCCUnitMasterClass.LockUnlock` (168-215) inserts a `tbl_med_mcc_sms_history`
row on **every** call (`if (sendSmshis.Count >= 0)`, always true) while
constructing a `SendSMS` object it never uses — an SMS log with no SMS.

---

## 9. Complete register of every reader and writer of a balance

Tree-wide raw `grep -ri` across `E:\Listec Genomics` including `NOBLE\`,
`NOBLE\NOBLE\`, `Payment\`, `Razor\`, `Razor2\`, `ICMR\`, `WebApplication1\`
(the repo's Grep tool skips NOBLE — a raw grep via Bash was used).

### 9.1 Writers of `tbl_med_mcc_account_master.currentbalance`

| # | Site | Trigger | Notes |
|---|---|---|---|
| 1 | `MccAccountClass.SaveAccount` 17-84 | Mcc_Account save, ccavResponse, mrf | The only path that also writes `account_detail`; flips `IsActive` (§7.3) |
| 2 | `MccAccountClass.DeleteAccount` 85-152 | Mcc_Account delete | §7.4 |
| 3 | `WorksheetClass.CheckTransCash` 767, 810, 858 | Accession **and Inward scan** | §7.2 |
| 4 | `WorksheetClass.RejectSample` 2532-2583 | sample rejection | Credits back `test_rate` per test, sets `amount_checked = false`, **and** inserts an `account_detail` row with `credittype = 2, deposittype = 7 (Reject)`. The only place a charge reversal appears in `account_detail`. Reads the wallet via `mccUser.PCC_Id` (2537-2541) — an NRE if no user is mapped to the client. |
| 5 | `WorkOrder.cs` 145-180 | editing a work order's tests | Adjusts by the price delta. In the `patOldAmount < patNewAmount` branch (169-174) the balance is decreased by `(new − old)` but the ledger is written with `testcharges = (old − new)`, i.e. **negative** — the ledger's sign convention differs between the two branches. |
| 6 | `MedCis.UI\Pcc\razorCallback.aspx.cs` 83 | Razorpay browser callback | Increments in C# and inserts `account_detail`; guards on duplicate `chequeorddnummber` (64-67) — a real idempotency key. **Hardcodes the LIVE Razorpay key and secret in source** (39-40). |
| 7 | **`MedCis.UI\razor_update.asmx.cs` 62** (NOBLE only) | ASMX web method | §9.6 — the worst one |
| 8 | `MedCis.UI\Pcc\ccavResponse.aspx.cs` 111-117 | CCAvenue callback | Calls `sp_mcc_test_account_101` **and** `objMcc.SaveAccount` — the sproc only logs, `SaveAccount` does the increment, so no double count; but the working key is hardcoded (line 17) and the whole body is wrapped in `catch {}` (129-132) that swallows every failure while `trans.Complete()` still runs (133). |
| 9 | `MedCis.UI\Pcc\mrf.aspx.cs` ~290-305 | MRF debit | `SaveAccount` with a debit + ledger row |
| 10 | `MedCis.UI\Default.aspx.cs` `UpdateTrans` 83-127 | — | **Dead**: the only call site is commented out at line 59. Charges with a **hardcoded `USERID = 3`**. |
| 11 | `MedCis.UI\login.aspx.cs` `Button1_Click` 136-184 | a `Visible="False"` button on the **login page** | Backfill sweep over a hardcoded window (`01/06/2022` + 20 days), charging every un-`amount_checked` test with **`USERID = 3`**. Not rendered, so not normally reachable; do not port, and Role B should confirm no `userid = 3` rows exist outside a known backfill (Q3). |

### 9.2 Readers of the wallet

`MCCUnitMasterClass.GetMccUnitLockUnlock` 128 · `GetMCCExpireStatus` 157 ·
`WorksheetClass` 2017/2059/2096 · `LedgerBalance.GetMccLedgerBalancesByDates`
37-39 and `GetMCCLedgerBalances` 106-108 and `GetMCCCurrentBalance` 375-386 ·
`MccAccountClass.GetMCCCurrentBalance` 361-370 · `Mcc_Account.aspx.cs` 137, 334 ·
`Default.aspx.cs` 40 · `Admin_General\dasweb.asmx.cs` 510-516 ·
`Admin_General\daswebs.asmx.cs` 503-509 · Infinity `usp_inf_client_accounts` and
`ReportLockRepository`.

`dasweb.asmx.cs` 510 reads **`mcccode == 398` hardcoded** — the client dashboard
web service reports one specific client's balance to everyone. `daswebs.asmx.cs`
503 is the fixed version taking `idata.cUnit`. Both are deployed.

`LedgerBalance` 37/64/106 do
`c.tbl_med_mcc_account_masters.Where(…).SingleOrDefault().currentbalance` —
**NRE for any client without a wallet row**, and `SingleOrDefault` throws for
any client with two.

### 9.3 Writers of `tbl_med_mcc_account_detail`

`SaveAccount` (all manual movements) · `DeleteAccount` (delete) ·
`RejectSample` 2560-2571 · `razorCallback` 84 · `razor_update` 63 ·
`UpdateAccountInActive` (sets `debit_flag` only).

### 9.4 Writers of `tbl_med_mcc_test_transactions`

Only `dbo.sp_mcc_test_account_101`, from all the call sites in §9.1 plus
`Mcc_Account.aspx.cs` 140-144 and `DeleteAccount` 145. Read by
`LedgerBalance.GetMCCSalesTrans` 396-458 (the Sales "LedgerStatusofMcc" screen)
and by `Default.UpdateTrans` 94.

### 9.5 Writers of `tbl_med_mcc_patient_billing` (model B receipts)

| Site | Notes |
|---|---|
| `Billx.aspx.cs` 145-180 `btnBalanceAmount_Click` | The intended counter path: `paymode = ddlPaymode` text, `payment_refrence = txtRefNumber`, `received_by = User.Identity.Name`. No amount validation beyond `Length > 0` — `Convert.ToInt32` throws on non-numeric, negative amounts accepted. |
| `Billx.aspx.cs` 182-214 `btnAddDiscount_Click` | Writes `paymode = "DISCOUNT"` **and** `payment_refrence = "DISCOUNT"`. Gated by `tblDiscount.Visible = objWork.GetEditPatientInfo(user, "Discount")` — a *visibility* gate only; the handler itself is unguarded, so a forged postback records a discount regardless. |
| **`Pcc\PrintBill.aspx.cs` 10-46** | §9.7 |
| **`Pcc\PrintBill.ashx.cs` 14-49** | §9.7 |

There is **no delete/void path** for a `tbl_med_mcc_patient_billing` row
anywhere in the tree. A wrong receipt in model B is permanent.

### 9.6 `razor_update.asmx` — an authenticated user can credit any wallet

```csharp
[WebMethod(EnableSession = true)]
public string Update(string name, string nameid, string amount, string orderid, string paymentid)
{
    objAcc.mcccode = Convert.ToInt32(nameid);
    objAcc.credittype = 1; objAcc.deposittype = 5;
    objAcc.amount = Convert.ToInt32(amount);
    …
    dt.sp_mcc_test_account_101(userMaster.id, mccAccount.mcccode, DateTime.Now,
        mccAccount.currentbalance, objAcc.amount, mccAccount.currentbalance + objAcc.amount, "ONLINE", "", 0, "");
    mccAccount.currentbalance = mccAccount.currentbalance + objAcc.amount;
    dt.tbl_med_mcc_account_details.InsertOnSubmit(objAcc);
    dt.SubmitChanges();
```

- **No verification of any kind that a payment actually occurred.** The
  amount, the client and the payment id are all caller-supplied strings.
  `razorCallback.aspx.cs` at least calls `Utils.verifyPaymentSignature` and
  re-fetches the amount from Razorpay (48-49); this endpoint does neither.
- The duplicate guard (44-47) calls `Response.Redirect` inside a web method —
  which does not stop execution here; it throws `ThreadAbortException`, caught
  by the outer `catch` at 71, returning `"Failed…"`. So it *is* idempotent, by
  accident, via an exception.
- Deployed at the web root. Covered by `<deny users="?"/>` only, i.e. **any**
  authenticated account — including any of the client-portal logins — can call
  it. → Role B Q3.

### 9.7 `PrintBill.aspx` / `PrintBill.ashx` — a GET that records cash

```csharp
// PrintBill.ashx.cs 14-31, verbatim
if (context.Request.QueryString.Count > 1) {
    int patId  = Convert.ToInt32(context.Request.QueryString[0]);
    int amount = Convert.ToInt32(context.Request.QueryString[2]);
    string userName =            context.Request.QueryString[1];
    obj.patientid = patId; obj.paymode = "CASH"; obj.received_by = userName;
    obj.received_date = DateTime.Now; obj.payment_refrence = "New"; obj.amount = amount;
    dt.tbl_med_mcc_patient_billings.InsertOnSubmit(obj);
    dt.SubmitChanges();
```

- A **GET** request inserts a cash receipt. Every reload, back-button,
  browser prefetch or double-click inserts **another** one.
- `patientid`, `amount` and `received_by` come straight from the query string.
  The `.ashx` has no `amount > 0` guard at all; the `.aspx` has one (line 19)
  and is otherwise identical.
- No scope check, no capability check, no relation to the actual bill.
- Because Dues.aspx computes `Due = charges − payments`, this endpoint is a
  **one-URL way to make any patient's due disappear**, attributed to any
  username the caller types.
- **Nothing in the tree links to either file** — they are orphan endpoints,
  and both are in the deployed package.

This, together with §9.6, is why F3's FIX list leads with "money can be moved
by URL".

---

## 10. What Infinity already covers — and what it does not

### 10.1 Already built (do not re-specify)

| Legacy behaviour | Infinity |
|---|---|
| Client wallet list with balances | `usp_inf_client_accounts` (`api/db/sql/80_usp_inf_client_accounts.sql` 22-74) → `ClientAccountRepository.ListAsync` → `GET /api/accounts`. Paged, searchable, **`only_owing` filter**, ordered biggest-debt-first. |
| "Which way is up" | Solved once, in SQL: `owed = -balance` (script 80 line 67), documented at 9-19, and the UI shows `owed` (`web/src/pages/ClientAccounts.tsx` 11-20). The legacy has no equivalent — every screen shows the raw negative. |
| Client scoping of the list | `ScopeRepository.GetReportClientCodesAsync` + a `dbo.ClientCodeList` TVP; denied scope returns an empty page, not everything (`ClientAccountEndpoints.cs` 48-53). **This is the gap the legacy pages leave wide open.** |
| Ledger for one client | `usp_inf_client_ledger` (script 80, 83-121) → `GET /api/accounts/{mcc}/ledger`, 404 for out-of-scope (`ClientAccountEndpoints.cs` 79). |
| Recording a client payment | `POST /api/accounts/{mcc}/payments`, capability `payment:capture`, membership scope check, amount > 0, **deliberately not retried** (`ClientAccountRepository.cs` 131-172), posted through `usp_telo_record_mcc_payment` with `@origin='inf:'`. |
| Per-bill receipts / void / edit / discount (model C) | `BillingEndpoints.cs` — all four routes scope-checked through `OrdersRepository.GetAsync`, out-of-scope → 404. **Void and edit exist**, which model B has no equivalent of at all. |
| Outstanding balance blocking a report | `ReportLockRepository` + HTTP **423** (`ReportPdfEndpoints.cs` 138-149), applied **after** scope so lock state cannot be used to probe for existence (14-16). B2C from `tbl_billing_patient_detail.Balance`; B2B from the wallet vs `creditlimit` floor; `PerminentUnlock` overrides. This is *stronger* than the LIS, which only greys out a hyperlink (§8). |
| Money visibility as a capability | `billing:view` / `payment:capture` in `InfinityRoles.cs`; the client role gets `BillingView` but not `PaymentCapture` (105-125); orders list returns `canSeeMoney` (`ApiEndpoints.cs` 196). |

### 10.2 Genuinely missing — this is F3's build list

1. **The patient-dues worklist (model B) does not exist.** Nothing in Infinity
   reads `tbl_med_mcc_patient_billing` or sums `tbl_med_mcc_patient_test.test_rate`.
   Dues.aspx's entire subject matter is unported.
2. **No outstanding filter or dues total on orders (model C).**
   `OrdersRepository.ListAsync` (`Reads/OrdersRepository.cs` 100-182) selects
   `b.Balance` but offers only search + date range — no `onlyOutstanding`, no
   aggregate. Bill.aspx's `recType == 2` worklist and its
   `#Patients / TestCharges / AmountPaid / Balance / Discounts / RecdToday`
   summary line have no counterpart.
3. **The charge ledger is missing from the client ledger.**
   `usp_inf_client_ledger` reads **only** `tbl_med_mcc_account_detail`. In the
   LIS, accession charges go to `tbl_med_mcc_test_transactions` and write **no**
   `account_detail` row (§7.2). So Infinity's "the movements behind this
   balance" screen is missing every debit the lab actually raised — it can
   never reconcile to the balance it sits under. Fixing this means unioning
   `tbl_med_mcc_test_transactions` into the ledger.
4. **`debit_flag` is misinterpreted.** Script 80 line 104 renders
   `direction = CASE WHEN debit_flag = 1 THEN 'debit' ELSE 'credit' END`. In the
   LIS, `debit_flag` means "**this payment was marked inactive**"
   (`UpdateAccountInActive`, §7.5); direction is `credittype` (1 Payment,
   2 Credit, 3 Debit). Consequences on LIS-origin rows: a `credittype = 3`
   debit adjustment displays as a **credit**, and a voided payment displays as
   a **debit**. Rows written by Telo may follow the other convention — Role B
   Q8 settles it. Either way the ledger needs `credittype`/`deposittype` and a
   distinct "voided" presentation.
5. **The temporary unlock is not honoured.** `ReportLockRepository.ComputeAsync`
   never reads `tbl_med_mcc_lockunlock`. The LIS's third unlock rule —
   `expire_unlock > now`, the lever `LockUnlock_MCC.aspx` exists to pull — has
   no effect in Infinity. An operator who grants a client 24 hours in the LIS
   will find Infinity still returning 423. This is exactly the parity proof
   `docs/agent-port-plan.md` §1 asks for on LockUnlock_MCC.
6. **Boundary at the credit limit differs.** Legacy unlocks on
   `creditlimit < currentbalance` (strict) → balance **equal** to the limit is
   locked. Infinity locks on `balance < floor` → balance equal to the floor is
   **unlocked**. One rupee, but it is the rupee at the exact limit.
7. **No B2C due list, and B (Dues.aspx) vs C (the lock) are never reconciled.**
   Whatever Infinity builds must decide which model is authoritative, or show
   both and flag disagreement.
8. **No `totaldeposited` correction.** Infinity surfaces `totalDeposited`
   (script 80 line 51, `ClientAccount.TotalDeposited`) straight from a column
   that §7.3 shows is written from the wrong key.
9. **No cash-collected-by-user report.** DueReport's one genuinely useful
   output (`lblDue`, total cash in a window, filterable by user) has no
   counterpart. Infinity's nearest is Billx's per-user grouping, also unported.
10. **No export.** Neither page's export exists in Infinity, in any form.

---

## 11. Error paths

No `try`/`catch` and no message label on either page. Everything surfaces as an
unhandled exception inside the UpdatePanel.

| Failure | Trigger | Result |
|---|---|---|
| `FormatException` | dd/MM date on an en-US server, or a hand-typed date after the first postback (readonly is not re-applied) | Page error |
| NRE on `GridView1.HeaderRow` | Export with zero rows | Error after `Response.Clear()` |
| `ArgumentOutOfRangeException` | A PCC user opens DueReport (§5.3) | Page error |
| `Convert.ToInt32(null)` | `btnPrint_Click` on Dues (dead handler) | Would be 0 |
| Unbounded result set | Export over a wide date range | Memory / timeout |
| `Session["loginUser"]` null | Session expiry mid-use on DueReport line 113 | NRE |

---

## 12. Quirk register — KEEP / FIX

Money bugs first.

| # | Quirk | Verdict | Justification |
|---|---|---|---|
| 1 | `PrintBill.aspx` / `PrintBill.ashx`: a **GET** inserts a CASH receipt for a query-string patient/amount/username; no auth beyond "logged in", no scope, no idempotency, unlinked from anywhere | **FIX** (do not port; ask the lab to retire the endpoints) | Any authenticated user can zero any patient's due, attributed to anyone, and a refresh double-counts. Infinity records receipts through `BillingEndpoints` with capability + scope + a void path. |
| 2 | `razor_update.asmx.Update` credits any client wallet by a caller-supplied amount with **no payment verification** | **FIX** (do not port) | An unverified credit is an invented payment. Infinity's only credit path is `usp_telo_record_mcc_payment` behind `payment:capture` and scope. |
| 3 | `SaveAccount` line 46 recomputes `totaldeposited` keyed on `objMaster.id` instead of `objMaster.mcccode` | **FIX** | Writes another client's deposit total into this client's account. Infinity must not read `totaldeposited` as truth until Role B Q4 quantifies the damage; derive it from the movements instead. |
| 4 | `debit_flag` ("payment inactive") removes a payment from the deposit total but **not** from `currentbalance` | **FIX** | Voiding must move the money or not claim to. Infinity voids by posting a reversing entry, never by hiding a row. |
| 5 | `DeleteAccount` hard-deletes the movement; the audit call afterwards NREs on the deleted row and is swallowed | **FIX** | Deleting a money movement with no surviving record violates ground rule 6. Reverse, don't delete. |
| 6 | `SaveAccount` flips `tbl_med_mcc_unit_master.IsActive` purely on `balance > 0`, ignoring `creditlimit` and `PerminentUnlock` | **FIX** | Deactivates clients who are inside their agreed credit limit, silently and unaudited — and it contradicts every lock rule in §8. |
| 7 | `CheckTransCash`: ledger row written before the balance change, no transaction across the two; a missing rate row NREs mid-loop after earlier tests were committed | **FIX** | Half-charged samples and ledger rows describing a `closingbalance` that never existed. One transaction per charge set. |
| 8 | Sub-franchise charges debit the parent's wallet (`objSubFrUserMaster.PCC_Id`) while the auto-lock re-reads the **child's** wallet | **FIX** | The account charged and the account judged must be the same account. |
| 9 | `classBilling.AddReceipt` inserts the receipt but the `amount_paid`/`Balance` updates are commented out; `DeleteReceipt` adjusts anyway; `UpdateDiscount` subtracts unconditionally | **FIX** | This is the column Infinity's 423 lock reads. A stored balance nobody maintains consistently is worse than none. → Role B Q7. |
| 10 | Model B (Dues.aspx) and model C (the lock) are two unreconciled patient dues | **FIX** — and it needs a decision | Infinity must name one authoritative patient due. Showing a worklist from B while locking on C means the lab clears a due and the report stays locked. |
| 11 | Discount detected as `paymode == "Discount"` while the writer writes `"DISCOUNT"`, and by `payment_refrence` on a different screen | **FIX** | Correct today only by collation luck; one column, one vocabulary, compared explicitly. |
| 12 | Dues WHERE floors the total payments; the SELECT floors the two halves separately | **FIX** | The filter and the displayed number must be the same expression. |
| 13 | `WorkOrder.cs` 173 logs a **negative** `testcharges` in one branch and positive in the other | **FIX** | A ledger with two sign conventions cannot be summed. |
| 14 | Wallet ledger is split: charges → `tbl_med_mcc_test_transactions`, manual movements → `tbl_med_mcc_account_detail`, and neither is complete | **KEEP** the storage, **FIX** the reading | 15 years of history live in both; Infinity must read the union so the ledger reconciles to the balance (§10.2 item 3). |
| 15 | `lastupdatedby` / `lastupdateddate` on the wallet never written | **FIX** | Every balance change gets an actor and a time. Ground rule 6. |
| 16 | Money is `int` everywhere — wallet, ledger sproc params, receipts | **KEEP** | The whole store is rupee-integer; introducing paise on one side would break every existing sum. Record it as a constraint. |
| 17 | Both pages' `CheckUserPage(88, …)` commented out | **FIX** | Commercial data behind no permission at all. Infinity gates on `billing:view`, on every request. |
| 18 | `ddlSearchMcc` read into `MCC` then never used — **no client scoping on either page** | **FIX** | A collection centre can read every other centre's patients, mobiles and money. Ground rule 5; Infinity already scopes accounts, and the dues list must be scoped the same way. |
| 19 | DueReport's user restriction runs after the bind, and is stored in a **disabled** dropdown that posts back empty | **FIX** | The P1 disabled-control pattern, here leaking lab-wide cash collection to any user. Filter server-side from identity, never from a control. |
| 20 | DueReport's "Due" = charges − **this one receipt** | **FIX** | Wrong on every multi-receipt and every discounted bill; it invents a debt. |
| 21 | DueReport hard-filters `paymode = 'CASH'` while being called a due report | **KEEP** the report (as "cash collected"), **FIX** the name | It is a useful daily reconciliation; it is simply not a dues report. Port it as one, labelled honestly. |
| 22 | DueReport's "Summary of Amount Collected" grid is permanently empty ("No Dues Collected...") | **FIX** | A display that asserts a falsehood about money. Either bind it (the `usp_bill_due_summary` shape is right there) or remove it. |
| 23 | Two adjacent grid columns both headed "Amount Paid" | **FIX** | Copy-paste header bug. |
| 24 | "Bill Date" is `addeddate` (registration) on Dues and `received_date` (receipt) on DueReport | **FIX** | Label each for what it is. |
| 25 | Dues grid has **no ORDER BY** under paging | **FIX** | Unordered OFFSET paging repeats and drops rows. |
| 26 | Date window always ANDed, even with an exact bill number, and defaults to today | **FIX** | Searching a known bill from last month returns nothing. Same verdict as F1 quirk 14. |
| 27 | `readonly` on the date boxes applied only on `!IsPostBack` | **FIX** | Ports as a proper date control; the quirk simply disappears. |
| 28 | `FillCombo("PCC")` lists inactive clients | **KEEP** | Historic dues reference inactive clients; filtering would orphan them. Mark inactive visually. |
| 29 | Bill/mobile filters use `"0"` as the no-filter sentinel | **FIX** | Bill number 0 is unsearchable, and it is a magic value in a money screen. |
| 30 | HTML-as-`.xls` export, no row cap, `HeaderRow` NRE on empty, filename `Receipts.xls` on the dues page | **FIX** | Ground rule 7: real format, honest filename, bounded. |
| 31 | Dead handlers (`RowCommand`, `RowDataBound` finding a non-existent `imgDel2`, `gvDue_PageIndexChanging`, `btnPrint_Click`), dead `checkAll`/`MouseEvents` scripts, `http://code.jquery.com` on an https page, stray `<%# Eval("name") %>` | **FIX** (do not port) | All provably unreachable. |
| 32 | `usp_bill_due_report` / `usp_bill_due_summary` exist, are mapped, and are never called | **KEEP as evidence** | Their result shapes state the lab's original intent (`Balance`, `Discount`, `rectype`, per-employee summary). Read them (Role B Q10) before designing the Infinity procs — but build fresh. |
| 33 | `dasweb.asmx` reports client **398**'s balance to every caller | **FIX** (do not port) | Superseded by `daswebs.asmx`; a hardcoded client id in a money API. |
| 34 | `login.aspx` hidden Button1 mass-charges with `USERID = 3`; `Default.UpdateTrans` likewise (call commented out) | **FIX** (do not port) | A balance-mutating handler on the login page is indefensible even if unreachable. |
| 35 | Live Razorpay key+secret (`razorCallback.aspx.cs` 39-40) and the CCAvenue working key (`ccavResponse.aspx.cs` 17) hardcoded in source | **FIX** — and flag to the lab now | Payment credentials in a source tree that has three copies of itself on disk. Out of F3's build scope but must not go unrecorded. |
| 36 | `ccavResponse` wraps everything in `catch {}` and still calls `trans.Complete()` | **FIX** | A payment that failed to post reports success. |
| 37 | `LedgerBalance` dereferences `.SingleOrDefault().currentbalance` | **FIX** | NRE for a client with no wallet, throw for one with two. |
| 38 | Four different lock rules across `WorksheetClass` ×3 + `GetMCCExpireStatus` | **FIX** | One rule, one implementation. Infinity already has it in `ReportLockRepository`; it needs the temporary-unlock clause added (§10.2 item 5). |
| 39 | The LIS lock only disables a hyperlink; the report handlers have no check; the lab-side check is commented out | **KEEP the intent, FIX the enforcement** — already done | Infinity's 423 is the corrected behaviour. Record that Infinity is *stricter* than the LIS so the lab is not surprised. |
| 40 | `CheckUserPage` ignores the `_read`/`write`/`_delete` bits | **KEEP (as fact)** → F4 | Same verdict as F1 quirk 16: model "row = access" until F4 replaces the scheme. |

---

## 13. OPEN QUESTIONS for Role B (settle from production data)

1. **Are the pages reachable at all?** `tbl_med_menu_master` / `tbl_med_security_master`
   rows for `Billing/Dues.aspx` and `Billing/DueReport.aspx` — is there a menu
   id 88, what is its `page_url`, and which usertypes hold it? (b) Does any
   usertype holding it belong to users with `PCC_Id > 0` (the §2 leak)?
   (c) Which usertypes are ids **1** and **5** (DueReport's hardcoded
   privileged set)?
2. **`sp_mcc_test_account_101`'s body.** Does it only INSERT into
   `tbl_med_mcc_test_transactions`, or does it also touch
   `tbl_med_mcc_account_master`? Every C# call site assumes "log only" and
   adjusts the balance itself — if the proc also adjusts, **every charge is
   double-counted**. Also: what is `tname`'s real column width (the code
   truncates patient names to 49)?
3. **Out-of-code money writers.** Triggers on `tbl_med_mcc_account_master`,
   `tbl_med_mcc_account_detail`, `tbl_med_mcc_test_transactions`,
   `tbl_med_mcc_patient_billing`; SQL Agent jobs; other applications. And
   specifically: (a) any `tbl_med_mcc_test_transactions` rows with
   `userid = 3` (the login-page/Default backfill, §9.1 items 10-11);
   (b) any `tbl_med_mcc_account_detail` rows with `deposittype = 5` and a
   `Reason` that looks like a razorpay payment id but no matching
   `chequeorddnummber` guard — i.e. evidence `razor_update.asmx` has been used.
4. **Does `totaldeposited` agree with its own movements?** For every account:
   `totaldeposited` vs `SUM(amount) FROM tbl_med_mcc_account_detail WHERE
   mcccode = a.mcccode AND credittype = 1 AND ISNULL(debit_flag,0) = 0`. How
   many disagree, and by how much? Then the diagnostic for §7.3: does
   `totaldeposited` instead match the sum keyed on the account's **`id`**?
   That comparison proves or kills the wrong-key bug from data alone.
5. **`debit_flag` in the wild.** How many `account_detail` rows have
   `debit_flag = 1`, what are their `credittype`s, and were their amounts ever
   removed from `currentbalance`? (Cross-check against
   `tbl_med_mcc_test_transactions` rows near the same timestamp.)
6. **Collation.** Is the database (and specifically
   `tbl_med_mcc_patient_billing.paymode`) case-insensitive? Distinct values of
   `paymode` and `payment_refrence` with counts — how many rows say
   `"Discount"` vs `"DISCOUNT"` vs something else, and how many discount rows
   set one column but not the other.
7. **The three dues, side by side — the decisive query.** For patients
   registered in the last 90 days, compare:
   (B) `SUM(test_rate) − SUM(patient_billing.amount)`,
   (C) `tbl_billing_patient_detail.Balance` joined on `medid = patient.id`,
   and (C′) `amount + service_tax − discount_amount − amount_paid` recomputed.
   How many patients appear in B but not C, in C but not B, and how many have
   B ≠ C? What is the total money in each? **This decides which model F3 is
   about, and it is the only question here that changes the shape of the
   build.**
8. **Does the wallet reconcile to its movements?** For each account:
   `currentbalance` vs
   `SUM(account_detail signed by credittype) − SUM(test_transactions.testcharges)`.
   How many accounts reconcile exactly? Related: does
   `tbl_med_mcc_test_transactions.closingbalance` of the latest row equal
   `currentbalance`, and are there gaps where one row's `closingbalance` ≠ the
   next row's `currentbalance` (the non-transactional write of §7.2)?
   And: for rows Telo wrote, does `debit_flag = 1` mean "order debit"
   (§10.2 item 4)?
9. **Is the lock live?** (a) How many clients have `creditlimit < 0`, and what
   is the distribution? (b) How many have `PerminentUnlock = 1`? (c) How many
   rows in `tbl_med_mcc_lockunlock`, and how many have `expire_unlock` in the
   future right now — i.e. is the temporary unlock a lever the lab actually
   pulls (§10.2 item 5)? (d) How many accounts are currently in debit
   (`currentbalance < 0`), how many are below their floor, and how much money
   is that in total? (e) Any NULL or positive-but-nonzero `creditlimit`?
   (f) Any client with **no** wallet row, or **two** (both crash
   `LedgerBalance`)?
10. **The abandoned procedures.** Do `usp_bill_due_report` and
    `usp_bill_due_summary` still exist in the database, and what do their
    bodies do? They are the lab's original statement of this feature and may
    already contain the client filter and the `rectype` split the LINQ dropped.
11. **Volume and shape.** Row counts and 90-day activity for
    `tbl_med_mcc_patient_billing`, `tbl_med_mcc_account_detail`,
    `tbl_med_mcc_test_transactions`; distinct `paymode` and `deposittype`
    values with counts (which of the 7 payment modes are actually used);
    how many patients currently have a model-B due > 0 and what is the total.
    Also: any **negative** amounts in `tbl_med_mcc_patient_billing` (the §4.2
    item-1 divergence), any NULL `currentbalance`.
12. **Indexes.** `tbl_med_mcc_patient_billing(patientid)`,
    `(received_date, paymode)`, `tbl_med_mcc_patient_test(patient_id)`,
    `tbl_med_mcc_account_detail(mcccode, depositedate)`,
    `tbl_med_mcc_test_transactions(mccid, transdate)` — the dues aggregate is
    a full scan of two large tables per page load unless these exist.
13. **`PrintBill` traffic.** Any `tbl_med_mcc_patient_billing` rows with
    `payment_refrence = 'New'` (the PrintBill signature) — how many, over what
    period, and are there exact duplicates (same `patientid`, `amount`,
    `received_by` within seconds) that would prove the refresh double-count of
    §9.7?

---
*Role A, F3, 2026-08-17. Sources: all three trees under `E:\Listec Genomics`
diffed (`MedCis.UI` copies byte-identical; `Payment\` is a namespace-only fork;
`razor_update.asmx` is NOBLE-only), cross-referenced against
`api/src/Infinity.Api` and `api/db/sql` at `feat/lis-phase-1`. No E:\ file was
modified; no database was queried.*
