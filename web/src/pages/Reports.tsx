import { useCallback, useEffect, useState } from 'react';
import { api, csrfHeader } from '../api/client';
import { downloadFile, fmtDateTime } from '../lib/format';
import { ReportViewer } from './ReportViewer';
import { SmartReportModal } from './SmartReport';
import { InfinityLoader } from '../components/InfinityLoader';
import { TestList } from '../components/TestList';
import {
  SampleFilters, ActiveFilterChips, useFilterOptions, applyFilterParams,
  EMPTY_FILTERS, type SampleFilterValues,
} from '../components/SampleFilters';

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

function daysAgo(n: number) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

export function Reports() {
  const [rows, setRows] = useState<WorksheetRow[]>([]);
  const [scope, setScope] = useState<string>('');
  const [from, setFrom] = useState(daysAgo(7));
  const [to, setTo] = useState(daysAgo(0));
  const [patient, setPatient] = useState('');
  const [sidQuery, setSidQuery] = useState('');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openSid, setOpenSid] = useState<string | null>(null);
  const [smartSid, setSmartSid] = useState<string | null>(null);

  // The merge basket. Keyed by SID and deliberately NOT cleared when the page
  // changes: picking three reports on page 1 and two on page 3 has to give five.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [withGraphs, setWithGraphs] = useState(true);
  const [merging, setMerging] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);

  // The same filter set the worksheet offers. Reporting reads the same endpoint,
  // which accepts the same filters, so there is no reason for it to offer fewer.
  const [filters, setFilters] = useState<SampleFilterValues>(EMPTY_FILTERS);
  const options = useFilterOptions();

  const toggle = (sid: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (!next.delete(sid)) next.add(sid);
      return next;
    });

  const downloadMerged = async () => {
    setMerging(true);
    setMergeError(null);
    try {
      await downloadFile('/api/reports/pdf/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...csrfHeader() },
        body: JSON.stringify({ sids: [...selected], withGraph: withGraphs }),
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
      const p = new URLSearchParams({ from, to, page: String(page), pageSize: '50' });
      if (patient.trim()) p.set('patient', patient.trim());
      if (sidQuery.trim()) p.set('sid', sidQuery.trim());
      // Sent to the SERVER, not applied to the response: filtering after the
      // fact would make a page of 50 arrive as 6 rows with a dead Next button,
      // which reads as "that is all there is" when it is not. The worksheet
      // learned this the same way — see PENDING_STATUSES there.
      p.set('statusIds', REPORTABLE_STATUSES.join(','));
      applyFilterParams(p, filters);
      const r = await api.get<{ rows: WorksheetRow[]; count: number; scope: string }>(`/api/reports/?${p}`);
      setRows(r.rows);
      setScope(r.scope);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the worksheet.');
    } finally {
      setLoading(false);
    }
  }, [from, to, patient, sidQuery, filters, page]);

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
            {scope && ` · ${scope === 'all' ? 'all centres' : scope}`}
          </p>
        </div>

        <div className="row" style={{ marginLeft: 'auto', flexWrap: 'wrap' }}>
          <input className="input" placeholder="Patient name…" value={patient}
                 onChange={(e) => { setPatient(e.target.value); setPage(1); }} style={{ minWidth: 170 }} />
          <input className="input" placeholder="SID" value={sidQuery}
                 onChange={(e) => { setSidQuery(e.target.value); setPage(1); }} style={{ minWidth: 130 }} />
          <input className="input" type="date" value={from} max={to}
                 onChange={(e) => { setFrom(e.target.value); setPage(1); }} title="From" />
          <input className="input" type="date" value={to} min={from}
                 onChange={(e) => { setTo(e.target.value); setPage(1); }} title="To" />
        </div>
      </div>

      {/* Applied filters, listed so nothing narrows the list invisibly. */}
      <ActiveFilterChips value={filters} options={options} onChange={setFilters} />

      {/* Every filter, always on screen — same set and same component as the
          worksheet, so the two cannot drift apart. */}
      <SampleFilters value={filters} options={options} onChange={setFilters} />

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
                {rows.map((r) => (
                  <tr key={r.sid} style={{ cursor: 'pointer' }} onClick={() => setOpenSid(r.sid)}>
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
                    <td className="mono cell--lead"><b>{r.sid}</b></td>
                    <td className="cell--head">
                      {r.patientName ?? <span className="muted">—</span>}
                      <div className="muted" style={{ fontSize: '.72rem' }}>
                        {[r.sex, r.age != null ? `${r.age}${r.ageUnit?.[0] ?? ''}` : null].filter(Boolean).join(' · ')}
                      </div>
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
                      <button className="btn btn--primary btn--sm"
                              onClick={(e) => { e.stopPropagation(); setSmartSid(r.sid); }}>
                        Smart
                      </button>
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

      {openSid && <ReportViewer sid={openSid} onClose={() => setOpenSid(null)} />}
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
