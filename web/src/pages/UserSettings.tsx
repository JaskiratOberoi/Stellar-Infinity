import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../api/client';
import { fmtDate } from '../lib/format';

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

type Tab = 'profile' | 'access' | 'clients';

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
          <div className="center" style={{ minHeight: 180 }}><div className="spinner" /></div>
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
              {(['profile', 'access', 'clients'] as Tab[]).map((t) => (
                <button key={t} className={`tab ${tab === t ? 'tab--on' : ''}`} onClick={() => setTab(t)}>
                  {t === 'profile' ? 'Profile' : t === 'access' ? 'Role & access' : `Client access (${d.clientCodes.length})`}
                </button>
              ))}
            </div>

            {error && <div className="alert alert--error">{error}</div>}
            {notice && <div className="alert alert--ok">{notice}</div>}

            {tab === 'profile' && <ProfileTab d={d} busy={busy} run={run} />}
            {tab === 'access' && <AccessTab d={d} roles={roles} busy={busy} run={run} />}
            {tab === 'clients' && <ClientsTab d={d} busy={busy} run={run} />}

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

      {d.managedBy === 'infinity' && (
        <div>
          <button className="btn btn--ghost btn--sm" disabled={busy} onClick={() => {
            const pw = window.prompt(`New password for ${d.username}:`);
            if (pw) void run(() => api.put(`/api/admin/users/${d.userId}/password`, { password: pw }), 'Password reset.');
          }}>
            Reset password
          </button>
        </div>
      )}
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

  const original = useMemo(() => new Set(d.clientCodes.map((c) => c.clientCode ?? '').filter(Boolean)), [d.clientCodes]);
  const chosen = useMemo(() => new Set(selected), [selected]);
  const dirty = original.size !== chosen.size || [...chosen].some((c) => !original.has(c));

  useEffect(() => {
    let live = true;
    setSearching(true);
    const id = setTimeout(() => {
      api.get<ClientCodeOption[]>(`/api/admin/users/${d.userId}/client-codes/search?search=${encodeURIComponent(search)}&top=50`)
        .then((r) => { if (live) setOptions(r); })
        .catch(() => { if (live) setOptions([]); })
        .finally(() => { if (live) setSearching(false); });
    }, 250);
    return () => { live = false; clearTimeout(id); };
  }, [search, d.userId]);

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
