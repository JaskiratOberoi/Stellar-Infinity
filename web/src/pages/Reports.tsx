import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, csrfHeader } from '../api/client';
import { downloadFile, fmtDateTime } from '../lib/format';
import { ReportViewer } from './ReportViewer';
import { SmartReportModal } from './SmartReport';
import { InfinityLoader } from '../components/InfinityLoader';
import { Pager } from '../components/Pager';
import { useAuth } from '../auth/AuthContext';
import { TestList } from '../components/TestList';
import {
  SampleFilters, useFilterOptions, applyFilterParams,
  initialFilters, type SampleFilterValues,
} from '../components/SampleFilters';
import { LetterheadToggle, useLetterhead } from '../components/LetterheadToggle';
import { PidReportButton } from '../components/PidReportButton';

export interface WorksheetRow {
  sid: string;
  clientCode: string | null;
  businessUnit: string | null;
  pid: number;
  patientName: string | null;
  sex: string | null;
  age: number | null;
  ageUnit: string | null;
  sampleDrawn: string | null;
  registeredAt: string | null;
  lastModifiedAt: string | null;
  statusCode: number | null;
  status: string | null;
  testNames: string | null;
  orderNumber: string | null;
  billNumber: string | null;
  clinicalHistory: string | null;
  /** Specimen, e.g. "WB - EDTA". */
  sampleType?: string | null;
  /** The lab's note on WHY a sample is where it is — rejection reason, QNS,
   *  hold. tbl_med_mcc_patient_samples.Sample_Comments. */
  sampleComments?: string | null;
  /** 1 EDTA · 2 fluoride · 3 serum · 4 urine · 5 the rest. */
  specimenRank?: number | null;
  /**
   * Did this patient's order include the paid Smart Report (SMART-RPT)?
   *
   * The Smart Report is a ₹99 extra, not something every report has. The
   * button is drawn only where this is true; the routes that serve it check
   * the same thing server-side, because a hidden control is a courtesy and a
   * URL is not.
   */
  smartReport?: boolean;
}

/**
 * The statuses a REPORT exists for: authorised, partially printed, printed.
 *
 * Reporting and the worksheet call the same procedure, and that procedure
 * treats a missing status filter as "every status" (see
 * 76_usp_inf_worksheet_list.sql — `@statusCount = 0 OR ...`, with only
 * sample_status > 1 excluded). This page was sending no filter at all, so it
 * listed registered and partially-tested samples as though they were reports.
 *
 * 7/8/9 is not a new invention here: it is the set the rest of the system
 * already treats as signed out — result save refuses it (51), reopen requires
 * it (52), instrument ingest will not touch it (72), and the deploy check calls
 * exactly this set "reportable" (93).
 *
 * 6 (partially authorised) is deliberately NOT in it. Some of its tests are
 * still unsigned, so there is no finished report to look at yet; it belongs on
 * the worksheet, where it is already listed as outstanding work.
 */
const REPORTABLE_STATUSES = [7, 8, 9];

/** What one balance lock looks like, as /api/reports/locks reports it. */
interface RowLock { reason: 'patient' | 'client' | null; dueAmount: number }

/** The same sentence the server's 423 sends, so both paths say one thing. */
const lockMsg = (l: RowLock) =>
  `This report is on hold: ₹${Math.round(l.dueAmount).toLocaleString('en-IN')} outstanding on the ` +
  `${l.reason === 'client' ? 'client account' : "patient's bill"}. Clear the balance to release it.`;

const LockGlyph = () => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth="2.4" aria-hidden="true" style={{ marginRight: '.3rem', verticalAlign: '-1px' }}>
    <rect x="4" y="11" width="16" height="10" rx="2" />
    <path d="M8 11V7a4 4 0 0 1 8 0v4" />
  </svg>
);

