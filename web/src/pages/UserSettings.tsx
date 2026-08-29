import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pager } from '../components/Pager';
import { api, ApiError, csrfHeader } from '../api/client';
import { fmtDate, fmtDateTime, inr } from '../lib/format';
import { InfinityLoader } from '../components/InfinityLoader';

interface MappedClientCode {
  mccId: number;
  clientCode: string | null;
  clientName: string | null;
  addedBy: string | null;
  addedAt: string | null;
  addedByInfinity: boolean;
}

interface OwnCentre {
  mccId: number;
  clientCode: string | null;
  clientName: string | null;
  source: string;
}

interface LisSecurityBits {
  auth: boolean;
  resultEntry: boolean;
  editPatientTests: boolean;
  discount: boolean;
}

export interface AdminUserDetail {
  userId: number;
  username: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  usertypeId: number | null;
  usertypeName: string | null;
  lisIsActive: boolean;
  managedBy: 'infinity' | 'telo' | 'lis';
  infinityActive: boolean | null;
  infinityLisAccess: boolean | null;
  infinityRole: string | null;
  effectiveRole: string;
  effectiveCapabilities: string[];
  sessionVersion: number;
  lisSecurity: LisSecurityBits;
  clientCodes: MappedClientCode[];
  ownCentres: OwnCentre[];
}

interface ClientCodeOption {
  mccId: number;
  clientCode: string;
  clientName: string | null;
  alreadyMapped: boolean;
}

interface CentreLockState {
  mccId: number;
  code: string | null;
  name: string | null;
  permanent: boolean;
  creditLimit: number | null;
  currentBalance: number | null;
  tempExpire: string | null;
}

type Tab = 'profile' | 'credentials' | 'access' | 'clients' | 'lock';

