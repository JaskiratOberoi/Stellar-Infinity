import { useEffect, useMemo, useState } from 'react';
import { api, csrfHeader } from '../api/client';
import { inr } from '../lib/format';
import { InfinityLoader } from '../components/InfinityLoader';
import { ClientPicker } from '../components/ClientPicker';
import { useAuth } from '../auth/AuthContext';

/**
 * Referrers — the roster of referring doctors and customers a centre books
 * orders against, managed at last from Infinity.
 *
 * The legacy LIS keeps its only two referrer screens in the client portal
 * (Pcc/Doctors.aspx, Pcc/Customers.aspx): each centre maintains its own
 * roster, and the rows written here are indistinguishable from rows written
 * there — both platforms keep working off the same masters.
 *
 * What is deliberately different from the legacy screens:
 *   - no hard delete. The LIS's delete throws on any referrer with billing
 *     history and swallows the error; deactivation is the operation that
 *     works, so it is the only one offered. A deactivated referrer leaves the
 *     order form's picker but keeps its name on every historical order.
 *   - a duplicate-name warning before saving, which the LIS never had — its
 *     rosters are full of double entries for want of one.
 *   - the business view: bills and charges per referrer for a window, the
 *     living half of the LIS's lab-side "Doctor Referred Amount" screen,
 *     which clients could never see.
 */

interface RosterEntry {
  id: number; code: string; name: string; isActive: boolean;
  createdAt: string | null; createdBy: string | null;
}
interface StatRow { id: number | null; name: string; bills: number; charges: number }

type Kind = 'doctor' | 'customer';

const KIND_LABEL: Record<Kind, { one: string; many: string }> = {
  doctor: { one: 'doctor', many: 'Referring doctors' },
  customer: { one: 'customer', many: 'Referring customers' },
};

/** Yesterday-style ISO day, in IST — the portal's one clock. */
const istDay = (daysAgo = 0) => {
  const d = new Date(Date.now() - daysAgo * 86400_000);
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
};

