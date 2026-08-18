# F1 — Sample transit / inward tracking: completeness review

Role E (completeness critic) output for Phase P1, 2026-08-17. Compared:

- Role A: `f1-inward-contract.md`
- Role B: `f1-inward-schema.md`
- Role C: SQL/API/UI in the current Phase 1 change set
- Role D: `f1-inward-verification.md`

The phase is functionally built and its safe production probes pass, but it
does **not** yet meet the plan's empty-gap exit criterion. The remaining gaps
are listed below; no uncovered contract line is silently treated as complete.

## 1. Confirmed complete

- The legacy one-row-per-(vial, unit) model and three-checkpoint null cascade
  are preserved. The fifth scan is a voiced no-op.
- Unknown-vial scans remain logged, with explicit operator feedback.
- SIDs are cleaned on write and lookup; legacy composite scanner names are
  parsed for display.
- Daily per-unit sequence allocation and same-vial concurrency are serialized.
- Sample state is locked and read inside the scan transaction, so concurrent
  Infinity scans cannot write stale unit-change audit history.
- Listing uses inclusive date bounds, dateless exact-SID search, newest-first
  ordering, nullable sex, checkpoint timestamps, and a real capped CSV export.
- Read access is client-code scoped; anonymous, missing-CSRF, and client scan
  attempts are refused.
- The scan box supports continuous keyboard/barcode-gun operation and resets
  feedback per scan.
- Probe cleanup is proven: P29 records zero remaining tracking and audit rows.
- The production web build and containerized .NET API build pass.
- Review fixes are in place for stale list-response races, unit-wide sequence
  locking, and atomic audit-constraint replacement.

Evidence: Role D probes P01–P29.

## 2. Gaps requiring runtime evidence

These paths cannot be exercised against Noble with a synthetic SID because
they require a real workorder and can move or bill a live sample:

1. Sample `business_unit_id` moves to the scanner's unit and `modifieddate`
   changes in the same transaction as the tracking write.
2. A business-unit change appends the expected `inf_result_audit` row.
3. A status-1 sample scanned at head office reuses the existing accession path,
   including its retryable "arrived but not registered" failure state.
4. Workorder-matched response fields and UI verdicts contain patient, tests,
   old unit, status, and accession outcome.

Current evidence is code inspection only. Close these on a disposable database
restored from Noble, or record explicit user acceptance of inspection-only
evidence.

## 3. Other uncovered surfaces

- Positive client scoping: a scoped user seeing a row belonging to its own
  client (the production verification account had no eligible rows).
- Branch-unit list scoping: branch users are now server-locked to their own
  `Business_Unit_id`; head office may see all units. This closes a contract
  omission found during Role E review, but still needs a branch-account probe.
- Explicit `bunit` narrowing, row-cap signalling, the 10,000-row CSV ceiling,
  invalid scanner accounts, and the recent dirty-legacy-row fallback.
- Inactive clients in the picker are not explicitly marked or probed.

These are read-only or error-path probes and may be run against staging when
appropriate accounts/data are available.

## 4. Contract correction: scoped orphan rows

Contract FIX #13 asked for a client-scoped user to see its own no-workorder
scan. Production evidence proves a genuine orphan row has no patient, sample,
client, or other trusted ownership field. Assigning that row to a client would
therefore guess scope and could disclose another client's barcode.

The implementation correctly fails closed and hides unowned orphan rows from
client-scoped users. Satisfying the original line would require new trusted
ownership metadata captured at scan time; it cannot be inferred from the
legacy row. Role E treats FIX #13 as revised by ground rule 5, not as missing
code.

## 5. Coexistence limitation

Infinity serializes Infinity scans, but it cannot guarantee uniqueness against
the still-running LIS writer: the legacy page performs unlocked check-then-
insert and count-then-insert operations. A database trigger or new unique key
would alter the legacy write contract and requires cleanup/cutover planning.

Until the LIS scan page is retired or both writers are moved behind one
database-enforced write path, rare duplicate legs or daily sequence numbers
remain possible during mixed-writer races. This is an explicit coexistence
residual, not an unclaimed concurrency guarantee.

## 6. Open lab decision

The legacy page grants scanning to client usertypes. Infinity currently limits
scanning to `order:accession`, deliberately denying client roles while still
allowing their scoped read-only log. The lab must confirm one of:

- keep scanning lab-only;
- grant scanning to a named client-side role/workflow; or
- mirror the legacy client grant.

Until that decision and the evidence gaps above are closed or explicitly
accepted, `docs/port-inventory.md` correctly remains **IN PROGRESS (P1)**.