export function UserSettings({
  userId,
  roles,
  onClose,
  onChanged,
}: {
  userId: number;
  roles: string[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const [tab, setTab] = useState<Tab>('profile');
  const [d, setD] = useState<AdminUserDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setD(await api.get<AdminUserDetail>(`/api/admin/users/${userId}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load this account.');
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function run(fn: () => Promise<void>, ok: string) {
    setBusy(true); setError(null); setNotice(null);
    try {
      await fn();
      setNotice(ok);
      await load();
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The change could not be saved.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" style={{ width: 'min(760px, 100%)' }} onClick={(e) => e.stopPropagation()}
           role="dialog" aria-modal="true" aria-label="Account settings">
        {loading ? (
          <div className="center" style={{ minHeight: 180 }}><InfinityLoader /></div>
        ) : !d ? (
          <>
            <div className="alert alert--error">{error ?? 'Not found.'}</div>
            <div className="modal__actions"><button className="btn btn--ghost" onClick={onClose}>Close</button></div>
          </>
        ) : (
          <>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <h2 className="modal__title">{d.username}</h2>
                <p className="muted" style={{ fontSize: '.8rem', marginTop: '.15rem' }}>
                  {[d.firstName, d.lastName].filter(Boolean).join(' ') || 'No name set'}
                  {d.usertypeName && ` · LIS: ${d.usertypeName}`}
                </p>
              </div>
              <span className={`badge badge--${d.managedBy}`}>{d.managedBy}</span>
            </div>

            <div className="tabs">
              {(['profile', 'credentials', 'access', 'clients',
                 ...(d.ownCentres.length > 0 ? ['lock'] : [])] as Tab[]).map((t) => (
                <button key={t} className={`tab ${tab === t ? 'tab--on' : ''}`} onClick={() => setTab(t)}>
                  {t === 'profile' ? 'Profile'
                    : t === 'credentials' ? 'Credentials'
                    : t === 'access' ? 'Role & access'
                    : t === 'clients' ? `Client access (${d.clientCodes.length})`
                    : 'Report lock'}
                </button>
              ))}
            </div>

            {error && <div className="alert alert--error">{error}</div>}
            {notice && <div className="alert alert--ok">{notice}</div>}

            {tab === 'profile' && <ProfileTab d={d} busy={busy} run={run} />}
            {tab === 'credentials' && <CredentialsTab d={d} busy={busy} run={run} setError={setError} />}
            {tab === 'access' && <AccessTab d={d} roles={roles} busy={busy} run={run} />}
            {tab === 'clients' && <ClientsTab d={d} busy={busy} run={run} />}
            {tab === 'lock' && <LockTab d={d} busy={busy} run={run} setError={setError} />}

            <div className="modal__actions">
              <button className="btn btn--ghost" onClick={onClose}>Close</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* ---------------- profile ---------------- */

function ProfileTab({ d, busy, run }: { d: AdminUserDetail; busy: boolean; run: (f: () => Promise<void>, ok: string) => Promise<void> }) {
  const [first, setFirst] = useState(d.firstName ?? '');
  const [last, setLast] = useState(d.lastName ?? '');
  const [email, setEmail] = useState(d.email ?? '');

  const dirty = first !== (d.firstName ?? '') || last !== (d.lastName ?? '') || email !== (d.email ?? '');

  return (
    <div className="stack">
      <div className="grid2">
        <div className="field">
          <label htmlFor="p-first">First name</label>
          <input id="p-first" value={first} onChange={(e) => setFirst(e.target.value)} maxLength={100} />
        </div>
        <div className="field">
          <label htmlFor="p-last">Last name</label>
          <input id="p-last" value={last} onChange={(e) => setLast(e.target.value)} maxLength={100} />
        </div>
      </div>
      <div className="field">
        <label htmlFor="p-email">Email</label>
        <input id="p-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={100} />
      </div>

      <p className="muted" style={{ fontSize: '.74rem', lineHeight: 1.6 }}>
        The username is the login and cannot be changed here. Editing a name or email is allowed for any
        account, including native LIS ones — it changes nothing about what the user can reach.
      </p>

      <div>
        <button className="btn btn--primary btn--sm" disabled={busy || !dirty || !first.trim()}
                onClick={() => run(
                  () => api.put(`/api/admin/users/${d.userId}/profile`, { firstName: first.trim(), lastName: last.trim() || null, email: email.trim() || null }),
                  'Profile updated.')}>
          Save profile
        </button>
      </div>
    </div>
  );
}

/* ---------------- role & access ---------------- */

function AccessTab({ d, roles, busy, run }: { d: AdminUserDetail; roles: string[]; busy: boolean; run: (f: () => Promise<void>, ok: string) => Promise<void> }) {
  const isInfinity = d.managedBy === 'infinity';

  return (
    <div className="stack">
      <div className="field">
        <label htmlFor="a-role">Infinity role</label>
        <select id="a-role" value={d.effectiveRole} disabled={busy}
                onChange={(e) => run(() => api.put(`/api/admin/users/${d.userId}/role`, { role: e.target.value }), 'Role updated.')}>
          {roles.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
        {!d.infinityRole && (
          <span className="muted" style={{ fontSize: '.7rem' }}>
            Currently derived from the LIS user type — saving pins it explicitly.
          </span>
        )}
      </div>

      <div>
        <div className="muted" style={{ fontSize: '.68rem', letterSpacing: '.14em', textTransform: 'uppercase', marginBottom: '.4rem' }}>
          Permissions granted by this role
        </div>
        <div className="row" style={{ flexWrap: 'wrap', gap: '.35rem' }}>
          {d.effectiveCapabilities.map((c) => <span key={c} className="badge badge--role">{c}</span>)}
        </div>
        <p className="muted" style={{ fontSize: '.72rem', marginTop: '.5rem', lineHeight: 1.6 }}>
          Permissions come from the role and are enforced by the API on every request. Changing the role
          revokes existing sessions immediately.
        </p>
      </div>

      <div className="grid2">
        <Toggle label="Infinity sign-in" on={d.infinityActive === true} disabled={busy || !isInfinity}
                hint={isInfinity ? 'Can sign in to Infinity' : 'Managed outside Infinity'}
                onClick={() => run(() => api.put(`/api/admin/users/${d.userId}/active`, { enabled: !d.infinityActive }),
                  d.infinityActive ? 'Infinity sign-in disabled.' : 'Infinity sign-in enabled.')} />

        <Toggle label="Legacy LIS sign-in" on={d.infinityLisAccess === true} disabled={busy || !isInfinity}
                hint={isInfinity
                  ? 'Whether these credentials also work on the LIS'
                  : d.lisIsActive ? 'Active in the LIS (managed there)' : 'Inactive in the LIS'}
                onClick={() => run(() => api.put(`/api/admin/users/${d.userId}/lis-access`, { enabled: !d.infinityLisAccess }),
                  d.infinityLisAccess ? 'LIS access revoked.' : 'LIS access granted.')} />
      </div>

      {!isInfinity && (
        <div className="alert alert--info">
          This account is managed by <b>{d.managedBy === 'telo' ? 'Telo' : 'the legacy LIS'}</b>. Sign-in and
          password are controlled there — Infinity can still set the role and client access.
        </div>
      )}

      <div>
        <div className="muted" style={{ fontSize: '.68rem', letterSpacing: '.14em', textTransform: 'uppercase', marginBottom: '.35rem' }}>
          LIS security bits (read-only)
        </div>
        <div className="row" style={{ flexWrap: 'wrap', gap: '.35rem' }}>
          {([['Authorise', d.lisSecurity.auth], ['Result entry', d.lisSecurity.resultEntry],
             ['Edit tests', d.lisSecurity.editPatientTests], ['Discount', d.lisSecurity.discount]] as const)
            .map(([label, on]) => (
              <span key={label} className={`badge ${on ? 'badge--infinity' : 'badge--lis'}`}>
                {label}: {on ? 'yes' : 'no'}
              </span>
            ))}
        </div>
        <p className="muted" style={{ fontSize: '.72rem', marginTop: '.45rem' }}>
          Set per LIS user type in the legacy system. Shown for context; Infinity uses its own role model.
        </p>
      </div>
    </div>
  );
}

/* ---------------- credentials ---------------- */

function CredentialsTab({ d, busy, run, setError }:
  { d: AdminUserDetail; busy: boolean;
    run: (f: () => Promise<void>, ok: string) => Promise<void>;
    setError: (m: string | null) => void }) {
  const [revealed, setRevealed] = useState<string | null>(null);
  const [revealing, setRevealing] = useState(false);
  const [pw, setPw] = useState('');
  const [showReset, setShowReset] = useState(false);

  // Telo owns its own accounts' credentials; changing them here would fight the
  // other system. Everything else — including native LIS accounts — is ours to
  // reset now, since Infinity is replacing the LIS.
  const teloOwned = d.managedBy === 'telo';

  async function reveal() {
    setRevealing(true);
    setError(null);
    try {
      const r = await api.get<{ password: string | null }>(`/api/admin/users/${d.userId}/password`);
      setRevealed(r.password ?? '');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not read the password.');
    } finally {
      setRevealing(false);
    }
  }

  return (
    <div className="stack">
      <div className="field">
        <label>Username</label>
        <input className="input mono" value={d.username} readOnly
               onFocus={(e) => e.currentTarget.select()} />
        <span className="muted" style={{ fontSize: '.7rem' }}>The login. It cannot be changed.</span>
      </div>

      <div className="card" style={{ padding: '.8rem .9rem' }}>
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div style={{ fontSize: '.82rem', fontWeight: 600 }}>Current password</div>
            <div className="muted" style={{ fontSize: '.72rem' }}>
              {revealed == null ? 'Hidden. Revealing it is recorded in the audit trail.' : 'Visible below — click hide when done.'}
            </div>
          </div>
          {revealed == null ? (
            <button className="btn btn--ghost btn--sm" disabled={revealing || teloOwned}
                    onClick={() => void reveal()}>
              {revealing ? 'Revealing…' : 'Reveal'}
            </button>
          ) : (
            <button className="btn btn--ghost btn--sm" onClick={() => setRevealed(null)}>Hide</button>
          )}
        </div>
        {revealed != null && (
          <div className="row" style={{ marginTop: '.6rem', gap: '.4rem' }}>
            <input className="input mono" readOnly value={revealed}
                   style={{ flex: 1 }} onFocus={(e) => e.currentTarget.select()} />
            <button className="btn btn--ghost btn--sm"
                    onClick={() => void navigator.clipboard?.writeText(revealed).catch(() => {})}>
              Copy
            </button>
          </div>
        )}
        {teloOwned && (
          <div className="muted" style={{ fontSize: '.72rem', marginTop: '.4rem' }}>
            This account is managed by Telo — its credential is controlled there.
          </div>
        )}
      </div>

      {!teloOwned && (
        <div className="card" style={{ padding: '.8rem .9rem' }}>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <div style={{ fontSize: '.82rem', fontWeight: 600 }}>Reset password</div>
              <div className="muted" style={{ fontSize: '.72rem' }}>
                Sets a new password and signs the user out of every current session.
                {d.managedBy !== 'infinity' && ' This is also their legacy LIS login.'}
              </div>
            </div>
            {!showReset && (
              <button className="btn btn--ghost btn--sm" onClick={() => setShowReset(true)}>Change…</button>
            )}
          </div>
          {showReset && (
            <div className="row" style={{ marginTop: '.6rem', gap: '.4rem' }}>
              <input className="input mono" placeholder="New password" value={pw} maxLength={50}
                     onChange={(e) => setPw(e.target.value)} style={{ flex: 1 }} autoFocus />
              <button className="btn btn--primary btn--sm" disabled={busy || pw.trim() === ''}
                      onClick={() => void run(
                        () => api.put(`/api/admin/users/${d.userId}/password`, { password: pw }),
                        'Password reset — the user must sign in again.').then(() => { setPw(''); setShowReset(false); })}>
                Save
              </button>
              <button className="btn btn--ghost btn--sm" disabled={busy}
                      onClick={() => { setPw(''); setShowReset(false); }}>Cancel</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ---------------- report lock ---------------- */

function LockTab({ d, busy, run, setError }:
  { d: AdminUserDetail; busy: boolean;
    run: (f: () => Promise<void>, ok: string) => Promise<void>;
    setError: (m: string | null) => void }) {
  const [states, setStates] = useState<CentreLockState[] | null>(null);
  const [hours, setHours] = useState<Record<number, string>>({});
  const mccIds = useMemo(() => d.ownCentres.map((c) => c.mccId).join(','), [d.ownCentres]);

  const load = useCallback(async () => {
    try {
      const r = await api.get<{ centres: CentreLockState[] }>(
        `/api/admin/centres/lock-state?mccIds=${encodeURIComponent(mccIds)}`);
      setStates(r.centres);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not load lock state.');
    }
  }, [mccIds, setError]);

  useEffect(() => { void load(); }, [load]);

  // Credit limit is stored NEGATIVE ("may owe up to"); show it as a positive
  // allowance. Balance below the floor is what locks a centre.
  const floor = (limit: number | null) => (limit != null && limit < 0 ? -limit : 0);

  return (
    <div className="stack">
      <p className="muted" style={{ fontSize: '.74rem', lineHeight: 1.6 }}>
        A centre's reports are held while it owes more than its credit allowance. Grant a permanent
        unlock to release it regardless of balance, or a temporary window for "pay tomorrow, send today".
        Both are recorded in the audit trail.
      </p>

      {states == null ? (
        <div className="center" style={{ minHeight: 80 }}><InfinityLoader /></div>
      ) : states.length === 0 ? (
        <p className="muted" style={{ fontSize: '.82rem' }}>No centre resolved for this account.</p>
      ) : states.map((c) => {
        const owed = c.currentBalance != null && c.currentBalance < 0 ? -c.currentBalance : 0;
        const tempLive = c.tempExpire != null && new Date(c.tempExpire).getTime() > Date.now();
        return (
          <div key={c.mccId} className="card" style={{ padding: '.85rem .95rem' }}>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
              <div>
                <b className="mono">{c.code}</b>
                <span className="muted" style={{ marginLeft: '.4rem', fontSize: '.8rem' }}>{c.name}</span>
              </div>
              <span className="muted" style={{ fontSize: '.76rem' }}>
                Owes {inr(owed)} of {inr(floor(c.creditLimit))} allowance
              </span>
            </div>

            <div className="grid2" style={{ marginTop: '.6rem' }}>
              <Toggle label="Permanent unlock" on={c.permanent} disabled={busy}
                      hint={c.permanent ? 'Never balance-locked' : 'Locked when over the allowance'}
                      onClick={() => void run(
                        () => api.put(`/api/admin/centres/${c.mccId}/permanent-unlock`, { enabled: !c.permanent }),
                        c.permanent ? 'Permanent unlock removed.' : 'Permanently unlocked.').then(load)} />

              <div className="card" style={{ padding: '.7rem .85rem' }}>
                <div style={{ fontSize: '.82rem', fontWeight: 500 }}>Temporary unlock</div>
                <div className="muted" style={{ fontSize: '.7rem', marginTop: '.25rem' }}>
                  {tempLive ? `Active until ${fmtDateTime(c.tempExpire)}` : 'None active'}
                </div>
                <div className="row" style={{ marginTop: '.45rem', gap: '.35rem' }}>
                  <input className="input" type="number" min={1} max={720} placeholder="Hours"
                         value={hours[c.mccId] ?? ''} style={{ width: '5.5rem' }}
                         onChange={(e) => setHours((h) => ({ ...h, [c.mccId]: e.target.value }))} />
                  <button className="btn btn--ghost btn--sm"
                          disabled={busy || !(Number(hours[c.mccId]) > 0)}
                          onClick={() => void run(
                            () => api.post(`/api/admin/centres/${c.mccId}/temp-unlock`,
                                           { hours: Number(hours[c.mccId]) }, csrfHeader()),
                            `Unlocked for ${hours[c.mccId]} hour(s).`)
                            .then(() => { setHours((h) => ({ ...h, [c.mccId]: '' })); return load(); })}>
                    Grant
                  </button>
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Toggle({ label, on, disabled, hint, onClick }:
  { label: string; on: boolean; disabled: boolean; hint: string; onClick: () => void }) {
  return (
    <div className="card" style={{ padding: '.7rem .85rem' }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span style={{ fontSize: '.82rem', fontWeight: 500 }}>{label}</span>
        <button className={`toggle ${on ? 'toggle--on' : ''}`} disabled={disabled} onClick={onClick} aria-pressed={on} aria-label={label} />
      </div>
      <div className="muted" style={{ fontSize: '.7rem', marginTop: '.25rem' }}>{hint}</div>
    </div>
  );
}

/* ---------------- client access ---------------- */

function ClientsTab({ d, busy, run }: { d: AdminUserDetail; busy: boolean; run: (f: () => Promise<void>, ok: string) => Promise<void> }) {
  const [selected, setSelected] = useState<string[]>(() => d.clientCodes.map((c) => c.clientCode ?? '').filter(Boolean));
  const [search, setSearch] = useState('');
  const [options, setOptions] = useState<ClientCodeOption[]>([]);
  const [searching, setSearching] = useState(false);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const pageSize = 50;

  const original = useMemo(() => new Set(d.clientCodes.map((c) => c.clientCode ?? '').filter(Boolean)), [d.clientCodes]);
  const chosen = useMemo(() => new Set(selected), [selected]);
  const dirty = original.size !== chosen.size || [...chosen].some((c) => !original.has(c));

  useEffect(() => {
    let live = true;
    setSearching(true);
    const id = setTimeout(() => {
      api.get<{ options: ClientCodeOption[]; total: number }>(
        `/api/admin/users/${d.userId}/client-codes/search`
        + `?search=${encodeURIComponent(search)}&page=${page}&pageSize=${pageSize}`)
        .then((r) => { if (live) { setOptions(r.options); setTotal(r.total); } })
        .catch(() => { if (live) { setOptions([]); setTotal(0); } })
        .finally(() => { if (live) setSearching(false); });
    }, 250);
    return () => { live = false; clearTimeout(id); };
  }, [search, page, d.userId]);

  // Every centre is reachable by paging, so a code that does not fit on the
  // first screen is not lost — but a new search has to start at page 1 or the
  // list comes back empty for a term that matches plenty.
  useEffect(() => { setPage(1); }, [search]);

  const toggle = (code: string) =>
    setSelected((s) => s.includes(code) ? s.filter((x) => x !== code) : [...s, code]);

  const removingForeign = d.clientCodes.filter((c) => !c.addedByInfinity && c.clientCode && !chosen.has(c.clientCode));

  return (
    <div className="stack">
      {d.ownCentres.length > 0 && (
        <div className="alert alert--info">
          <b>Own centre{d.ownCentres.length > 1 ? 's' : ''}:</b>{' '}
          {d.ownCentres.map((o) => o.clientCode).filter(Boolean).join(', ')}. Reached automatically from the
          account's own centre — no mapping needed, and cannot be removed here.
        </div>
      )}

      <div>
        <div className="muted" style={{ fontSize: '.68rem', letterSpacing: '.14em', textTransform: 'uppercase', marginBottom: '.4rem' }}>
          Granted client codes ({selected.length})
        </div>
        {selected.length === 0 ? (
          <p className="muted" style={{ fontSize: '.8rem' }}>
            None. With no granted codes and no own centre, this user sees no patients, orders or reports.
          </p>
        ) : (
          <div className="row" style={{ flexWrap: 'wrap', gap: '.35rem' }}>
            {selected.map((c) => (
              <button key={c} className="chip" onClick={() => toggle(c)} disabled={busy} title="Remove">
                {c} <span aria-hidden="true">×</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="field">
        <label htmlFor="c-search">Add or remove centres</label>
        <input id="c-search" className="input" placeholder="Search client code or name…"
               value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>

      <div className="table-wrap" style={{ maxHeight: 220, overflowY: 'auto' }}>
        <table>
          <tbody>
            {searching && options.length === 0 && (
              <tr><td className="muted" style={{ padding: '1rem' }}>Searching…</td></tr>
            )}
            {options.map((o) => (
              <tr key={o.mccId} style={{ cursor: 'pointer' }} onClick={() => toggle(o.clientCode)}>
                <td style={{ width: 34 }}>
                  <input type="checkbox" checked={chosen.has(o.clientCode)} readOnly aria-label={o.clientCode} />
                </td>
                <td className="mono" style={{ width: 110 }}>{o.clientCode}</td>
                <td className="muted">{o.clientName ?? '—'}</td>
              </tr>
            ))}
            {!searching && options.length === 0 && (
              <tr><td className="muted" style={{ padding: '1rem' }}>No centres match.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Selections live outside the page, so ticking a code on page 1 and
          another on page 3 keeps both. */}
      <Pager page={page} pageSize={pageSize} total={total} noun="centre"
             onPage={setPage} />

      {removingForeign.length > 0 && (
        <div className="alert alert--error">
          You are removing {removingForeign.length} mapping{removingForeign.length > 1 ? 's' : ''} that Infinity
          did not create ({removingForeign.map((c) => c.clientCode).join(', ')}). These were granted in the LIS
          or by Telo. The removal will be recorded in the audit trail.
        </div>
      )}

      <p className="muted" style={{ fontSize: '.72rem', lineHeight: 1.6 }}>
        Client codes decide which patients, orders and reports this user can see. Saving revokes their current
        sessions so the change takes effect immediately.
      </p>

      <div className="row">
        <button className="btn btn--primary btn--sm" disabled={busy || !dirty}
                onClick={() => run(() => api.put(`/api/admin/users/${d.userId}/client-codes`, { codes: selected }), 'Client access updated.')}>
          Save client access
        </button>
        {dirty && (
          <button className="btn btn--ghost btn--sm" disabled={busy}
                  onClick={() => setSelected([...original])}>
            Revert
          </button>
        )}
      </div>

      {d.clientCodes.length > 0 && (
        <details>
          <summary className="muted" style={{ fontSize: '.74rem', cursor: 'pointer' }}>Where each grant came from</summary>
          <div className="table-wrap" style={{ marginTop: '.5rem' }}>
            <table>
              <tbody>
                {d.clientCodes.map((c) => (
                  <tr key={c.mccId}>
                    <td className="mono" style={{ width: 110 }}>{c.clientCode}</td>
                    <td className="muted">{c.addedBy ?? 'unknown'}</td>
                    <td className="muted">{fmtDate(c.addedAt)}</td>
                    <td>{c.addedByInfinity ? <span className="badge badge--infinity">infinity</span> : <span className="badge badge--lis">legacy</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </div>
  );
}
