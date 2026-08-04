import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { fmtDateTime } from '../lib/format';
import { ReportViewer } from './ReportViewer';
import { SmartReportModal } from './SmartReport';

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

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const p = new URLSearchParams({ from, to, page: String(page), pageSize: '50' });
      if (patient.trim()) p.set('patient', patient.trim());
      if (sidQuery.trim()) p.set('sid', sidQuery.trim());
      const r = await api.get<{ rows: WorksheetRow[]; count: number; scope: string }>(`/api/reports/?${p}`);
      setRows(r.rows);
      setScope(r.scope);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the worksheet.');
    } finally {
      setLoading(false);
    }
  }, [from, to, patient, sidQuery, page]);

  useEffect(() => {
    const id = setTimeout(() => void load(), 300);
    return () => clearTimeout(id);
  }, [load]);

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

      {scope === 'none' && (
        <div className="alert alert--info" style={{ marginBottom: '.9rem' }}>
          No centres are assigned to your account for reporting, so there is nothing to show. An administrator
          can grant client codes to your user.
        </div>
      )}

      {error && <div className="alert alert--error" style={{ marginBottom: '.9rem' }}>{error}</div>}

      {loading ? (
        <div className="center"><div className="spinner" /><span className="muted">Loading worksheet…</span></div>
      ) : (
        <>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
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
                    <td className="mono"><b>{r.sid}</b></td>
                    <td>
                      {r.patientName ?? <span className="muted">—</span>}
                      <div className="muted" style={{ fontSize: '.72rem' }}>
                        {[r.sex, r.age != null ? `${r.age}${r.ageUnit?.[0] ?? ''}` : null].filter(Boolean).join(' · ')}
                      </div>
                    </td>
                    <td className="muted">{r.clientCode ?? '—'}</td>
                    <td style={{ maxWidth: 260 }}>
                      <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                           title={r.testNames ?? ''}>
                        {r.testNames ?? '—'}
                      </div>
                    </td>
                    <td><StatusBadge status={r.status} statusCode={r.statusCode} /></td>
                    <td className="muted" style={{ fontSize: '.78rem' }}>{fmtDateTime(r.registeredAt)}</td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <button className="btn btn--ghost btn--sm" onClick={(e) => { e.stopPropagation(); setOpenSid(r.sid); }}>
                        View
                      </button>
                      <button className="btn btn--primary btn--sm" style={{ marginLeft: '.4rem' }}
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
 * Sample status, coloured exactly as the legacy LIS colours it.
 *
 * The colours are lifted verbatim from the LIS stylesheet
 * (MedCis.UI/Styles/responsible/css/style1.css, classes .status_reg,
 * .status_tested, .status_auth …), which the worksheet applies by status name
 * in SampleWorksheet.aspx.cs. Staff have read this palette for years; matching
 * it means they can scan an Infinity worklist without relearning anything.
 *
 * Two pairings look inverted and are NOT mistakes — they are what the LIS does,
 * and they are reproduced rather than corrected:
 *   - Partially Tested is the PALER orange, Tested the deeper one.
 *   - Partially Authorized is the DEEPER green, Authorized the paler one.
 *
 * Matching on status_code, not on the label: the code is the LIS's own
 * identifier, while the text has been renamed before. Labels are still matched
 * as a fallback for callers that only carry the string.
 */
const LIS_STATUS_STYLE: Record<number, { bg: string; fg: string }> = {
  1: { bg: '#ffffff', fg: '#000000' },   // Sample Sent          .status_samplesent
  2: { bg: '#F3F3F3', fg: '#000000' },   // Sample Registered    .status_reg
  3: { bg: '#ff0000', fg: '#ffffff' },   // Rejected             .status_rejected
  4: { bg: '#F8CAAA', fg: '#000000' },   // Partially Tested     .status_ptested
  5: { bg: '#F4A778', fg: '#000000' },   // Tested               .status_tested
  6: { bg: '#A3F46C', fg: '#000000' },   // Partially Authorized .status_pauth
  7: { bg: '#AFFD8E', fg: '#000000' },   // Authorized           .status_auth
  8: { bg: '#BDD7ED', fg: '#000000' },   // Partially Printed    .status_pprinted
  9: { bg: '#B7D2EC', fg: '#000000' },   // Printed              .status_printed
  10: { bg: '#990066', fg: '#ffffff' },  // Pending              .status_pending
};

/** Fallback for callers that have the label but not the code. */
function styleFromLabel(status: string) {
  const s = status.toLowerCase();
  if (s.includes('reject')) return LIS_STATUS_STYLE[3];
  if (s.includes('pending')) return LIS_STATUS_STYLE[10];
  if (s.includes('partially print')) return LIS_STATUS_STYLE[8];
  if (s.includes('print')) return LIS_STATUS_STYLE[9];
  if (s.includes('partially auth')) return LIS_STATUS_STYLE[6];
  if (s.includes('auth')) return LIS_STATUS_STYLE[7];
  if (s.includes('partially test')) return LIS_STATUS_STYLE[4];
  if (s.includes('test')) return LIS_STATUS_STYLE[5];
  if (s.includes('sent')) return LIS_STATUS_STYLE[1];
  if (s.includes('regist')) return LIS_STATUS_STYLE[2];
  return undefined;
}

export function StatusBadge({ status, statusCode }: { status: string | null; statusCode?: number | null }) {
  if (!status) return <span className="muted">—</span>;

  const style = (statusCode != null ? LIS_STATUS_STYLE[statusCode] : undefined) ?? styleFromLabel(status);
  if (!style) return <span className="badge badge--lis">{status}</span>;

  // Inline, and identical in both themes. These are literal LIS colours and
  // each pairs its own foreground, so contrast holds either way; re-deriving
  // them from theme tokens would mean they no longer match what the LIS shows
  // on the next screen over, which is the entire point.
  return (
    <span className="badge badge--lis-status" style={{ background: style.bg, color: style.fg }}>
      {status}
    </span>
  );
}
