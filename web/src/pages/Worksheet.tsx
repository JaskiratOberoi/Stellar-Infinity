import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client';
import { fmtDateTime } from '../lib/format';
import { StatusBadge, type WorksheetRow } from './Reports';
import { WorksheetEntry } from './WorksheetEntry';
import { Pager } from '../components/Pager';
import { InfinityLoader } from '../components/InfinityLoader';

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
  { id: 8, label: 'Partially printed' },
  { id: 9, label: 'Printed' },
  { id: 3, label: 'Rejected' },
  { id: 10, label: 'Pending' },
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

/**
 * The LIS worksheet's filter set, minus the four that stay on the top row.
 *
 * These live behind a disclosure rather than on the bar. The LIS puts all
 * eleven controls on screen at once and a technologist uses two of them on a
 * normal shift; showing the other nine permanently costs more attention than
 * it saves. What is NOT acceptable is hiding an active filter, so the toggle
 * carries a count and every applied value is listed as a chip even when the
 * panel is shut — see activeAdv.
 */
interface AdvancedFilters {
  clientCode: string;
  departmentId: number | '';
  businessUnitId: number | '';
  testCode: string;
  pid: string;
  fromHour: number;
  toHour: number;
}

const EMPTY_ADVANCED: AdvancedFilters = {
  clientCode: '',
  departmentId: '',
  businessUnitId: '',
  testCode: '',
  pid: '',
  fromHour: 0,
  toHour: 24,
};

interface FilterOptions {
  departments: { id: number; name: string | null }[];
  businessUnits: { id: number; name: string | null }[];
  clientCodes: { code: string; name: string | null }[];
}

