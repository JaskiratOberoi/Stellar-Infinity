import { useCallback, useEffect, useState } from 'react';
import { rateListApi, type RateList, type RateListItem } from '../api/client';
import { inr, plainText } from '../lib/format';
import { Pager } from '../components/Pager';
import { InfinityLoader } from '../components/InfinityLoader';
import { useAuth } from '../auth/AuthContext';

const FILTERS = [
  { value: '', label: 'All tests' },
  { value: 'priced', label: 'Priced here' },
  { value: 'unpriced', label: 'No rate — bills at MRP' },
];

/**
 * Rate lists — what clients are charged.
 *
 * This is the other half of the catalogue: that screen shows the price a client
 * gets, this one sets it.
 *
 * TWO THINGS THIS SCREEN HAS TO KEEP SAYING.
 *
 * A rate list is SHARED. Many centres point at one list, so changing a price
 * re-prices all of them — not the client someone had in mind. Every list shows
 * its client count and the editor repeats it before saving.
 *
 * And it covers TESTS ONLY. The underlying procedure writes the test rate table
 * and nothing else, so profiles and master profiles cannot be priced here even
 * though the catalogue prices all three. Said plainly, because the alternative
 * is someone searching for a profile, not finding it, and assuming the
 * catalogue is incomplete.
 */
