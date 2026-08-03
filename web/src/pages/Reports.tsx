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
                    <td><StatusBadge status={r.status} /></td>
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

export function StatusBadge({ status }: { status: string | null }) {
  if (!status) return <span className="muted">—</span>;
  const s = status.toLowerCase();
  const kind = s.includes('authoris') || s.includes('authoriz') || s.includes('complete')
    ? 'infinity'
    : s.includes('pending') || s.includes('sent')
      ? 'telo'
      : 'lis';
  return <span className={`badge badge--${kind}`}>{status}</span>;
}
