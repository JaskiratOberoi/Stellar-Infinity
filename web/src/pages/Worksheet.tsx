import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client';
import { fmtDateTime } from '../lib/format';
import { StatusBadge, type WorksheetRow } from './Reports';
import { WorksheetEntry } from './WorksheetEntry';
import { Pager } from '../components/Pager';
import { InfinityLoader } from '../components/InfinityLoader';
import {
  SampleFilters, ActiveFilterChips, useFilterOptions, applyFilterParams,
  initialFilters, type SampleFilterValues,
} from '../components/SampleFilters';
import { TestList } from '../components/TestList';

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

  /** Every filter is on screen; there is no hidden set to track a count for. */
  const [adv, setAdv] = useState<SampleFilterValues>(() => initialFilters(1));
  const options = useFilterOptions();



  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const p = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
      applyFilterParams(p, adv);

      // Every filter goes to the server so that paging and the total count
      // describe the same set the operator is looking at.
      //
      // Three cases, one control: 'all' asks for no status filter, a number
      // asks for that status, and '' is this page's default — outstanding.
      if (adv.statusId === 'all') { /* no status filter */ }
      else if (adv.statusId !== '') p.set('statusIds', String(adv.statusId));
      else p.set('statusIds', PENDING_STATUSES.join(','));

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
  }, [adv, page, pageSize]);

  useEffect(() => {
    const id = setTimeout(() => void load(), 300);
    return () => clearTimeout(id);
  }, [load]);

  // A filter that narrows the result set must reset the page, or page 4 of the
  // old set silently shows nothing for the new one.
  useEffect(() => { setPage(1); }, [pageSize, adv]);

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

        {/* Only the action stays in the header. Back to page 1 takes a fresh
            snapshot, which is the only way to pick up samples registered since
            the walk began. */}
        <button className="btn btn--ghost btn--sm" style={{ marginLeft: 'auto' }}
                onClick={() => { asOfRef.current = null; setPage(1); void load(); }}>
          Refresh
        </button>
      </div>

      {/* What is currently narrowing the list, above the panel and removable.
          The component has exported these since it was written and no screen
          ever rendered them. */}
      <ActiveFilterChips value={adv} options={options} onChange={setAdv} statusOptions={STATUSES} />

      <SampleFilters
        value={adv} options={options} onChange={setAdv} statusOptions={STATUSES}
        // "Outstanding" is this page's default status set, so it is named and
        // selectable inside the Status control rather than being a second
        // checkbox that the status has to disable.
        defaultStatusLabel="Outstanding"
      >
        {/* Group by patient is NOT a filter — it changes how the same rows are
            drawn, not which rows they are. It sits in the footer alone now that
            the status shorthand has moved into the status control, so the panel
            no longer presents a display option and a filter as the same kind of
            thing. */}
        <label className="row" style={{ gap: '.4rem', fontSize: '.8rem', cursor: 'pointer' }}
               title={multiSamplePatients > 0
                 ? `${multiSamplePatients} patient${multiSamplePatients === 1 ? '' : 's'} with more than one sample.`
                 : 'Keeps a patient’s samples together.'}>
          <input type="checkbox" checked={groupByPid}
                 onChange={(e) => setGroupByPid(e.target.checked)} />
          Group by patient
        </label>
      </SampleFilters>

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
          {/* --cards: below 880px every row re-lays as a card. Same markup,
              one stylesheet block — see "Rows as cards" in styles.css. Half the
              people opening this screen are on a phone at a collection centre,
              and an eight-column table is a sideways drag on one. */}
          <div className="table-wrap table-wrap--cards">
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
                      {/* The cell--* classes say what each cell becomes once
                          the row is a card: the SID is the headline, the status
                          badge sits beside it, and the button becomes the
                          card's foot. data-label carries the column heading
                          down, because the <thead> is off-screen there. */}
                      <td className="mono cell--lead"><b>{r.sid}</b></td>

                      <td className="mono muted cell--meta" data-label="PID" style={{ fontSize: '.78rem' }}>
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

                      <td className="cell--head">
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

                      <td className="muted cell--meta" data-label="Client">{r.clientCode ?? '—'}</td>
                      <td className="cell--body" data-label="Tests">
                        <TestList names={r.testNames} />
                      </td>
                      <td className="cell--tag"><StatusBadge status={r.status} statusCode={r.statusCode} /></td>
                      <td className="muted cell--meta" data-label="Registered" style={{ fontSize: '.78rem' }}>
                        {fmtDateTime(r.registeredAt)}
                      </td>
                      <td className="cell--action">
                        <ActionButton statusCode={r.statusCode} onOpen={() => setOpenSid(r.sid)} />
                      </td>
                    </tr>
                ))}

                {visible.length === 0 && scope !== 'none' && (
                  <tr>
                    <td colSpan={8} className="muted" style={{ textAlign: 'center', padding: '2rem' }}>
                      {/* Names the control that is hiding them, by the label it
                          now carries in the panel. */}
                      {adv.statusId === ''
                        ? 'Nothing outstanding in this window — set Status to “Any status” to see completed samples.'
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