export function Reports() {
  const { user } = useAuth();
  /*
   * A CLIENT sees every sample, not only finished reports — this page is
   * their port of the LIS's Sample Status screen, where a centre watches a
   * sample move Registered → Tested → Printed and attaches clinical history
   * along the way. View/Smart still appear only once a report exists; the
   * pill carries the tracking. Lab staff keep the reports-only view — their
   * pending work already lives on the worksheet.
   */
  const isClient = user?.role === 'client';
  const [rows, setRows] = useState<WorksheetRow[]>([]);
  const [scope, setScope] = useState<string>('');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openSid, setOpenSid] = useState<string | null>(null);
  const [smartSid, setSmartSid] = useState<string | null>(null);

  /*
   * Balance locks for the page, keyed by SID — the advisory mirror of the
   * server's 423. A locked row draws a lock in place of View and a click
   * explains the dues in a toast, instead of opening a viewer whose first
   * fetch refuses. The 423 on the view, smart and PDF routes remains the
   * enforcement; if this map is stale or the lookup failed, the worst case is
   * the old behaviour, never a leaked report.
   */
  const [locks, setLocks] = useState<Record<string, RowLock>>({});
  /** SIDs on this page that carry an attached clinical-history PDF. */
  const [cliHis, setCliHis] = useState<Set<string>>(new Set());
  /** The row whose clinical-history dialog is open. */
  const [cliSid, setCliSid] = useState<WorksheetRow | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);
  const showToast = (msg: string) => {
    setToast(msg);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 4500);
  };

  // The merge basket. Keyed by SID and deliberately NOT cleared when the page
  // changes: picking three reports on page 1 and two on page 3 has to give five.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  /*
   * Group a patient's samples together, as the worksheet already does.
   *
   * A patient arriving once commonly leaves four tubes, and this list is
   * newest-first — so their samples sit together by luck of timing and apart
   * the moment anything else is registered between them. Grouping states the
   * relationship instead of leaving it to be noticed.
   */
  /*
   * Grouping is not a setting.
   *
   * A patient's samples belong together on a reporting screen — the whole point
   * of the list is to release a person's results — and a toggle that can take
   * that apart only invites someone to work from a view where four tubes of one
   * patient read as four unrelated people. The worksheet offers the choice
   * because a technologist sometimes works a bench in registration order; this
   * screen has no such case.
   */
  /** The PID whose complete report is being prepared, so only its own row spins. */
  const [pidBusy, setPidBusy] = useState<number | null>(null);
  const [total, setTotal] = useState(0);
  const [patients, setPatients] = useState(0);
  const [withGraphs, setWithGraphs] = useState(true);
  const [letterhead, setLetterhead] = useLetterhead();
  const [merging, setMerging] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);

  // The same filter set the worksheet offers. Reporting reads the same endpoint,
  // which accepts the same filters, so there is no reason for it to offer fewer.
  const [filters, setFilters] = useState<SampleFilterValues>(() => initialFilters(7));
  const options = useFilterOptions();

  const toggle = (sid: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (!next.delete(sid)) next.add(sid);
      return next;
    });

  /**
   * Samples collected under one patient, in the order the list already has.
   *
   * Deliberately the same shape and the same rule as the worksheet's grouping:
   * order WITHIN a group and the order OF groups both follow the original list,
   * which is newest-registered first. Sorting by PID would scramble the
   * chronology the list is read in.
   */
  const grouped = useMemo(() => {

    const order: number[] = [];
    const byPid = new Map<number, WorksheetRow[]>();
    for (const r of rows) {
      // A row with no PID cannot be grouped with anything; give each its own
      // bucket rather than collecting unrelated samples under a shared 0.
      const key = r.pid || -(order.length + 1);
      if (!byPid.has(key)) { byPid.set(key, []); order.push(key); }
      byPid.get(key)!.push(r);
    }
    return order.map((pid) => ({
      pid,
      // Bench order within the patient: EDTA, fluoride, serum, urine, then
      // the rest — the order the tubes are picked up, and the order their
      // reports combine in the PID download. The list's own row order breaks
      // ties, so two serum tubes keep their chronology.
      rows: [...byPid.get(pid)!].sort(
        (a, b) => (a.specimenRank ?? 5) - (b.specimenRank ?? 5)),
    }));
  }, [rows]);

  /** Flattened rows carrying what the table needs to band and bracket a group. */
  const tableRows = useMemo(() => {
    const out: {
      row: WorksheetRow; band: 0 | 1; indexInGroup: number;
      groupSize: number; isGroupStart: boolean; isGroupEnd: boolean;
    }[] = [];
    let rowIndex = 0;
    grouped.forEach((g, groupIndex) => {
      g.rows.forEach((row, i) => {
        out.push({
          row,
          // Grouped: one band per PATIENT, so a person's tubes share a shade.
          // Ungrouped: ordinary zebra striping.
          // One band per PATIENT, so a person's tubes share a shade and the
          // next patient flips. The band IS the group boundary, which reads far
          // better down a dense list than a hairline rule.
          band: (groupIndex % 2) as 0 | 1,
          indexInGroup: i,
          groupSize: g.rows.length,
          isGroupStart: i === 0,
          isGroupEnd: i === g.rows.length - 1,
        });
        rowIndex += 1;
      });
    });
    return out;
  }, [grouped]);

  const multiSamplePatients = grouped.filter((g) => g.rows.length > 1).length;

  /**
   * Every report this patient has ON THIS PAGE, as one merged PDF.
   *
   * The LIS does this from a click on the PID, and this is the same gesture.
   * It reuses the bulk route rather than adding a by-patient one, which means
   * each SID goes through the identical gates — scope, the balance lock, the
   * signatory check — and one that fails is reported as skipped instead of
   * failing the rest.
   *
   * SCOPED TO WHAT IS LISTED, deliberately. The patient's other samples may sit
   * outside the current date window or filters, and quietly widening the
   * download beyond what the operator can see would hand them a document they
   * did not ask for and cannot check.
   */
  const downloadPatient = async (pid: number, sids: string[], letterhead: boolean) => {
    setPidBusy(pid);
    setMergeError(null);
    try {
      await downloadFile('/api/reports/pdf/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...csrfHeader() },
        // deptMajor: assembled the way the LIS's PID report is — departments on
        // the outside, samples within, so a sample whose tests span two
        // departments prints in both places. splitDept rides along because each
        // of those runs is still a department that never shares a page with the
        // next. The letterhead answer is per download — see PidReportButton.
        body: JSON.stringify({
          sids, withGraph: withGraphs, splitDept: true, deptMajor: true, headless: !letterhead,
        }),
        fallbackName: `Reports_PID_${pid}.pdf`,
      });
    } catch (e) {
      setMergeError(e instanceof Error ? e.message : 'The download failed.');
    } finally {
      setPidBusy(null);
    }
  };

  const downloadMerged = async () => {
    setMerging(true);
    setMergeError(null);
    try {
      await downloadFile('/api/reports/pdf/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...csrfHeader() },
        body: JSON.stringify({ sids: [...selected], withGraph: withGraphs, headless: !letterhead }),
        fallbackName: 'Reports.pdf',
      });
    } catch (e) {
      setMergeError(e instanceof Error ? e.message : 'The merged download failed.');
    } finally {
      setMerging(false);
    }
  };

  // The in-flight search, so a new one cancels it and Stop can kill it.
  const searchRef = useRef<AbortController | null>(null);
  const stopSearch = useCallback(() => { searchRef.current?.abort(); }, []);

  const load = useCallback(async () => {
    searchRef.current?.abort();
    const ctrl = new AbortController();
    searchRef.current = ctrl;
    setLoading(true);
    setError(null);
    try {
      const p = new URLSearchParams({ page: String(page), pageSize: '50' });
      applyFilterParams(p, filters);
      // Sent to the SERVER, not applied to the response: filtering after the
      // fact would make a page of 50 arrive as 6 rows with a dead Next button,
      // which reads as "that is all there is" when it is not. The worksheet
      // learned this the same way — see PENDING_STATUSES there.
      // Clients get NO status filter — every sample, tracked by its pill,
      // like the LIS Sample Status screen they came from.
      if (!isClient) p.set('statusIds', REPORTABLE_STATUSES.join(','));
      // No client timeout — a reconciliation over months of reports outlives
      // the 20s default. Stop (or the server's SQL timeout) ends a long one.
      const r = await api.get<{
        rows: WorksheetRow[]; count: number; total: number; patients: number; scope: string;
      }>(`/api/reports/?${p}`, { signal: ctrl.signal, timeoutMs: null });
      setRows(r.rows);
      setScope(r.scope);
      setTotal(r.total);
      setPatients(r.patients ?? 0);
      // Lock states ride a second, non-blocking request so the list never
      // waits on fifty balance checks. Until they land (or if they fail) the
      // buttons behave as before, and the server's 423 still guards.
      setLocks({});
      setCliHis(new Set());
      if (r.rows.length > 0) {
        void api.post<{ locks: Record<string, RowLock> }>(
          '/api/reports/locks', { sids: r.rows.map((x) => x.sid) },
        ).then((l) => setLocks(l.locks)).catch(() => { /* advisory only */ });
        // Which rows already carry a clinical-history PDF, so the paperclip
        // can say so. Advisory the same way the locks are.
        void api.post<{ sids: string[] }>(
          '/api/reports/clinical-history/flags', { sids: r.rows.map((x) => x.sid) },
        ).then((f) => setCliHis(new Set(f.sids))).catch(() => { /* advisory only */ });
      }
    } catch (e) {
      // Stopped or superseded is not a failure; the list stays as it was.
      if (e instanceof DOMException && e.name === 'AbortError') return;
      setError(e instanceof Error ? e.message : 'Could not load the worksheet.');
    } finally {
      // A superseded search leaves the spinner to its successor.
      if (searchRef.current === ctrl) setLoading(false);
    }
  }, [filters, page, isClient]);

  useEffect(() => {
    const id = setTimeout(() => void load(), 300);
    return () => clearTimeout(id);
  }, [load]);

  // A filter that narrows the set must reset the page, or page 4 of the old
  // result set silently shows nothing for the new one.
  useEffect(() => { setPage(1); }, [filters]);

  return (
    <div className="page">
      <div className="page__head">
        <div>
          <h1 className="page__title">Reporting</h1>
          <p className="page__sub">
            {/* The FILTERED set, not the page — a reconciliation counts the
                day, and the day rarely fits one page. */}
            {total.toLocaleString()} sample{total === 1 ? '' : 's'}
            {patients > 0 && ` · ${patients.toLocaleString()} patient${patients === 1 ? '' : 's'}`}
            {multiSamplePatients > 0 && ` · ${multiSamplePatients} on this page with more than one sample`}
            {scope && ` · ${scope === 'all' ? 'all centres' : scope}`}
          </p>
        </div>

      </div>

      {/* One filter area, the same component the worksheet uses. No status
          control: this page pins the reportable set, so offering a choice it
          would override would be a control that lies. */}
      {/* A centre's reports are its own by definition, so the client filter is
          pinned rather than offered. The API resolves the scope from the
          session on every request regardless — this stops the control implying
          a choice that does not exist. */}
      <SampleFilters value={filters} options={options} onChange={setFilters}
                     lockClientCode={user?.role === 'client'} />

      {scope === 'none' && (
        <div className="alert alert--info" style={{ marginBottom: '.9rem' }}>
          No centres are assigned to your account for reporting, so there is nothing to show. An administrator
          can grant client codes to your user.
        </div>
      )}

      {error && <div className="alert alert--error" style={{ marginBottom: '.9rem' }}>{error}</div>}

      {loading ? (
        <div className="center">
          <InfinityLoader /><span className="muted">Loading worksheet…</span>
          <button className="btn btn--ghost btn--sm" onClick={stopSearch}>Stop search</button>
        </div>
      ) : (
        <>
          {/* The batch bar. Present only once something is picked: an empty
              toolbar is a permanent reminder of a feature nobody is using yet.

              It renders here but does NOT sit here — it is fixed to the foot
              of the viewport (see .batchbar), so it stays in reach however far
              down the list the selection was made. Left in the markup above
              the table because that is where it belongs in reading order: the
              control follows the count it acts on. */}
          {selected.size > 0 && (
            <div className="batchbar">
              <span className="batchbar__count">
                <b>{selected.size}</b> selected
              </span>

              <label className="row" style={{ gap: '.45rem', fontSize: '.78rem', cursor: 'pointer' }}
                     title="Each report's LIS graph pages follow its own report inside the merged PDF, exactly as the printed report staples them.">
                <input type="checkbox" checked={withGraphs} disabled={merging}
                       onChange={(e) => setWithGraphs(e.target.checked)} />
                Include graphs
              </label>

              {/* Merged batches keep the remembered preference — a batch is
                  one print run on one kind of paper. PID downloads ask per
                  click instead: see PidReportButton. */}
              <LetterheadToggle value={letterhead} onChange={setLetterhead} disabled={merging} />

              <button className="btn btn--ghost btn--sm" disabled={merging}
                      onClick={() => setSelected(new Set())}>
                Clear
              </button>
              <button className="btn btn--primary btn--sm" disabled={merging}
                      onClick={() => void downloadMerged()}>
                {merging ? 'Preparing…' : `Download ${selected.size} as one PDF`}
              </button>
            </div>
          )}

          {mergeError && <div className="alert alert--error" style={{ marginBottom: '.8rem' }}>{mergeError}</div>}

          <div className="table-wrap table-wrap--cards">
            <table>
              <thead>
                <tr>
                  <th className="cell--pick">
                    <input
                      type="checkbox"
                      aria-label="Select every report on this page"
                      checked={rows.length > 0 && selected.size === rows.length}
                      // Some-but-not-all is its own state; a plain unticked box
                      // would claim nothing is selected.
                      ref={(el) => { if (el) el.indeterminate = selected.size > 0 && selected.size < rows.length; }}
                      onChange={(e) => setSelected(e.target.checked ? new Set(rows.map((r) => r.sid)) : new Set())}
                    />
                  </th>
                  <th>PID</th>
                  <th>SID</th>
                  <th>Patient</th>
                  <th>Client</th>
                  <th>Tests</th>
                  <th>Status</th>
                  <th>Registered</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {tableRows.map(({ row: r, band, indexInGroup: i, groupSize, isGroupStart, isGroupEnd }) => (
                  <tr
                    key={r.sid}
                    className={[
                      `band-${band}`,
                      groupSize > 1 ? 'pid-group' : '',
                      groupSize > 1 && isGroupStart ? 'pid-group--first' : '',
                      groupSize > 1 && isGroupEnd ? 'pid-group--last' : '',
                    ].filter(Boolean).join(' ')}
                    style={{ cursor: 'pointer' }}
                    onClick={() => {
                      if (!REPORTABLE_STATUSES.includes(r.statusCode ?? -1)) {
                        showToast(r.sampleComments?.trim()
                          ? `Not ready — the lab says: ${r.sampleComments.trim()}`
                          : 'This sample’s report is not ready yet — the status column tracks it.');
                        return;
                      }
                      const l = locks[r.sid];
                      if (l) showToast(lockMsg(l)); else setOpenSid(r.sid);
                    }}
                  >
                    {/* Picking a report is not opening it, so the click stops
                        here rather than bubbling to the row. */}
                    <td className="cell--pick" data-label="Select" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        aria-label={`Select report ${r.sid}`}
                        checked={selected.has(r.sid)}
                        onChange={() => toggle(r.sid)}
                      />
                    </td>
                    {/* The PID leads the row: it is what identifies the person
                        the block belongs to, and the samples under it are that
                        person's. Written once at the top of the group — repeating
                        it down a bracketed block is noise — with the whole
                        patient's report behind it. */}
                    <td className="mono cell--lead" data-label="PID"
                        onClick={(e) => { if (i === 0) e.stopPropagation(); }}>
                      {i === 0 && r.pid ? (
                        /* A LINK, not a button. The ghost-button pill wrapped
                           the id and its badge onto two lines and swallowed the
                           column — the row read as a blob of chrome around a
                           number. The id itself is the control: mono like the
                           SID beside it, a download glyph to say it does
                           something, and the sample count as a plain suffix
                           rather than a badge fighting for the same line. */
                        <PidReportButton
                          pid={r.pid}
                          busy={pidBusy === r.pid}
                          disabled={pidBusy !== null}
                          count={groupSize}
                          title={
                            groupSize > 1
                              ? `Download all ${groupSize} of this patient's reports on this page as one PDF`
                              : "Download this patient's report"
                          }
                          onDownload={(lh) => void downloadPatient(
                            r.pid,
                            (grouped.find((g) => g.rows.some((x) => x.sid === r.sid))?.rows ?? [r])
                              .map((x) => x.sid),
                            lh,
                          )}
                        />
                      ) : (
                        // Inside a group the column is left TRULY empty — null,
                        // not an empty span — so the card layout's :empty rule
                        // can collapse it on a phone. The bracket and the shared
                        // band already say whose sample this is.
                        !r.pid && i === 0 ? <span className="muted">—</span> : null
                      )}
                    </td>
                    <td className="mono cell--meta" data-label="SID">{r.sid}</td>
                    <td className="cell--head">
                      {/* Repeating the name on every sample of the same patient
                          is noise; the grouping already says it. Same treatment
                          the worksheet gives it. */}
                      {i > 0 ? (
                        <span className="muted" style={{ fontSize: '.76rem' }}>↳ same patient</span>
                      ) : (
                        <>
                          {r.patientName ?? <span className="muted">—</span>}
                          <div className="muted" style={{ fontSize: '.72rem' }}>
                            {[r.sex, r.age != null ? `${r.age}${r.ageUnit?.[0] ?? ''}` : null].filter(Boolean).join(' · ')}
                          </div>
                        </>
                      )}
                    </td>
                    <td className="muted cell--meta" data-label="Client">{r.clientCode ?? '—'}</td>
                    <td className="cell--body" data-label="Tests">
                      <TestList names={r.testNames} />
                    </td>
                    <td className="cell--tag">
                      <StatusBadge status={r.status} statusCode={r.statusCode} />
                      {/* The WHY under the pill, for a sample that is not a
                          report yet — the rejection reason or hold note the
                          lab wrote. A finished report keeps its comments on
                          the report itself, where they always printed. */}
                      {!REPORTABLE_STATUSES.includes(r.statusCode ?? -1) && r.sampleComments?.trim() && (
                        <div className="muted" style={{ fontSize: '.7rem', marginTop: '.2rem',
                                                        maxWidth: 220, lineHeight: 1.4 }}
                             title={r.sampleComments}>
                          {r.sampleComments.trim()}
                        </div>
                      )}
                    </td>
                    <td className="muted cell--meta" data-label="Registered" style={{ fontSize: '.78rem' }}>
                      {fmtDateTime(r.registeredAt)}
                    </td>
                    {/* The gap between the two buttons is cell--action's job now,
                        so that on a card they can split the foot evenly. */}
                    <td className="cell--action">
                      {/* Clinical history rides on EVERY row — a pending
                          sample is exactly when the lab still wants context.
                          The LIS offered this from its Sample Status screen;
                          here it lives beside the row it belongs to. */}
                      <button
                        className="btn btn--ghost btn--sm"
                        title={cliHis.has(r.sid)
                          ? 'Clinical history attached — view or replace'
                          : 'Attach a clinical history PDF for the lab'}
                        aria-label={`Clinical history for ${r.sid}`}
                        style={cliHis.has(r.sid) ? { color: 'var(--teal)', fontWeight: 600 } : undefined}
                        onClick={(e) => { e.stopPropagation(); setCliSid(r); }}
                      >
                        <ClipGlyph />{cliHis.has(r.sid) ? ' Hist.' : ''}
                      </button>
                      {!REPORTABLE_STATUSES.includes(r.statusCode ?? -1) ? (
                        /* No report yet — the pill says where it is; a View
                           button that opens an empty sheet reads as a bug. */
                        null
                      ) : locks[r.sid] ? (
                        /* A HELD report offers no viewer at all — not a modal
                           that opens and then refuses. One lock stands in for
                           both View and Smart (they answer the same 423), and
                           clicking it says what is owed instead of doing
                           nothing, because a dead control reads as a bug. */
                        <button
                          className="btn btn--ghost btn--sm btn--locked"
                          title={lockMsg(locks[r.sid])}
                          onClick={(e) => { e.stopPropagation(); showToast(lockMsg(locks[r.sid])); }}
                        >
                          <LockGlyph /> Locked
                        </button>
                      ) : (
                        <>
                          <button className="btn btn--ghost btn--sm" onClick={(e) => { e.stopPropagation(); setOpenSid(r.sid); }}>
                            View
                          </button>
                          {/* Only where the patient BOUGHT it. The Smart Report is
                              a paid extra and the API refuses a SID without the
                              purchase — a button that always renders is a button
                              that sometimes answers 404, which is exactly what an
                              operator reported. The modal's own Smart control is
                              gated the same way below; the server check remains the
                              enforcement either way. */}
                          {r.smartReport && (
                            <button className="btn btn--primary btn--sm"
                                    onClick={(e) => { e.stopPropagation(); setSmartSid(r.sid); }}>
                              Smart
                            </button>
                          )}
                        </>
                      )}
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && scope !== 'none' && (
                  <tr>
                    <td colSpan={7} className="muted" style={{ textAlign: 'center', padding: '2rem' }}>
                      No samples in this window.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* The shared pager — the procedure has returned a real total for a
              while; this page was the last one still guessing from a full
              page. */}
          <div style={{ marginTop: '1rem' }}>
            <Pager page={page} pageSize={50} total={total} noun="sample" onPage={setPage} />
          </div>
        </>
      )}

      {openSid && (
        <ReportViewer
          sid={openSid}
          // The preview draws its own header from the report; this is only the
          // name on the modal's own title bar, so the row we already have is
          // the right source and costs nothing.
          patientName={rows.find((r) => r.sid === openSid)?.patientName ?? null}
          onClose={() => setOpenSid(null)}
          // Offered ONLY where the patient bought it. Passing undefined is what
          // hides the button — see ReportViewer, which omits the control when
          // it has no handler.
          onSmart={
            rows.find((r) => r.sid === openSid)?.smartReport
              // Swap one modal for the other rather than stacking them — two
              // dialogs deep, Escape closes the wrong one.
              ? (s) => { setOpenSid(null); setSmartSid(s); }
              : undefined
          }
        />
      )}
      {smartSid && <SmartReportModal sid={smartSid} onClose={() => setSmartSid(null)} />}
      {cliSid && (
        <ClinicalHistoryModal
          row={cliSid}
          has={cliHis.has(cliSid.sid)}
          onClose={() => setCliSid(null)}
          onChanged={(sid, nowHas) => {
            setCliHis((prev) => {
              const next = new Set(prev);
              if (nowHas) next.add(sid); else next.delete(sid);
              return next;
            });
            showToast(nowHas
              ? 'Clinical history attached — the lab sees it on the worksheet.'
              : 'Clinical history removed.');
            setCliSid(null);
          }}
        />
      )}
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}

const ClipGlyph = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth="2.1" aria-hidden="true" style={{ verticalAlign: '-2px' }}>
    <path d="M21.4 11.05 12.25 20.2a6 6 0 0 1-8.49-8.49l8.57-8.57a4 4 0 1 1 5.66 5.66l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
  </svg>
);

/**
 * Attach / view / replace / remove a sample's clinical-history PDF — the port
 * of the LIS Sample Status upload, one dialog per row. The file lands where
 * the LEGACY worksheet already looks (clihis.ashx, SID-keyed), so a tech on
 * either system opens the same document.
 */
function ClinicalHistoryModal({ row, has, onClose, onChanged }: {
  row: WorksheetRow;
  has: boolean;
  onClose: () => void;
  onChanged: (sid: string, nowHas: boolean) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const pick = (f: File | null) => {
    setErr(null);
    if (!f) { setFile(null); return; }
    if (!/\.pdf$/i.test(f.name)) { setErr('Only PDF files can be attached.'); setFile(null); return; }
    if (f.size > 10 * 1024 * 1024) { setErr('That PDF is larger than 10 MB.'); setFile(null); return; }
    setFile(f);
  };

  const upload = async () => {
    if (!file) return;
    setBusy(true); setErr(null);
    try {
      const b64 = await new Promise<string>((resolve, reject) => {
        const rd = new FileReader();
        rd.onerror = () => reject(new Error('The file could not be read.'));
        rd.onload = () => resolve(String(rd.result).split(',')[1] ?? '');
        rd.readAsDataURL(file);
      });
      await api.put(`/api/reports/${encodeURIComponent(row.sid)}/clinical-history`, { fileBase64: b64 });
      onChanged(row.sid, true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'The file could not be attached.');
    } finally {
      setBusy(false);
    }
  };

  const view = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await fetch(`/api/reports/${encodeURIComponent(row.sid)}/clinical-history`, { credentials: 'include' });
      if (!r.ok) throw new Error('The file could not be opened.');
      const blob = await r.blob();
      window.open(URL.createObjectURL(blob), '_blank', 'noopener');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'The file could not be opened.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true); setErr(null);
    try {
      await api.delete(`/api/reports/${encodeURIComponent(row.sid)}/clinical-history`);
      onChanged(row.sid, false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'The file could not be removed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <h2 className="modal__title">Clinical history</h2>
        <p className="muted" style={{ fontSize: '.82rem', marginTop: '.2rem' }}>
          Sample <b className="mono">{row.sid}</b>
          {row.patientName ? <> · {row.patientName}</> : null}
        </p>
        <p className="muted" style={{ fontSize: '.8rem', lineHeight: 1.6, marginTop: '.6rem' }}>
          {has
            ? 'A clinical history PDF is attached — the lab opens it from the worksheet. Uploading another replaces it.'
            : 'Attach a PDF — referral notes, prescriptions, prior reports — and the lab sees it on the worksheet for this sample.'}
        </p>

        <div className="field" style={{ marginTop: '.8rem' }}>
          <input type="file" accept="application/pdf,.pdf" aria-label="Clinical history PDF"
                 onChange={(e) => pick(e.target.files?.[0] ?? null)} />
          <span className="muted" style={{ fontSize: '.72rem' }}>PDF, up to 10 MB.</span>
        </div>

        {err && <p style={{ color: 'var(--danger)', fontSize: '.8rem', marginTop: '.5rem' }}>{err}</p>}

        <div className="modal__actions">
          {has && (
            <>
              <button className="btn btn--ghost" disabled={busy} onClick={() => void view()}>
                View current
              </button>
              <button className="btn btn--ghost" disabled={busy} style={{ color: 'var(--danger)' }}
                      onClick={() => void remove()}>
                Remove
              </button>
            </>
          )}
          <button className="btn btn--ghost" disabled={busy} onClick={onClose}>Cancel</button>
          <button className="btn btn--primary" disabled={busy || !file} onClick={() => void upload()}>
            {busy ? 'Working…' : has ? 'Replace' : 'Attach'}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Sample status, in the hue the LIS taught everyone.
 *
 * The LIS colours each status by name in SampleWorksheet.aspx.cs, via the
 * .status_reg / .status_tested / .status_auth classes in
 * MedCis.UI/Styles/responsible/css/style1.css. Those are pale FILLS designed to
 * sit behind black text in a grid row; here they become the ink of an outline
 * badge instead, so what carries over is the family — orange for tested, green
 * for authorised, blue for printed, red for rejected, magenta for pending, grey
 * for registered — at a shade that is actually readable. See the
 * .badge--lis-status block in styles.css for the measured values.
 *
 * Keyed on status_code, not on the label: the code is the LIS's own identifier
 * and the wording has been renamed before. The label is matched only as a
 * fallback, for callers that carry the string and nothing else.
 */
const STATUS_HUE: Record<number, string> = {
  1: 'neutral',   // Sample Sent           LIS #ffffff
  2: 'neutral',   // Sample Registered     LIS #F3F3F3
  3: 'red',       // Rejected              LIS #ff0000
  4: 'amber',     // Partially Tested      LIS #F8CAAA
  5: 'orange',    // Tested                LIS #F4A778
  6: 'lime',      // Partially Authorized  LIS #A3F46C
  7: 'green',     // Authorized            LIS #AFFD8E
  8: 'sky',       // Partially Printed     LIS #BDD7ED
  9: 'blue',      // Printed               LIS #B7D2EC
  10: 'magenta',  // Pending               LIS #990066
};

/** Fallback for callers that have the label but not the code. */
function hueFromLabel(status: string): string | undefined {
  const s = status.toLowerCase();
  if (s.includes('reject')) return STATUS_HUE[3];
  if (s.includes('pending')) return STATUS_HUE[10];
  if (s.includes('partially print')) return STATUS_HUE[8];
  if (s.includes('print')) return STATUS_HUE[9];
  if (s.includes('partially auth')) return STATUS_HUE[6];
  if (s.includes('auth')) return STATUS_HUE[7];
  if (s.includes('partially test')) return STATUS_HUE[4];
  if (s.includes('test')) return STATUS_HUE[5];
  if (s.includes('sent')) return STATUS_HUE[1];
  if (s.includes('regist')) return STATUS_HUE[2];
  return undefined;
}

export function StatusBadge({ status, statusCode }: { status: string | null; statusCode?: number | null }) {
  if (!status) return <span className="muted">—</span>;

  const hue = (statusCode != null ? STATUS_HUE[statusCode] : undefined) ?? hueFromLabel(status);
  if (!hue) return <span className="badge badge--lis">{status}</span>;

  return <span className={`badge badge--lis-status status--${hue}`}>{status}</span>;
}
