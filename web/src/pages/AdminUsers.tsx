import { useCallback, useEffect, useState } from 'react';
import { adminApi, ApiError, type AdminUserRow } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { CreateUserModal } from './CreateUserModal';

export function AdminUsers() {
  const { user } = useAuth();
  const [rows, setRows] = useState<AdminUserRow[]>([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [roles, setRoles] = useState<string[]>([]);

  const load = useCallback(async (q: string) => {
    setLoading(true);
    setError(null);
    try {
      const page = await adminApi.listUsers(q);
      setRows(page.users);
      setTotal(page.totalCount);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load users.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load('');
    adminApi.roles().then((r) => setRoles(r.map((x) => x.role))).catch(() => setRoles([]));
  }, [load]);

  // Debounced search — the SQL uses a leading wildcard and cannot use an index,
  // so we avoid firing one scan per keystroke.
  useEffect(() => {
    const t = setTimeout(() => void load(search), 300);
    return () => clearTimeout(t);
  }, [search, load]);

  async function act(userId: number, fn: () => Promise<void>, successMessage: string) {
    setBusyId(userId);
    setError(null);
    setNotice(null);
    try {
      await fn();
      setNotice(successMessage);
      await load(search);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The change could not be saved.');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="page">
      <div className="page__head">
        <div>
          <h1 className="page__title">Users</h1>
          <p className="page__sub">
            {total} account{total === 1 ? '' : 's'} · Infinity accounts are listed first
          </p>
        </div>

        <div className="row" style={{ marginLeft: 'auto' }}>
          <input
            className="input"
            placeholder="Search username, name or email…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ minWidth: 240 }}
          />
          <button className="btn btn--primary btn--sm" onClick={() => setShowCreate(true)}>
            New user
          </button>
        </div>
      </div>

      {error && <div className="alert alert--error" style={{ marginBottom: '.8rem' }}>{error}</div>}
      {notice && <div className="alert alert--ok" style={{ marginBottom: '.8rem' }}>{notice}</div>}

      <div className="alert alert--info" style={{ marginBottom: '.9rem' }}>
        <b>LIS access</b> controls whether these credentials also work on the legacy LIS. It can only be
        changed for Infinity-created accounts — Telo manages the same underlying flag for its own accounts,
        and native LIS users are managed in the LIS itself.
      </div>

      {loading ? (
        <div className="center"><div className="spinner" /><span className="muted">Loading users…</span></div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>User</th>
                <th>LIS type</th>
                <th>Managed by</th>
                <th>Infinity role</th>
                <th>Infinity login</th>
                <th>LIS access</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const isInfinity = r.managedBy === 'infinity';
                const busy = busyId === r.userId;
                const isSelf = r.userId === user?.userId;

                return (
                  <tr key={r.userId}>
                    <td>
                      <div><b>{r.username}</b>{isSelf && <span className="muted"> · you</span>}</div>
                      <div className="muted" style={{ fontSize: '.76rem' }}>
                        {[r.firstName, r.lastName].filter(Boolean).join(' ') || '—'}
                        {r.email ? ` · ${r.email}` : ''}
                      </div>
                    </td>

                    <td className="muted">{r.usertypeName ?? '—'}</td>

                    <td><span className={`badge badge--${r.managedBy}`}>{r.managedBy}</span></td>

                    <td>
                      <select
                        value={r.effectiveRole}
                        disabled={busy || isSelf}
                        onChange={(e) =>
                          act(r.userId, () => adminApi.setRole(r.userId, e.target.value), `Role updated for ${r.username}.`)
                        }
                        className="input"
                        style={{ padding: '.3rem .5rem', borderRadius: 8, fontSize: '.78rem' }}
                      >
                        {roles.map((role) => <option key={role} value={role}>{role}</option>)}
                      </select>
                      {!r.infinityRole && (
                        <div className="muted" style={{ fontSize: '.68rem', marginTop: '.15rem' }}>
                          derived from LIS type
                        </div>
                      )}
                    </td>

                    <td>
                      {isInfinity ? (
                        <button
                          className={`toggle ${r.infinityActive ? 'toggle--on' : ''}`}
                          disabled={busy || isSelf}
                          title={isSelf ? 'You cannot disable your own account' : 'Enable or disable Infinity sign-in'}
                          onClick={() =>
                            act(r.userId, () => adminApi.setActive(r.userId, !r.infinityActive),
                              `${r.username} ${r.infinityActive ? 'disabled' : 'enabled'} in Infinity.`)
                          }
                        />
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>

                    <td>
                      {isInfinity ? (
                        <div className="row">
                          <button
                            className={`toggle ${r.infinityLisAccess ? 'toggle--on' : ''}`}
                            disabled={busy}
                            title="Allow these credentials to sign in to the legacy LIS"
                            onClick={() =>
                              act(r.userId, () => adminApi.setLisAccess(r.userId, !r.infinityLisAccess),
                                `LIS access ${r.infinityLisAccess ? 'revoked from' : 'granted to'} ${r.username}.`)
                            }
                          />
                          <span className="muted" style={{ fontSize: '.72rem' }}>
                            {r.infinityLisAccess ? 'granted' : 'blocked'}
                          </span>
                        </div>
                      ) : (
                        <span className="muted" title="Managed outside Infinity">
                          {r.lisIsActive ? 'active in LIS' : 'inactive in LIS'}
                        </span>
                      )}
                    </td>

                    <td style={{ textAlign: 'right' }}>
                      {isInfinity && (
                        <button
                          className="btn btn--ghost btn--sm"
                          disabled={busy}
                          onClick={() => {
                            const pw = window.prompt(`New password for ${r.username}:`);
                            if (pw) void act(r.userId, () => adminApi.resetPassword(r.userId, pw), `Password reset for ${r.username}.`);
                          }}
                        >
                          Reset password
                        </button>
                      )}
                      {busy && <span className="spinner" style={{ display: 'inline-block', marginLeft: '.5rem', verticalAlign: 'middle' }} />}
                    </td>
                  </tr>
                );
              })}

              {rows.length === 0 && (
                <tr><td colSpan={7} className="muted" style={{ textAlign: 'center', padding: '2rem' }}>No users match that search.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {showCreate && (
        <CreateUserModal
          roles={roles}
          onClose={() => setShowCreate(false)}
          onCreated={(name) => {
            setShowCreate(false);
            setNotice(`Created ${name}. They can sign in to Infinity now; LIS access stays blocked until you grant it.`);
            void load(search);
          }}
        />
      )}
    </div>
  );
}
