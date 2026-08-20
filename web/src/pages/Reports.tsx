import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, csrfHeader } from '../api/client';
import { downloadFile, fmtDateTime } from '../lib/format';
import { ReportViewer } from './ReportViewer';
import { SmartReportModal } from './SmartReport';
import { InfinityLoader } from '../components/InfinityLoader';
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

export function Reports() {
  const { user } = useAuth();
  const [rows, setRows] = useState<WorksheetRow[]>([]);
  const [scope, setScope] = useState<string>('');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openSid, setOpenSid] = useState<string | null>(null);
  const [smartSid, setSmartSid] = useState<string | null>(null);

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
    return order.map((pid) => ({ pid, rows: byPid.get(pid)! }));
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
        // Always department-per-sheet: the complete report mirrors the LIS's
        // PID report, where one department never shares a page with the next.
        // The letterhead answer is per download — see PidReportButton.
        body: JSON.stringify({ sids, withGraph: withGraphs, splitDept: true, headless: !letterhead }),
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

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const p = new URLSearchParams({ page: String(page), pageSize: '50' });
      applyFilterParams(p, filters);
      // Sent to the SERVER, not applied to the response: filtering after the
      // fact would make a page of 50 arrive as 6 rows with a dead Next button,
      // which reads as "that is all there is" when it is not. The worksheet
      // learned this the same way — see PENDING_STATUSES there.
      p.set('statusIds', REPORTABLE_STATUSES.join(','));
      const r = await api.get<{ rows: WorksheetRow[]; count: number; scope: string }>(`/api/reports/?${p}`);
      setRows(r.rows);
      setScope(r.scope);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the worksheet.');
    } finally {
      setLoading(false);
    }
  }, [filters, page]);

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
            {rows.length} sample{rows.length === 1 ? '' : 's'}
            {/* Grouping is always on, so the count of samples alone no longer
                describes the list: it is worth saying how many of those rows
                are the same person, which is what the brackets are showing. */}
            {multiSamplePatients > 0 && ` · ${multiSamplePatients} patient${multiSamplePatients === 1 ? '' : 's'} with more than one sample`}
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
        <div className="center"><InfinityLoader /><span className="muted">Loading worksheet…</span></div>
      ) : (
        <>
          {/* The batch bar. Present only once something is picked: an empty
              toolbar sitting above every list is a permanent reminder of a
              feature nobody is using yet. */}
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
                    onClick={() => setOpenSid(r.sid)}
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
                    <td className="cell--tag"><StatusBadge status={r.status} statusCode={r.statusCode} /></td>
                    <td className="muted cell--meta" data-label="Registered" style={{ fontSize: '.78rem' }}>
                      {fmtDateTime(r.registeredAt)}
                    </td>
                    {/* The gap between the two buttons is cell--action's job now,
                        so that on a card they can split the foot evenly. */}
                    <td className="cell--action">
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

          <div className="row" style={{ justifyContent: 'center', marginTop: '1rem' }}>
            <button className="btn btn--ghost btn--sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              Previous
            </button>
            <span className="muted" style={{ fontSize: '.78rem' }}>Page {page}</span>
            {/* The worksheet procedure pages without returning a total, so
                "next" is offered whenever the page came back full. */}
            <button className="btn btn--ghost btn--sm" disabled={rows.length < 50} onClick={() => setPage((p) => p + 1)}>
              Next
            </button>
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
