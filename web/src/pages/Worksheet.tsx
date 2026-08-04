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

/**
 * The statuses "Outstanding only" means: registered, partially tested, tested,
 * partially authorised. Sent to the SERVER as a filter — filtering these out in
 * the browser after a page had already been fetched meant a page of 50 could
 * display as 6 rows with a dead Next button, which read as "that is all there
 * is" when it was not.
 */
const PENDING_STATUSES = [2, 4, 5, 6];

/** Every row is reachable at any of these; the choice only trades requests
 *  against response size. */
const PAGE_SIZES = [50, 100, 250, 500, 1000];

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
  const [pageSize, setPageSize] = useState(100);
  const [total, setTotal] = useState(0);
  const [pageCount, setPageCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openSid, setOpenSid] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const p = new URLSearchParams({ from, to, page: String(page), pageSize: String(pageSize) });
      if (patient.trim()) p.set('patient', patient.trim());
      if (sidQuery.trim()) p.set('sid', sidQuery.trim());

      // Every filter goes to the server so that paging and the total count
      // describe the same set the operator is looking at.
      if (statusId !== '') p.set('statusIds', String(statusId));
      else if (pendingOnly) p.set('statusIds', PENDING_STATUSES.join(','));

      const r = await api.get<{
        rows: WorksheetRow[]; count: number; total: number;
        page: number; pageSize: number; pageCount: number; scope: string;
      }>(`/api/reports/?${p}`);

      setRows(r.rows);
      setScope(r.scope);
      setTotal(r.total);
      setPageCount(r.pageCount);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the worklist.');
    } finally {
      setLoading(false);
    }
  }, [from, to, patient, sidQuery, statusId, pendingOnly, page, pageSize]);

  useEffect(() => {
    const id = setTimeout(() => void load(), 300);
    return () => clearTimeout(id);
  }, [load]);

  // A filter that narrows the result set must reset the page, or page 4 of the
  // old set silently shows nothing for the new one.
  useEffect(() => { setPage(1); }, [pendingOnly, pageSize]);

  // Nothing is hidden after the fact: what the server returned is what shows.
  const visible = rows;

  const firstOnPage = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const lastOnPage = Math.min(page * pageSize, total);

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
            {/* The total, not the page. What is on screen is stated separately
                below, so a page is never mistaken for the whole result set. */}
            {total.toLocaleString()} sample{total === 1 ? '' : 's'} match
            {total === 1 ? 'es' : ''} these filters
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

          {/* Every control here is driven by the server's total. Nothing infers
              "is there more?" from the size of the page it happens to hold —
              that inference is wrong whenever the total divides evenly by the
              page size, and it was what made a full list look finished. */}
          <div className="pager">
            <span className="pager__range muted">
              {total === 0
                ? 'No samples'
                : <>Showing <b>{firstOnPage.toLocaleString()}–{lastOnPage.toLocaleString()}</b> of{' '}
                   <b>{total.toLocaleString()}</b></>}
            </span>

            <div className="row" style={{ gap: '.3rem' }}>
              <button className="btn btn--ghost btn--sm" disabled={page <= 1}
                      onClick={() => setPage(1)} title="First page">«</button>
              <button className="btn btn--ghost btn--sm" disabled={page <= 1}
                      onClick={() => setPage((p) => p - 1)}>Previous</button>

              <span className="muted" style={{ fontSize: '.78rem', padding: '0 .5rem' }}>
                Page {page.toLocaleString()} of {Math.max(pageCount, 1).toLocaleString()}
              </span>

              <button className="btn btn--ghost btn--sm" disabled={page >= pageCount}
                      onClick={() => setPage((p) => p + 1)}>Next</button>
              <button className="btn btn--ghost btn--sm" disabled={page >= pageCount}
                      onClick={() => setPage(pageCount)} title="Last page">»</button>
            </div>

            <label className="row pager__size muted">
              Rows
              <select className="input input--sm" value={pageSize}
                      onChange={(e) => setPageSize(Number(e.target.value))}>
                {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
          </div>
        </>
      )}

      {openSid && (
        <WorksheetEntry sid={openSid} onClose={() => setOpenSid(null)} onSaved={() => void load()} />
      )}
    </div>
  );
}