export function Referrers() {
  const { can } = useAuth();
  const canEdit = can('order:create');

  const [mcc, setMcc] = useState<number | null>(null);
  const [roster, setRoster] = useState<{ doctors: RosterEntry[]; customers: RosterEntry[] }>(
    { doctors: [], customers: [] });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [from, setFrom] = useState(() => istDay(30));
  const [to, setTo] = useState(() => istDay(0));
  const [stats, setStats] = useState<{ doctors: StatRow[]; customers: StatRow[] } | null>(null);
  const [statsBusy, setStatsBusy] = useState(false);

  async function reload(m: number) {
    setLoading(true);
    setError(null);
    try {
      setRoster(await api.get(`/api/referrers?mcc=${m}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the roster.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (mcc == null) { setRoster({ doctors: [], customers: [] }); setStats(null); return; }
    void reload(mcc);
    setStats(null);
  }, [mcc]); // eslint-disable-line react-hooks/exhaustive-deps

  async function loadStats() {
    if (mcc == null) return;
    setStatsBusy(true);
    setError(null);
    try {
      setStats(await api.get(`/api/referrers/stats?mcc=${mcc}&from=${from}&to=${to}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the business view.');
    } finally {
      setStatsBusy(false);
    }
  }

  return (
    <div className="page">
      <div className="page__head">
        <div>
          <h1 className="page__title">Referrers</h1>
          <p className="page__sub">
            The doctors and customers this centre books orders against — the same
            roster the order form offers.
          </p>
        </div>
        <div style={{ minWidth: '18rem' }}>
          <ClientPicker value={mcc} onChange={setMcc} allowNone={false}
                        placeholder="Choose a centre…" />
        </div>
      </div>

      {error && <div className="alert alert--error" style={{ marginBottom: '.8rem' }}>{error}</div>}
      {loading && <div className="center"><InfinityLoader /></div>}

      {!loading && mcc != null && (
        <>
          <div className="refr__grid">
            <RosterCard kind="doctor" mcc={mcc} rows={roster.doctors}
                        canEdit={canEdit} onChanged={() => void reload(mcc)} onError={setError} />
            <RosterCard kind="customer" mcc={mcc} rows={roster.customers}
                        canEdit={canEdit} onChanged={() => void reload(mcc)} onError={setError} />
          </div>

          <h2 className="req__h2">Business</h2>
          <div className="card">
            <div className="refr__statbar">
              <label className="refr__statlabel">From
                <input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
              </label>
              <label className="refr__statlabel">To
                <input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
              </label>
              <button className="btn btn--primary btn--sm" disabled={statsBusy} onClick={() => void loadStats()}>
                {statsBusy ? 'Working…' : stats ? 'Refresh' : 'Show business'}
              </button>
              <span className="muted" style={{ fontSize: '.76rem' }}>
                Bills and charges per referrer, by bill date. Free-typed referrers that were
                never promoted to the roster cannot appear here — the LIS drops them at billing.
              </span>
            </div>
            {stats && (
              <div className="refr__grid" style={{ marginTop: '.8rem' }}>
                <StatTable title="By referring doctor" rows={stats.doctors} />
                <StatTable title="By referring customer" rows={stats.customers} />
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function RosterCard({ kind, mcc, rows, canEdit, onChanged, onError }: {
  kind: Kind; mcc: number; rows: RosterEntry[]; canEdit: boolean;
  onChanged: () => void; onError: (m: string | null) => void;
}) {
  const [query, setQuery] = useState('');
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<RosterEntry | null>(null);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [showInactive, setShowInactive] = useState(false);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const pool = showInactive ? rows : rows.filter((r) => r.isActive);
    return q
      ? pool.filter((r) => r.name.toLowerCase().includes(q) || r.code.toLowerCase().includes(q))
      : pool;
  }, [rows, query, showInactive]);

  const inactiveCount = rows.length - rows.filter((r) => r.isActive).length;

  // The duplicate warning the legacy screen never had. A warning, not a
  // refusal: "Dr Sharma" at a hospital this size can genuinely be two people,
  // and the code is what tells them apart.
  const dup = useMemo(() => {
    const n = name.trim().toLowerCase();
    if (!n) return false;
    return rows.some((r) => r.name.trim().toLowerCase() === n && r.id !== editing?.id);
  }, [rows, name, editing]);

  function startAdd() { setAdding(true); setEditing(null); setCode(''); setName(''); }
  function startEdit(r: RosterEntry) { setEditing(r); setAdding(false); setCode(r.code); setName(r.name); }
  function closeForm() { setAdding(false); setEditing(null); setCode(''); setName(''); }

  async function save(active: boolean, row?: RosterEntry) {
    setBusy(true);
    onError(null);
    try {
      await api.post('/api/referrers', {
        kind,
        id: row?.id ?? editing?.id ?? null,
        mcc,
        code: (row?.code ?? code).trim(),
        name: (row?.name ?? name).trim(),
        active,
      }, csrfHeader());
      closeForm();
      onChanged();
    } catch (e) {
      onError(e instanceof Error ? e.message : 'The save failed.');
    } finally {
      setBusy(false);
    }
  }

  const formOpen = adding || editing != null;
  const label = KIND_LABEL[kind];

  return (
    <div className="card">
      <div className="req__cardhead">
        <b>{label.many}
          <span className="muted" style={{ fontWeight: 400 }}> · {rows.filter((r) => r.isActive).length}</span>
        </b>
        <span style={{ display: 'flex', gap: '.4rem' }}>
          <input className="input" placeholder="Search…" value={query}
                 onChange={(e) => setQuery(e.target.value)} style={{ maxWidth: '11rem' }} />
          {canEdit && !formOpen && (
            <button className="btn btn--primary btn--sm" onClick={startAdd}>Add</button>
          )}
        </span>
      </div>

      {formOpen && (
        <div className="refr__form">
          <b style={{ fontSize: '.82rem' }}>
            {editing ? `Edit ${label.one}` : `New ${label.one}`}
          </b>
          <div className="refr__formrow">
            <input className="input" placeholder="Name" value={name} maxLength={100} autoFocus
                   onChange={(e) => setName(e.target.value)} style={{ flex: 2, minWidth: '10rem' }} />
            <input className="input mono" placeholder="Code (optional)" value={code} maxLength={50}
                   onChange={(e) => setCode(e.target.value)} style={{ flex: 1, minWidth: '7rem' }} />
          </div>
          {dup && (
            <div className="alert alert--warn" style={{ fontSize: '.76rem', padding: '.4rem .6rem' }}>
              A {label.one} with this exact name already exists at this centre — saving adds a second one.
            </div>
          )}
          <div className="refr__formrow">
            <button className="btn btn--primary btn--sm" disabled={busy || name.trim() === ''}
                    onClick={() => void save(editing?.isActive ?? true)}>
              {busy ? 'Saving…' : 'Save'}
            </button>
            <button className="btn btn--ghost btn--sm" disabled={busy} onClick={closeForm}>Cancel</button>
          </div>
        </div>
      )}

      <div className="refr__list">
        {filtered.map((r) => (
          <div key={r.id} className={`refr__row${r.isActive ? '' : ' refr__row--off'}`}>
            <span className="refr__row-main">
              <span>{r.name}</span>
              <span className="mono muted refr__row-code">{r.code}</span>
            </span>
            {!r.isActive && <span className="refr__off-pill">Inactive</span>}
            {canEdit && (
              <span className="refr__row-actions">
                <button className="btn btn--ghost btn--sm" disabled={busy}
                        onClick={() => startEdit(r)}>Edit</button>
                <button className="btn btn--ghost btn--sm" disabled={busy}
                        title={r.isActive
                          ? 'Removes it from the order form; history keeps the name.'
                          : 'Puts it back on the order form.'}
                        onClick={() => void save(!r.isActive, r)}>
                  {r.isActive ? 'Deactivate' : 'Reactivate'}
                </button>
              </span>
            )}
          </div>
        ))}
        {filtered.length === 0 && (
          <p className="muted" style={{ fontSize: '.82rem', padding: '.6rem 0' }}>
            {rows.length === 0
              ? `No ${label.many.toLowerCase()} on file for this centre yet.`
              : 'Nothing matches that.'}
          </p>
        )}
      </div>

      {inactiveCount > 0 && (
        <button className="btn btn--ghost btn--sm" style={{ marginTop: '.4rem' }}
                onClick={() => setShowInactive((s) => !s)}>
          {showInactive ? 'Hide' : 'Show'} {inactiveCount} inactive
        </button>
      )}
    </div>
  );
}

function StatTable({ title, rows }: { title: string; rows: StatRow[] }) {
  return (
    <div>
      <b style={{ fontSize: '.82rem' }}>{title}</b>
      <div className="req__tablewrap">
        <table className="refr__stats">
          <thead>
            <tr><th>Name</th><th className="num">Bills</th><th className="num">Charges</th></tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.id ?? `none-${i}`} className={r.id == null ? 'refr__row--off' : ''}>
                <td>{r.name}</td>
                <td className="num">{r.bills.toLocaleString('en-IN')}</td>
                <td className="num">{inr(r.charges)}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={3} className="muted">No bills in this window.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