/** Human-readable labels for whatever advanced filters are currently applied. */
function describeAdvanced(adv: AdvancedFilters, options: FilterOptions): { key: keyof AdvancedFilters; label: string }[] {
  const out: { key: keyof AdvancedFilters; label: string }[] = [];

  if (adv.clientCode) out.push({ key: 'clientCode', label: `Client ${adv.clientCode}` });
  if (adv.departmentId !== '') {
    const d = options.departments.find((x) => x.id === adv.departmentId);
    out.push({ key: 'departmentId', label: d?.name ?? `Department ${adv.departmentId}` });
  }
  if (adv.businessUnitId !== '') {
    const b = options.businessUnits.find((x) => x.id === adv.businessUnitId);
    out.push({ key: 'businessUnitId', label: b?.name ?? `Unit ${adv.businessUnitId}` });
  }
  if (adv.testCode.trim()) out.push({ key: 'testCode', label: `Test ${adv.testCode.trim()}` });
  if (adv.pid.trim()) out.push({ key: 'pid', label: `PID ${adv.pid.trim()}` });
  // The two hours read as one range: "08:00–20:00" is the thing the operator
  // set, not two independent facts.
  if (adv.fromHour !== 0 || adv.toHour !== 24) {
    out.push({ key: 'fromHour', label: `${pad2(adv.fromHour)}:00–${pad2(adv.toHour)}:00` });
  }

  return out;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** 0–24. 24 is "end of the to-date", which is why it is not 23. */
const HOURS = Array.from({ length: 25 }, (_, i) => i);

/**
 * What the row's button should actually say.
 *
 * "Enter results" was wrong for most of the list. A sample at Tested already
 * has every value typed in and is waiting on a pathologist — the work is
 * reading and signing, not typing — and one at Authorised has nothing left to
 * do at all. A button that says the same thing in all three cases makes the
 * operator open the sample to find out which it is.
 *
 * Derived from the LIS status code, which is already on the row, so this costs
 * no extra query. `primary` is reserved for rows that need someone to act;
 * finished samples get a quiet button so the eye skips them.
 */
function actionFor(statusCode: number | null | undefined): { label: string; primary: boolean; title: string } {
  switch (statusCode) {
    case 2:  return { label: 'Enter results', primary: true,
                      title: 'Registered — no values entered yet' };
    case 4:  return { label: 'Continue entry', primary: true,
                      title: 'Partially tested — some values are in, the rest are not' };
    case 5:  return { label: 'Review & authorise', primary: true,
                      title: 'All values entered and waiting to be signed out' };
    case 6:  return { label: 'Finish authorising', primary: true,
                      title: 'Partially authorised — some tests are still unsigned' };
    case 7:  return { label: 'View results', primary: false,
                      title: 'Authorised — signed out' };
    case 8:  return { label: 'View results', primary: false,
                      title: 'Partially printed' };
    case 9:  return { label: 'View results', primary: false,
                      title: 'Printed' };
    case 3:  return { label: 'View', primary: false,
                      title: 'Rejected — no result will be issued' };
    // Sample Sent (1), Pending (10), and anything the LIS adds later. Neutral
    // wording rather than a guess at what the sample needs.
    default: return { label: 'Open', primary: false, title: 'Open this sample' };
  }
}

function ActionButton({ statusCode, onOpen }: { statusCode: number | null | undefined; onOpen: () => void }) {
  const a = actionFor(statusCode);
  return (
    <button
      className={`btn btn--sm ${a.primary ? 'btn--primary' : 'btn--ghost'}`}
      title={a.title}
      style={{ whiteSpace: 'nowrap' }}
      onClick={(e) => { e.stopPropagation(); onOpen(); }}
    >
      {a.label}
    </button>
  );
}

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
  // The instant the current result set describes. Pinned on the first request
  // and echoed back while paging, so registrations arriving mid-walk cannot
  // shuffle a sample from the page ahead onto a page already passed.
  //
  // A ref, not state: it is an input to the next request, and making it a
  // dependency of the loader would have every page-one response trigger a
  // second identical fetch.
  const asOfRef = useRef<string | null>(null);
  const [asOf, setAsOf] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openSid, setOpenSid] = useState<string | null>(null);

  /**
   * The rest of the LIS worksheet's filter set.
   *
   * Held in one object rather than eight useStates so the "how many are on"
   * count and the clear-all action cannot drift out of step with what is
   * actually being sent.
   */
  const [adv, setAdv] = useState<AdvancedFilters>(EMPTY_ADVANCED);
  const [showAdv, setShowAdv] = useState(false);
  const [options, setOptions] = useState<FilterOptions>({ departments: [], businessUnits: [], clientCodes: [] });

  const activeAdv = useMemo(() => describeAdvanced(adv, options), [adv, options]);

  // Fetched once. Departments and business units are lab reference data, and
  // the client-code list is already scoped by the API to what this user can
  // reach — so there is nothing here to re-fetch as filters change.
  useEffect(() => {
    let live = true;
    api.get<FilterOptions>('/api/reports/filters')
      .then((r) => { if (live) setOptions(r); })
      .catch(() => { /* Dropdowns degrade to empty; the rest of the screen works. */ });
    return () => { live = false; };
  }, []);

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

      if (adv.clientCode) p.set('clientCode', adv.clientCode);
      if (adv.departmentId !== '') p.set('departmentId', String(adv.departmentId));
      if (adv.businessUnitId !== '') p.set('businessUnitId', String(adv.businessUnitId));
      if (adv.testCode.trim()) p.set('testCode', adv.testCode.trim());
      if (adv.pid.trim()) p.set('pid', adv.pid.trim());
      if (adv.fromHour !== 0) p.set('fromHour', String(adv.fromHour));
      if (adv.toHour !== 24) p.set('toHour', String(adv.toHour));

      // Only while paging within one result set. Page 1 always takes a fresh
      // snapshot, so the list is never stale without the operator asking for it.
      if (asOfRef.current && page > 1) p.set('asOf', asOfRef.current);

      const r = await api.get<{
        rows: WorksheetRow[]; count: number; total: number;
        page: number; pageSize: number; pageCount: number; scope: string; asOf: string;
      }>(`/api/reports/?${p}`);

      setRows(r.rows);
      setScope(r.scope);
      setTotal(r.total);
      if (page === 1) { asOfRef.current = r.asOf; setAsOf(r.asOf); }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the worklist.');
    } finally {
      setLoading(false);
    }
  }, [from, to, patient, sidQuery, statusId, pendingOnly, adv, page, pageSize]);

  useEffect(() => {
    const id = setTimeout(() => void load(), 300);
    return () => clearTimeout(id);
  }, [load]);

  // A filter that narrows the result set must reset the page, or page 4 of the
  // old set silently shows nothing for the new one.
  useEffect(() => { setPage(1); }, [pendingOnly, pageSize, adv]);

  // Nothing is hidden after the fact: what the server returned is what shows.
  const visible = rows;

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

  /**
   * Flattened rows carrying everything the table needs to band them.
   *
   * The banding unit changes with the mode, and that is the point:
   *   - grouped   → one band per PATIENT, so a person's three tubes share a
   *                 shade and the next patient flips. The band becomes the
   *                 group boundary, which is far easier to follow down a dense
   *                 list than a hairline rule.
   *   - ungrouped → one band per ROW, ordinary zebra striping, which is what
   *                 keeps the eye on a line across eight columns.
   *
   * Computed here rather than with nth-child so the two modes can differ at
   * all — CSS cannot see where a patient group starts.
   */
  const tableRows = useMemo(() => {
    const out: {
      row: WorksheetRow;
      band: 0 | 1;
      indexInGroup: number;
      groupSize: number;
      isGroupStart: boolean;
      isGroupEnd: boolean;
    }[] = [];

    let rowIndex = 0;
    grouped.forEach((g, groupIndex) => {
      g.rows.forEach((row, i) => {
        out.push({
          row,
          band: (groupByPid ? groupIndex % 2 : rowIndex % 2) as 0 | 1,
          indexInGroup: i,
          groupSize: g.rows.length,
          isGroupStart: i === 0,
          isGroupEnd: i === g.rows.length - 1,
        });
        rowIndex += 1;
      });
    });

    return out;
  }, [grouped, groupByPid]);

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
            {/* Stated whenever the list is pinned. Beyond page 1 the operator is
                walking a fixed set, and they should know it is a moment in time
                rather than a live view. */}
            {page > 1 && asOf && ` · as of ${fmtDateTime(asOf)}`}
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
          {/* Back to page 1 takes a fresh snapshot, which is the only way to
              pick up samples registered since the walk began. */}
          <button className="btn btn--ghost btn--sm"
                  onClick={() => { asOfRef.current = null; setPage(1); void load(); }}>
            Refresh
          </button>
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

        <button
          className={`btn btn--ghost btn--sm${showAdv ? ' btn--on' : ''}`}
          style={{ marginLeft: 'auto' }}
          aria-expanded={showAdv}
          onClick={() => setShowAdv((v) => !v)}
        >
          More filters
          {activeAdv.length > 0 && <span className="tab__count">{activeAdv.length}</span>}
        </button>
      </div>

      {/* Applied filters are listed whether or not the panel is open. A filter
          you cannot see is the same defect as a row you cannot reach: the
          screen would be showing a narrowed list and calling it the list. */}
      {activeAdv.length > 0 && (
        <div className="row" style={{ flexWrap: 'wrap', gap: '.35rem', marginBottom: '.8rem' }}>
          {activeAdv.map((f) => (
            <button
              key={f.key}
              className="chip"
              title="Remove this filter"
              onClick={() => setAdv((a) => ({
                ...a,
                ...(f.key === 'fromHour'
                  ? { fromHour: 0, toHour: 24 }
                  : { [f.key]: EMPTY_ADVANCED[f.key] }),
              }))}
            >
              {f.label} <span aria-hidden="true">×</span>
            </button>
          ))}
          <button className="btn btn--ghost btn--sm" onClick={() => setAdv(EMPTY_ADVANCED)}>
            Clear all
          </button>
        </div>
      )}

      {showAdv && (
        <div className="card filter-panel">
          <div className="filter-panel__grid">
            <label className="field">
              <span>Client code</span>
              <select className="input" value={adv.clientCode}
                      onChange={(e) => setAdv((a) => ({ ...a, clientCode: e.target.value }))}>
                <option value="">Any centre in your scope</option>
                {options.clientCodes.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.code}{c.name ? ` — ${c.name}` : ''}
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              <span>Department</span>
              <select className="input" value={adv.departmentId}
                      onChange={(e) => setAdv((a) => ({
                        ...a, departmentId: e.target.value === '' ? '' : Number(e.target.value),
                      }))}>
                <option value="">Any department</option>
                {options.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </label>

            <label className="field">
              <span>Business unit</span>
              <select className="input" value={adv.businessUnitId}
                      onChange={(e) => setAdv((a) => ({
                        ...a, businessUnitId: e.target.value === '' ? '' : Number(e.target.value),
                      }))}>
                <option value="">Any unit</option>
                {options.businessUnits.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </label>

            <label className="field">
              <span>Test code</span>
              <input className="input mono" placeholder="e.g. HE011" value={adv.testCode}
                     onChange={(e) => setAdv((a) => ({ ...a, testCode: e.target.value }))} />
            </label>

            <label className="field">
              <span>Patient number</span>
              <input className="input mono" placeholder="PID" inputMode="numeric" value={adv.pid}
                     onChange={(e) => setAdv((a) => ({ ...a, pid: e.target.value.replace(/\D/g, '') }))} />
            </label>

            <div className="field">
              <span>Time of day</span>
              <div className="row" style={{ gap: '.35rem' }}>
                <select className="input" value={adv.fromHour} aria-label="From hour"
                        onChange={(e) => setAdv((a) => ({ ...a, fromHour: Number(e.target.value) }))}>
                  {HOURS.map((h) => <option key={h} value={h}>{pad2(h)}:00</option>)}
                </select>
                <span className="muted">to</span>
                <select className="input" value={adv.toHour} aria-label="To hour"
                        onChange={(e) => setAdv((a) => ({ ...a, toHour: Number(e.target.value) }))}>
                  {HOURS.map((h) => <option key={h} value={h}>{pad2(h)}:00</option>)}
                </select>
              </div>
            </div>
          </div>

          <p className="muted" style={{ fontSize: '.72rem', marginTop: '.7rem', lineHeight: 1.6 }}>
            The same filters the LIS worksheet offers, with one exception: the LIS's <b>TAT</b> checkbox is
            passed to its stored procedure but never used by it, so ticking it there changes nothing. It is
            left out here rather than reproduced as a control that does nothing.
          </p>
        </div>
      )}

      {scope === 'none' && (
        <div className="alert alert--info" style={{ marginBottom: '.9rem' }}>
          No centres are assigned to your account, so there is nothing to show. An administrator can grant client
          codes to your user.
        </div>
      )}

      {error && <div className="alert alert--error" style={{ marginBottom: '.9rem' }}>{error}</div>}

      {loading ? (
        <div className="center"><InfinityLoader /><span className="muted">Loading worklist…</span></div>
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
                {tableRows.map(({ row: r, band, indexInGroup: i, groupSize, isGroupStart, isGroupEnd }) => (
                    <tr
                      key={r.sid}
                      className={[
                        `band-${band}`,
                        groupByPid && groupSize > 1 ? 'pid-group' : '',
                        groupByPid && groupSize > 1 && isGroupStart ? 'pid-group--first' : '',
                        groupByPid && groupSize > 1 && isGroupEnd ? 'pid-group--last' : '',
                      ].filter(Boolean).join(' ')}
                      style={{ cursor: 'pointer' }}
                      onClick={() => setOpenSid(r.sid)}
                    >
                      <td className="mono"><b>{r.sid}</b></td>

                      <td className="mono muted" style={{ fontSize: '.78rem' }}>
                        {r.pid || '—'}
                        {/* Only the first row of a multi-sample patient carries
                            the count, so the repetition reads as one patient
                            rather than as duplicate rows. */}
                        {groupByPid && groupSize > 1 && isGroupStart && (
                          <span className="badge badge--role" style={{ marginLeft: '.4rem' }}>
                            {groupSize} samples
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
                      <td><StatusBadge status={r.status} statusCode={r.statusCode} /></td>
                      <td className="muted" style={{ fontSize: '.78rem' }}>{fmtDateTime(r.registeredAt)}</td>
                      <td style={{ textAlign: 'right' }}>
                        <ActionButton statusCode={r.statusCode} onOpen={() => setOpenSid(r.sid)} />
                      </td>
                    </tr>
                ))}

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

          <Pager page={page} pageSize={pageSize} total={total} noun="sample"
                 sizes={PAGE_SIZES} onPage={setPage} onPageSize={setPageSize} />
        </>
      )}

      {openSid && (
        <WorksheetEntry sid={openSid} onClose={() => setOpenSid(null)} onSaved={() => void load()} />
      )}
    </div>
  );
}
