# Port inventory — one row per legacy page

The page-level completeness gate from `agent-port-plan.md` §4. A page's status
may only be: **PORTED** (link to verification), **MERGED** (link to parity
proof), **DROPPED** (link to decision-log entry), or **ASK** (open question).
The project is not done while any row says ASK, or any MERGED row lacks a
parity proof.

Statuses below are the plan's dispositions as of 2026-08-17; the `Proof` column
fills in as phases close. MERGED rows start as `MERGED (unproven)` until a
parity proof exists.

| # | Page | Feature | Status | Proof |
|---|---|---|---|---|
| 1 | Worksheet\Worksheet.aspx | Result entry | MERGED (unproven) | — |
| 2 | Worksheet\SampleWorksheet.aspx | Sample worklist | MERGED (unproven) | — |
| 3 | Worksheet\Accession.aspx | Accessioning | MERGED (unproven) | — |
| 4 | Worksheet\Search.aspx | Sample search | MERGED (unproven) | — |
| 5 | Worksheet\EditWorkOrder.aspx | Edit registered order | MERGED (unproven) | — |
| 6 | Worksheet\Inward.aspx | F1 Transit tracking | **PORTED (P1)** — 1 open ASK (D8) | [contract](contracts/f1-inward-contract.md) · [data](contracts/f1-inward-schema.md) · [verification](contracts/f1-inward-verification.md) 23/24 + [gaps](contracts/f1-inward-gaps.md) · D9 fixed & verified 6/6 · ASK: [D8](port-decisions.md#d8) leading-zero SIDs |
| 7 | Worksheet\Outsourcing.aspx | F7 Referral-out | ASK | — |
| 8 | Worksheet\Extract.aspx | Data extract | ASK | — |
| 9 | Worksheet\IHCReport.aspx | F7 IHC reports | ASK | — |
| 10 | Worksheet\icmr_docs.aspx (+ICMR proj) | F7 ICMR | ASK | — |
| 11 | Worksheet\fancy.aspx | uploader shim | DROPPED | [D1](port-decisions.md#d1) |
| 12 | Admin_Technical\Test_Master.aspx | F2 Catalogue | PORT (P3) | — |
| 13 | Admin_Technical\Test_Parameter_Master.aspx | F2 Catalogue | PORT (P3) | — |
| 14 | Admin_Technical\Parameter_Master.aspx | F2 Catalogue | PORT (P3) | — |
| 15 | Admin_Technical\Profile_Master.aspx | F2 Catalogue | PORT (P3) | — |
| 16 | Admin_Technical\MasterProfile_Master.aspx | F2 Catalogue | PORT (P3) | — |
| 17 | Admin_Technical\Test_Normal_Ranges.aspx | F2 Ranges | PORT (P3) | — |
| 18 | Admin_Technical\Test_Normal_Ranges_Master.aspx | F2 Ranges | PORT (P3) | — |
| 19 | Admin_Technical\Test_Param_Normal_Ranges.aspx | F2 Ranges | PORT (P3) | — |
| 20 | Admin_Technical\Test_Param_Normal_Ranges_Master.aspx | F2 Ranges | PORT (P3) | — |
| 21 | Admin_Technical\Test_Param_Default_Values.aspx | F2 Catalogue | PORT (P3) | — |
| 22 | Admin_Technical\Sample_Master.aspx | F2 Catalogue | PORT (P3) | — |
| 23 | Admin_Technical\Department_Master.aspx | F2 Catalogue | PORT (P3) | — |
| 24 | Admin_Technical\Reason_Master.aspx | F2 Catalogue | PORT (P3) | — |
| 25 | Admin_Technical\Signature_Master.aspx | F2 Catalogue | PORT (P3) | — |
| 26 | Admin_Technical\EditSample_Master.aspx | F2 Catalogue | PORT (P3) | — |
| 27 | Admin_Technical\TestRate_Master.aspx | Rates | MERGED (unproven) | — |
| 28 | Admin_Technical\Profile_Rate_Master.aspx | Rates | MERGED (unproven) | — |
| 29 | Admin_Technical\MasterProfile_Rate_Master.aspx | Rates | MERGED (unproven) | — |
| 30 | Admin_Technical\SpecialRateMaster.aspx | Rates | MERGED (unproven) | — |
| 31 | Admin_Technical\Organism.aspx | F7 Micro | ASK | — |
| 32 | Admin_Technical\Organism_Drugs.aspx | F7 Micro | ASK | — |
| 33 | Admin_Technical\AllergyReport.aspx | F7 Allergy | ASK | — |
| 34 | Billing\Bill.aspx | Invoice | MERGED (unproven) | — |
| 35 | Billing\Billx.aspx | Invoice | MERGED (unproven) | — |
| 36 | Billing\Billreceipts.aspx | Receipts | MERGED (unproven) | — |
| 37 | Billing\Dues.aspx | F3 Dues | **IN PROGRESS (P2)** | — |
| 38 | Billing\DueReport.aspx | F3 Dues | **IN PROGRESS (P2)** | — |
| 39 | Admin_General\Security_Master.aspx | F4 Governance | PORT (P4) | — |
| 40 | Admin_General\UserType_Master.aspx | F4 Governance | PORT (P4) | — |
| 41 | Admin_General\User_Department_Mapping.aspx | F4 Governance | ASK | — |
| 42 | Admin_General\BusinessUnit_Master.aspx | F4 Masters | PORT (P4) | — |
| 43 | Admin_General\MccUnit_Master.aspx | F4 Masters | PORT (P4) | — |
| 44 | Admin_General\Mcc_Account.aspx | Client accounts | MERGED (unproven) | — |
| 45 | Admin_General\Mcc_Account_invoice.aspx | Client accounts | MERGED (unproven) | — |
| 46 | Admin_General\LockUnlock_MCC.aspx | Client accounts | MERGED (unproven) | — |
| 47 | Admin_General\Audit_Trail.aspx | F5 Audit search | PORT (P4) | — |
| 48 | Admin_General\MccUser_Master.aspx | User admin | MERGED (unproven) | — |
| 49 | Admin_General\ChangePassword.aspx | Self-service password | MERGED (unproven) | — |
| 50 | Admin_General\testcosting.aspx | Cost analysis | ASK | — |
| 51 | Admin_General\das-adm.aspx | Dashboards | MERGED (unproven) | — |
| 52 | Admin_General\das-cli.aspx | Dashboards | MERGED (unproven) | — |
| 53 | Admin_General\das-fin.aspx | Dashboards | MERGED (unproven) | — |
| 54 | Admin_General\frm_mcc_franchise_mapping.aspx | Franchise mapping | ASK | — |
| 55 | Admin_General\Birthdays.aspx | Noticeboard | DROPPED | [D2](port-decisions.md#d2) |
| 56 | Admin_General\News.aspx | Noticeboard | DROPPED | [D2](port-decisions.md#d2) |
| 57 | Admin_General\frm_mcc_news_marquee.aspx | Noticeboard | DROPPED | [D2](port-decisions.md#d2) |
| 58 | Admin_General\ScrollingImages.aspx | Noticeboard | DROPPED | [D2](port-decisions.md#d2) |
| 59 | Admin_General\Downloads.aspx | Noticeboard | DROPPED | [D2](port-decisions.md#d2) |
| 60 | Admin_General\Callhealth_Ack.aspx | Noticeboard | DROPPED | [D2](port-decisions.md#d2) |
| 61–80 | Pcc\* (20 pages: Customers, Doctors, PatientWorkOrder, Worder, Workor, Workorder, Workorder_om, Workorder_OM1, SampleSent, SampleStatus, PrintBill, Payment, checkout, ccavRequestHandler, ccavResponse, razorCheckout, razorCallback, hrf, mrf, wa) | F6 Client portal | PORT (P5) | — |
| 81 | Pcc\CourierStatus.aspx | F6 portal | DROPPED (pending P5 confirm) | [D3](port-decisions.md#d3) |
| 82 | Pcc\WebForm1.aspx | scaffolding | DROPPED | [D4](port-decisions.md#d4) |
| 83 | Pcc\WebForm2.aspx | scaffolding | DROPPED | [D4](port-decisions.md#d4) |
| 84 | Sales\SalesCodeWise.aspx | F8 Sales/MIS | PORT (P6, ASK-ranked) | — |
| 85 | Sales\SummarySalesofMCC.aspx | F8 Sales/MIS | PORT (P6, ASK-ranked) | — |
| 86 | Sales\SalesDataForMcc.aspx | F8 Sales/MIS | PORT (P6, ASK-ranked) | — |
| 87 | Sales\SalesTestTransForMcc.aspx | F8 Sales/MIS | PORT (P6, ASK-ranked) | — |
| 88 | Sales\LedgerStatusofMcc.aspx | F8 Sales/MIS | PORT (P6, ASK-ranked) | — |
| 89 | Sales\mis_active.aspx | F8 Sales/MIS | PORT (P6, ASK-ranked) | — |
| 90 | Sales\Sales_user_targets.aspx | F8 Sales/MIS | PORT (P6, ASK-ranked) | — |
| 91 | Sales\BillCfad.aspx | F8 Sales/MIS | PORT (P6, ASK-ranked) | — |
| 92–104 | Inventory\* (13 pages) | Inventory | DROPPED | [D5](port-decisions.md#d5) |
| 105 | Default.aspx / Home.aspx | Shell | MERGED | shell + Dashboard |
| 106 | login.aspx / Signout.aspx | Auth | MERGED | cookie auth, verified this phase of work |
| 107 | Error.aspx | Error page | MERGED | SPA error states |
| 108 | g.aspx | Graph handler | MERGED | attachment endpoints (auth hole closed; verified 2026-08-16) |
| 109 | TinyMce.aspx | Editor asset | DROPPED | [D4](port-decisions.md#d4) |
