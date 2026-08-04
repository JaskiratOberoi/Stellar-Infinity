import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { fmtDateTime } from '../lib/format';
import { StatusBadge, type WorksheetRow } from './Reports';
import { WorksheetEntry } from './WorksheetEntry';

/**
 * LIS sample statuses. Verified against tbl_med_mcc_patient_samples_status_master.
 * Status 1 (Sample Sent) never reaches the worksheet — the procedure excludes it.
 */
const STATUSES: { id: number; label: string }[] = [
  { id: 2, label: 'Registered' },
  { id: 4, label: 'Partially tested' },
  { id: 5, label: 'Tested' },
  { id: 6, label: 'Partially authorised' },
  { id: 7, label: 'Authorised' },
  { id: 9, label: 'Printed' },
  { id: 3, label: 'Rejected' },
];

function daysAgo(n: number) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

/**
 * The bench worklist: samples waiting for results, and the way into entry.
 *
 * Defaults to today and to the statuses that actually need work (registered,
 * partially tested, tested), because the question a technologist opens this
 * screen with is "what is outstanding", not "show me everything".
 */
export function Worksheet() {
  const [rows, setRows] = useState<WorksheetRow[]>([]);
  const [scope, setScope] = useState('');
  const [from, setFrom] = useState(daysAgo(1));
  const [to, setTo] = useState(daysAgo(0));
  const [patient, setPatient] = useState('');
  const [sidQuery, setSidQuery] = useState('');
  const [statusId, setStatusId] = useState<number | ''>('');
  const [pendingOnly, setPendingOnly] = useState(true);
  const [groupByPid, setGroupByPid] = useState(true);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openSid, setOpenSid] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const p = new URLSearchParams({ from, to, page: String(page), pageSize: '50' });
      if (patient.trim()) p.set('patient', patient.trim());
      if (sidQuery.trim()) p.set('sid', sidQuery.trim());
      if (statusId !== '') p.set('statusId', String(statusId));
      const r = await api.get<{ rows: WorksheetRow[]; count: number; scope: string }>(`/api/reports/?${p}`);
      setRows(r.rows);
      setScope(r.scope);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the worklist.');
    } finally {
      setLoading(false);
    }
  }, [from, to, patient, sidQuery, statusId, page]);

  useEffect(() => {
    const id = setTimeout(() => void load(), 300);
    return () => clearTimeout(id);
  }, [load]);

  // Client-side because the list procedure takes a single status, not a set.
  // Worth revisiting if it ever hides rows on a paged result — filtering after
  // paging can leave a page looking emptier than it is.
  const visible = pendingOnly && statusId === ''
    ? rows.filter((r) => r.statusCode != null && [2, 4, 5, 6].includes(r.statusCode))
    : rows;

  /**
   * Samples grouped by patient.
   *
   * One patient routinely has several samples drawn together — a CBC tube, a
   * biochemistry tube, a urine container — and in a flat list they appear as
   * three unrelated rows with the same name, several rows apart. Grouping keeps
   * them adjacent so it is obvious they belong to one person, which matters
   * both for spotting a missed tube and for not mistaking one patient's sample
   * for another's.
   *
   * Order WITHIN a group and the relative order OF groups both follow the
   * original list, which is newest-registered first. Sorting by PID instead
   * would scramble the chronology a technologist works down.
   */
  const grouped = useMemo(() => {
    if (!groupByPid) return visible.map((r) => ({ pid: r.pid, rows: [r] }));

    const order: number[] = [];
    const byPid = new Map<number, WorksheetRow[]>();

    for (const r of visible) {
      // A row with no PID cannot be grouped with anything; give each its own
      // bucket rather than collecting unrelated samples under a shared 0.
      const key = r.pid || -(order.length + 1);
      if (!byPid.has(key)) { byPid.set(key, []); order.push(key); }
      byPid.get(key)!.push(r);
    }

    return order.map((pid) => ({ pid, rows: byPid.get(pid)! }));
  }, [visible, groupByPid]);

  const multiSamplePatients = grouped.filter((g) => g.rows.length > 1).length;

  return (
    <div className="page">
      <div className="page__head">
        <div>
          <h1 className="page__title">Worksheet</h1>
          <p className="page__sub">
            {visible.length} sample{visible.length === 1 ? '' : 's'}
            {scope && ` · ${scope === 'all' ? 'all centres' : scope}`}
          </p>
        </div>

        <div className="row" style={{ marginLeft: 'auto', flexWrap: 'wrap' }}>
          <input className="input" placeholder="Patient name…" value={patient}
                 onChange={(e) => { setPatient(e.target.value); setPage(1); }} style={{ minWidth: 160 }} />
          <input className="input mono" placeholder="SID" value={sidQuery}
                 onChange={(e) => { setSidQuery(e.target.value); setPage(1); }} style={{ minWidth: 120 }} />
          <select className="input" value={statusId}
                  onChange={(e) => { setStatusId(e.target.value === '' ? '' : Number(e.target.value)); setPage(1); }}>
            <option value="">Any status</option>
            {STATUSES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
          <input className="input" type="date" value={from} max={to}
                 onChange={(e) => { setFrom(e.target.value); setPage(1); }} title="From" />
          <input className="input" type="date" value={to} min={from}
                 onChange={(e) => { setTo(e.target.value); setPage(1); }} title="To" />
        </div>
      </div>

      <div className="row" style={{ marginBottom: '.8rem' }}>
        <label className="row" style={{ gap: '.4rem', fontSize: '.8rem', cursor: 'pointer' }}>
          <input type="checkbox" checked={pendingOnly} disabled={statusId !== ''}
                 onChange={(e) => setPendingOnly(e.target.checked)} />
          Outstanding only
        </label>
        <span className="muted" style={{ fontSize: '.74rem' }}>
          Hides authorised, printed and rejected samples.
        </span>

        <label className="row" style={{ gap: '.4rem', fontSize: '.8rem', cursor: 'pointer', marginLeft: '1.2rem' }}>
          <input type="checkbox" checked={groupByPid}
                 onChange={(e) => setGroupByPid(e.target.checked)} />
          Group by patient
        </label>
        <span className="muted" style={{ fontSize: '.74rem' }}>
          {multiSamplePatients > 0
            ? `${multiSamplePatients} patient${multiSamplePatients === 1 ? '' : 's'} with more than one sample.`
            : 'Keeps a patient’s samples together.'}
        </span>
      </div>

      {scope === 'none' && (
        <div className="alert alert--info" style={{ marginBottom: '.9rem' }}>
          No centres are assigned to your account, so there is nothing to show. An administrator can grant client
          codes to your user.
        </div>
      )}

      {error && <div className="alert alert--error" style={{ marginBottom: '.9rem' }}>{error}</div>}

      {loading ? (
        <div className="center"><div className="spinner" /><span className="muted">Loading worklist…</span></div>
      ) : (
        <>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>SID</th>
                  <th>PID</th>
                  <th>Patient</th>
                  <th>Client</th>
                  <th>Tests</th>
                  <th>Status</th>
                  <th>Registered</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {grouped.map((g) =>
                  g.rows.map((r, i) => (
                    <tr
                      key={r.sid}
                      className={groupByPid && g.rows.length > 1
                        ? (i === 0 ? 'pid-group pid-group--first' : 'pid-group')
                        : undefined}
                      style={{ cursor: 'pointer' }}
                      onClick={() => setOpenSid(r.sid)}
                    >
                      <td className="mono"><b>{r.sid}</b></td>

                      <td className="mono muted" style={{ fontSize: '.78rem' }}>
                        {r.pid || '—'}
                        {/* Only the first row of a multi-sample patient carries
                            the count, so the repetition reads as one patient
                            rather than as duplicate rows. */}
                        {groupByPid && g.rows.length > 1 && i === 0 && (
                          <span className="badge badge--role" style={{ marginLeft: '.4rem' }}>
                            {g.rows.length} samples
                          </span>
                        )}
                      </td>

                      <td>
                        {/* Repeating the name on every sample of the same
                            patient is noise; the grouping already says it. */}
                        {groupByPid && i > 0 ? (
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

                      <td className="muted">{r.clientCode ?? '—'}</td>
                      <td style={{ maxWidth: 240 }}>
                        <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                             title={r.testNames ?? ''}>
                          {r.testNames ?? '—'}
                        </div>
                      </td>
                      <td><StatusBadge status={r.status} /></td>
                      <td className="muted" style={{ fontSize: '.78rem' }}>{fmtDateTime(r.registeredAt)}</td>
                      <td style={{ textAlign: 'right' }}>
                        <button className="btn btn--primary btn--sm"
                                onClick={(e) => { e.stopPropagation(); setOpenSid(r.sid); }}>
                          Enter results
                        </button>
                      </td>
                    </tr>
                  )),
                )}

                {visible.length === 0 && scope !== 'none' && (
                  <tr>
                    <td colSpan={8} className="muted" style={{ textAlign: 'center', padding: '2rem' }}>
                      {pendingOnly && rows.length > 0
                        ? 'Nothing outstanding in this window — untick "Outstanding only" to see completed samples.'
                        : 'No samples in this window.'}
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
            <button className="btn btn--ghost btn--sm" disabled={rows.length < 50} onClick={() => setPage((p) => p + 1)}>
              Next
            </button>
          </div>
        </>
      )}

      {openSid && (
        <WorksheetEntry sid={openSid} onClose={() => setOpenSid(null)} onSaved={() => void load()} />
      )}
    </div>
  );
}