export function RateLists() {
  const { can } = useAuth();
  const canEdit = can('rate:manage');

  const [lists, setLists] = useState<RateList[]>([]);
  const [selected, setSelected] = useState<RateList | null>(null);
  const [listSearch, setListSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const loadLists = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await rateListApi.list(listSearch);
      setLists(r.rows);
      // Keep the selection in step with the refreshed row, so the client count
      // beside the editor is never a stale copy.
      setSelected((s) => (s ? r.rows.find((x) => x.id === s.id) ?? null : null));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load rate lists.');
    } finally {
      setLoading(false);
    }
  }, [listSearch]);

  useEffect(() => {
    const t = setTimeout(() => void loadLists(), 300);
    return () => clearTimeout(t);
  }, [loadLists]);

  return (
    <div className="page">
      <div className="page__head">
        <div>
          <h1 className="page__title">Rate lists</h1>
          <p className="page__sub">
            {lists.length} list{lists.length === 1 ? '' : 's'} · what clients are charged
          </p>
        </div>
        <div className="row" style={{ marginLeft: 'auto', flexWrap: 'wrap' }}>
          <input className="input" placeholder="Search lists…" value={listSearch}
                 onChange={(e) => setListSearch(e.target.value)} style={{ minWidth: 180 }} />
          {canEdit && (
            <button className="btn btn--primary btn--sm" onClick={() => setCreating(true)}>
              New rate list
            </button>
          )}
        </div>
      </div>

      {error && <div className="alert alert--error" style={{ marginBottom: '.8rem' }}>{error}</div>}
      {notice && <div className="alert alert--ok" style={{ marginBottom: '.8rem' }}>{notice}</div>}

      {loading ? (
        <div className="center"><InfinityLoader /><span className="muted">Loading rate lists…</span></div>
      ) : selected ? (
        <RateListEditor
          list={selected}
          canEdit={canEdit}
          onBack={() => setSelected(null)}
          onChanged={async (msg) => { setNotice(msg); await loadLists(); }}
        />
      ) : (
        <div className="table-wrap table-wrap--cards">
          <table>
            <thead>
              <tr>
                <th>Rate list</th>
                <th style={{ textAlign: 'right' }}>Clients</th>
                <th style={{ textAlign: 'right' }}>Priced tests</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {lists.map((l) => (
                <tr key={l.id}>
                  <td className="cell--lead">
                    {plainText(l.name) || `Rate #${l.id}`}
                    {!l.isActive && <span className="muted" style={{ fontSize: '.7rem' }}> · inactive</span>}
                  </td>

                  {/* The number that makes an edit feel as consequential as it
                      is. A list on 400 centres is not a per-client setting. */}
                  <td className="mono cell--tag" style={{ textAlign: 'right' }}>
                    {l.clientCount > 0
                      ? <b>{l.clientCount.toLocaleString()}</b>
                      : <span className="muted">none</span>}
                  </td>

                  <td className="mono muted cell--meta" data-label="Priced tests" style={{ textAlign: 'right' }}>
                    {l.pricedTests.toLocaleString()}
                  </td>

                  <td style={{ textAlign: 'right' }}>
                    <button className="btn btn--ghost btn--sm" onClick={() => setSelected(l)}>
                      {canEdit ? 'Open' : 'View'}
                    </button>
                  </td>
                </tr>
              ))}

              {lists.length === 0 && (
                <tr>
                  <td colSpan={4} className="muted" style={{ textAlign: 'center', padding: '2rem' }}>
                    No rate lists match.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {creating && (
        <NewListModal
          onClose={() => setCreating(false)}
          onDone={async (msg) => { setCreating(false); setNotice(msg); await loadLists(); }}
        />
      )}
    </div>
  );
}

/** The tests in one list, with their prices. */
function RateListEditor({
  list, canEdit, onBack, onChanged,
}: {
  list: RateList;
  canEdit: boolean;
  onBack: () => void;
  onChanged: (message: string) => Promise<void>;
}) {
  const [rows, setRows] = useState<RateListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(100);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<RateListItem | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await rateListApi.items(list.id, search, filter, page, pageSize);
      setRows(r.rows);
      setTotal(r.total);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the rates.');
    } finally {
      setLoading(false);
    }
  }, [list.id, search, filter, page, pageSize]);

  useEffect(() => {
    const t = setTimeout(() => void load(), 300);
    return () => clearTimeout(t);
  }, [load]);

  useEffect(() => { setPage(1); }, [search, filter, pageSize]);

  return (
    <>
      <div className="row" style={{ marginBottom: '.8rem', flexWrap: 'wrap' }}>
        <button className="btn btn--ghost btn--sm" onClick={onBack}>← All rate lists</button>
        <h2 style={{ fontSize: '1rem', fontWeight: 500 }}>{plainText(list.name) || `Rate #${list.id}`}</h2>
        <input className="input" placeholder="Search tests…" value={search}
               onChange={(e) => setSearch(e.target.value)} style={{ minWidth: 200, marginLeft: 'auto' }} />
        <select className="input" value={filter} onChange={(e) => setFilter(e.target.value)}>
          {FILTERS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
        </select>
      </div>

      {/* Restated here, next to the thing being edited, not only on the list. */}
      {list.clientCount > 0 && (
        <div className="alert alert--info" style={{ marginBottom: '.8rem' }}>
          <b>{list.clientCount.toLocaleString()}</b> client
          {list.clientCount === 1 ? ' is' : 's are'} priced by this list. Changing a rate here changes
          what {list.clientCount === 1 ? 'that client' : 'all of them'} pay.
        </div>
      )}

      <p className="muted" style={{ fontSize: '.76rem', marginBottom: '.7rem' }}>
        Tests only. Profiles and master profiles cannot be priced here — the LIS keeps their rates in
        separate tables with no write path, so they take their price from a per-client special rate or
        from MRP.
      </p>

      {error && <div className="alert alert--error" style={{ marginBottom: '.8rem' }}>{error}</div>}

      {loading ? (
        <div className="center"><InfinityLoader /><span className="muted">Loading rates…</span></div>
      ) : (
        <div className="table-wrap table-wrap--cards">
          <table>
            <thead>
              <tr>
                <th>Test</th>
                <th>Code</th>
                <th>Department</th>
                <th style={{ textAlign: 'right' }}>MRP</th>
                <th style={{ textAlign: 'right' }}>Rate</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.id}>
                  <td className="cell--lead">{plainText(t.name) || t.code}</td>
                  <td className="mono muted cell--meta" data-label="Code">{t.code ?? '—'}</td>
                  <td className="muted cell--meta" data-label="Department">{t.departmentName ?? '—'}</td>
                  <td className="mono muted cell--meta" data-label="MRP" style={{ textAlign: 'right' }}>
                    {t.mrp != null && t.mrp > 0 ? inr(t.mrp) : '—'}
                  </td>
                  <td className="mono cell--tag" style={{ textAlign: 'right', fontWeight: 600 }}>
                    {t.rate != null
                      ? inr(t.rate)
                      // Not "—": no rate here has a consequence, and naming it
                      // is the difference between a gap and a decision.
                      : <span className="muted" style={{ fontWeight: 400 }}>bills at MRP</span>}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    {canEdit && (
                      <button className="btn btn--ghost btn--sm" onClick={() => setEditing(t)}>
                        {t.rate != null ? 'Change' : 'Set rate'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}

              {rows.length === 0 && (
                <tr>
                  <td colSpan={6} className="muted" style={{ textAlign: 'center', padding: '2rem' }}>
                    No tests match.
                  </td>
                </tr>
              )}
            </tbody>
          </table>

          <Pager page={page} pageSize={pageSize} total={total} noun="test"
                 onPage={setPage} onPageSize={setPageSize} />
        </div>
      )}

      {editing && (
        <SetRateModal
          list={list}
          item={editing}
          onClose={() => setEditing(null)}
          onDone={async (msg) => { setEditing(null); await load(); await onChanged(msg); }}
        />
      )}
    </>
  );
}

function SetRateModal({
  list, item, onClose, onDone,
}: {
  list: RateList;
  item: RateListItem;
  onClose: () => void;
  onDone: (message: string) => Promise<void>;
}) {
  const [price, setPrice] = useState(item.rate != null ? String(item.rate) : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  const value = Number(price);
  const valid = price !== '' && Number.isFinite(value) && value >= 0;

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await rateListApi.setRate(list.id, item.id, value);
      await onDone(`${plainText(item.name) || item.code} set to ${inr(value)} on ${plainText(list.name)}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The rate was not saved.');
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={() => { if (!busy) onClose(); }}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true"
           aria-label="Set rate">
        <h2 className="modal__title">{plainText(item.name) || item.code}</h2>
        <p className="muted" style={{ fontSize: '.82rem' }}>
          On <b>{plainText(list.name)}</b>
          {item.mrp != null && item.mrp > 0 && <> · MRP {inr(item.mrp)}</>}
          {item.rate != null && <> · currently {inr(item.rate)}</>}
        </p>

        {error && <div className="alert alert--error">{error}</div>}

        <div className="field">
          <label htmlFor="rate-price">Rate</label>
          <input id="rate-price" className="input mono" inputMode="numeric" autoFocus
                 value={price} onChange={(e) => setPrice(e.target.value.replace(/[^\d]/g, ''))} />
        </div>

        {list.clientCount > 0 && (
          <div className="alert alert--info" style={{ fontSize: '.76rem' }}>
            This changes the price for <b>{list.clientCount.toLocaleString()}</b> client
            {list.clientCount === 1 ? '' : 's'}, and applies to orders placed from now on. Bills
            already raised are not touched.
          </div>
        )}

        <div className="modal__actions">
          <button className="btn btn--ghost" disabled={busy} onClick={onClose}>Cancel</button>
          <button className="btn btn--primary" disabled={!valid || busy} onClick={() => void submit()}>
            {busy ? 'Saving…' : `Set ${valid ? inr(value) : 'rate'}`}
          </button>
        </div>
      </div>
    </div>
  );
}

function NewListModal({
  onClose, onDone,
}: {
  onClose: () => void;
  onDone: (message: string) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const r = await rateListApi.create(name.trim());
      await onDone(
        `Created "${name.trim()}".`
        + (r.seededCount > 0
          ? ` It starts with ${r.seededCount.toLocaleString()} rates already in it.`
          : ' It is empty — every test will bill at MRP until you set rates.'));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The rate list was not created.');
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={() => { if (!busy) onClose(); }}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true"
           aria-label="New rate list">
        <h2 className="modal__title">New rate list</h2>

        {error && <div className="alert alert--error">{error}</div>}

        <div className="field">
          <label htmlFor="rl-name">Name</label>
          <input id="rl-name" className="input" autoFocus maxLength={50}
                 value={name} onChange={(e) => setName(e.target.value)} />
          <span className="muted" style={{ fontSize: '.7rem' }}>
            Names must be unique — the LIS rejects a duplicate.
          </span>
        </div>

        <p className="muted" style={{ fontSize: '.74rem', lineHeight: 1.6 }}>
          A new list prices nobody until a client is pointed at it, which is done on the client's own
          record in the LIS rather than here.
        </p>

        <div className="modal__actions">
          <button className="btn btn--ghost" disabled={busy} onClick={onClose}>Cancel</button>
          <button className="btn btn--primary" disabled={!name.trim() || busy} onClick={() => void submit()}>
            {busy ? 'Creating…' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
}
