import { useCallback, useEffect, useState } from 'react';
import { adminApi, ApiError, type AdminUserRow } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { CreateUserModal } from './CreateUserModal';
import { UserSettings } from './UserSettings';
import { Pager } from '../components/Pager';
import { InfinityLoader } from '../components/InfinityLoader';

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
  const [settingsFor, setSettingsFor] = useState<number | null>(null);
  const [roles, setRoles] = useState<string[]>([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);

  const load = useCallback(async (q: string, p: number, size: number) => {
    setLoading(true);
    setError(null);
    try {
      const result = await adminApi.listUsers(q, p, size);
      setRows(result.users);
      setTotal(result.totalCount);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load users.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    adminApi.roles().then((r) => setRoles(r.map((x) => x.role))).catch(() => setRoles([]));
  }, []);

  // Debounced search — the SQL uses a leading wildcard and cannot use an index,
  // so we avoid firing one scan per keystroke.
  useEffect(() => {
    const t = setTimeout(() => void load(search, page, pageSize), 300);
    return () => clearTimeout(t);
  }, [search, page, pageSize, load]);

  // A narrower search has fewer pages; staying on page 6 of the old result
  // would show an empty screen for a search that matched plenty.
  useEffect(() => { setPage(1); }, [search, pageSize]);

  async function act(userId: number, fn: () => Promise<void>, successMessage: string) {
    setBusyId(userId);
    setError(null);
    setNotice(null);
    try {
      await fn();
      setNotice(successMessage);
      await load(search, page, pageSize);
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
        <div className="center"><InfinityLoader /><span className="muted">Loading users…</span></div>
      ) : (
        <div className="table-wrap table-wrap--cards">
          <table>
            <thead>
              <tr>
                <th>User</th>
                <th>LIS type</th>
                <th>Managed by</th>
                <th>Infinity role</th>
                <th>Infinity login</th>
                <th>LIS access</th>
                <th title="Walk-in ordering, for a client account that also takes its own patients">Walk-in</th>
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
                    <td className="cell--lead">
                      <div><b>{r.username}</b>{isSelf && <span className="muted"> · you</span>}</div>
                      <div className="muted" style={{ fontSize: '.76rem' }}>
                        {[r.firstName, r.lastName].filter(Boolean).join(' ') || '—'}
                        {r.email ? ` · ${r.email}` : ''}
                      </div>
                    </td>

                    <td className="muted cell--meta" data-label="LIS type">{r.usertypeName ?? '—'}</td>

                    <td className="cell--tag"><span className={`badge badge--${r.managedBy}`}>{r.managedBy}</span></td>

                    {/* A dropdown is a control, not a value: it gets its label
                        above it and the full width of the card, like a field in
                        a form, rather than being squeezed to the right. */}
                    <td className="cell--body" data-label="Infinity role">
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

                    <td className="cell--meta" data-label="Infinity login">
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

                    {/* Walk-in ordering.

                        Only meaningful for a CLIENT: every other role already
                        holds order:b2c from its role, so a toggle there would
                        promise a change it cannot make. Shown as a dash for
                        them rather than an inert switch. */}
                    <td className="cell--meta" data-label="Walk-in">
                      {r.effectiveRole === 'client' ? (
                        <div className="row">
                          <button
                            className={`toggle ${r.walkInGranted ? 'toggle--on' : ''}`}
                            disabled={busy}
                            title="Allow this centre to raise walk-in orders priced at its own rate. Off by default: client orders are billed to the account and settled later."
                            onClick={() =>
                              act(r.userId, async () => { await adminApi.setWalkIn(r.userId, !r.walkInGranted); },
                                `Walk-in ordering ${r.walkInGranted ? 'removed from' : 'enabled for'} ${r.username}. They must sign in again.`)
                            }
                          />
                          <span className="muted" style={{ fontSize: '.72rem' }}>
                            {r.walkInGranted ? 'allowed' : 'B2B only'}
                          </span>
                        </div>
                      ) : (
                        <span className="muted" title="Walk-in is part of this role already">—</span>
                      )}
                    </td>

                    <td className="cell--meta" data-label="LIS access">
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

                    <td className="cell--action">
                      {/* Settings is available for EVERY account, including
                          native LIS ones — client-code access and role are
                          Infinity's to manage even when sign-in is not. */}
                      <button className="btn btn--primary btn--sm" disabled={busy}
                              onClick={() => setSettingsFor(r.userId)}>
                        Settings
                      </button>
                      {busy && <span style={{ display: 'inline-block', marginLeft: '.5rem', verticalAlign: 'middle' }}><InfinityLoader size={30} /></span>}
                    </td>
                  </tr>
                );
              })}

              {rows.length === 0 && (
                <tr><td colSpan={7} className="muted" style={{ textAlign: 'center', padding: '2rem' }}>No users match that search.</td></tr>
              )}
            </tbody>
          </table>

          <Pager page={page} pageSize={pageSize} total={total} noun="account"
                 sizes={[25, 50, 100, 250, 500]}
                 onPage={setPage} onPageSize={setPageSize} />
        </div>
      )}

      {settingsFor !== null && (
        <UserSettings
          userId={settingsFor}
          roles={roles}
          onClose={() => setSettingsFor(null)}
          onChanged={() => void load(search, page, pageSize)}
        />
      )}

      {showCreate && (
        <CreateUserModal
          roles={roles}
          onClose={() => setShowCreate(false)}
          onCreated={(name) => {
            setShowCreate(false);
            setNotice(`Created ${name}. They can sign in to Infinity now; LIS access stays blocked until you grant it.`);
            void load(search, page, pageSize);
          }}
        />
      )}
    </div>
  );
}
