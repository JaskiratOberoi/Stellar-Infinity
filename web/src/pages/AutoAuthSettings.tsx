import { useCallback, useEffect, useState } from 'react';
import { Pager } from '../components/Pager';
import { autoAuthApi, type AutoAuthAuditRow, type AutoAuthScopeRow } from '../api/client';
import { fmtDateTime } from '../lib/format';
import { InfinityLoader } from '../components/InfinityLoader';

/**
 * Auto-authorisation settings.
 *
 * Turning this on for a test means results within the reference range are signed
 * out by the system, without a person reading them. That is a genuine clinical
 * decision, so the screen is built to make it deliberate rather than easy:
 *
 *   - Everything is OFF until switched on, per test or per department.
 *   - Each change requires the unlock password in addition to the
 *     autoauth:manage capability.
 *   - The password lives in React state only. It is never written to
 *     localStorage or sessionStorage, so closing the tab discards it — unlike
 *     the legacy LIS, which writes the user's password into a plaintext cookie
 *     with a 15-day expiry and reflects it back into the login form.
 *   - Every change, and every rejected password attempt, is recorded.
 */
export function AutoAuthSettings() {
  const [rows, setRows] = useState<AutoAuthScopeRow[]>([]);
  const [audit, setAudit] = useState<AutoAuthAuditRow[]>([]);
  const [search, setSearch] = useState('');
  const [onlyEnabled, setOnlyEnabled] = useState(false);
  const [featureEnabled, setFeatureEnabled] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [showAudit, setShowAudit] = useState(false);

  // Held in memory for the session so an admin enabling six tests types it once.
  // Never persisted.
  const [password, setPassword] = useState('');
  const [unlocked, setUnlocked] = useState(false);

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(100);
  const [total, setTotal] = useState(0);

  const [auditPage, setAuditPage] = useState(1);
  const [auditTotal, setAuditTotal] = useState(0);
  const auditPageSize = 100;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await autoAuthApi.list(search, onlyEnabled, page, pageSize);
      setRows(r.rows);
      setTotal(r.total);
      setFeatureEnabled(r.featureEnabled);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the settings.');
    } finally {
      setLoading(false);
    }
  }, [search, onlyEnabled, page, pageSize]);

  useEffect(() => {
    const id = setTimeout(() => void load(), 300);
    return () => clearTimeout(id);
  }, [load]);

  // Narrowing the catalogue changes how many pages there are; page 7 of the old
  // result would render blank against the new one.
  useEffect(() => { setPage(1); }, [search, onlyEnabled, pageSize]);

  const loadAudit = useCallback(async (p: number) => {
    try {
      const r = await autoAuthApi.audit(p, auditPageSize);
      setAudit(r.rows);
      setAuditTotal(r.total);
      setShowAudit(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the change log.');
    }
  }, []);

  useEffect(() => {
    if (showAudit) void loadAudit(auditPage);
  }, [showAudit, auditPage, loadAudit]);

  const toggle = async (row: AutoAuthScopeRow, enabled: boolean) => {
    if (!password) {
      setError('Enter the auto-authorisation password before changing a rule.');
      return;
    }

    const key = `${row.scopeType}:${row.scopeKey}`;
    setBusyKey(key);
    setError(null);
    setNotice(null);

    try {
      await autoAuthApi.set({
        scopeType: row.scopeType,
        scopeKey: row.scopeKey,
        scopeLabel: row.label,
        enabled,
        requireInRange: true,
        allowOutOfRange: false,
        password,
      });

      setUnlocked(true);
      setNotice(
        enabled
          ? `Auto-authorisation is ON for ${row.label ?? row.scopeKey}. In-range results will be signed without review.`
          : `Auto-authorisation is OFF for ${row.label ?? row.scopeKey}.`,
      );
      await load();
    } catch (e) {
      const message = e instanceof Error ? e.message : 'The change was rejected.';
      // A wrong password invalidates the cached one, so the next attempt
      // prompts rather than silently burning another rate-limited try.
      if (message.toLowerCase().includes('password')) {
        setUnlocked(false);
        setPassword('');
      }
      setError(message);
    } finally {
      setBusyKey(null);
    }
  };

  // Rules active ON THIS PAGE. Said that way deliberately: with the catalogue
  // paged, a count taken from the rows in hand is not the count for the whole
  // catalogue, and claiming otherwise would be the same class of error this
  // change exists to remove. Tick "Only enabled" for the true figure.
  const enabledHere = rows.filter((r) => r.enabled).length;

  return (
    <div className="page">
      <div className="page__head">
        <div>
          <h1 className="page__title">Auto-authorisation</h1>
          <p className="page__sub">
            {onlyEnabled
              ? `${total.toLocaleString()} rule${total === 1 ? '' : 's'} active`
              : enabledHere > 0
                ? `${enabledHere} active on this page · ${total.toLocaleString()} entries in the catalogue`
                : `${total.toLocaleString()} entries · none enabled on this page`}
          </p>
        </div>
        <div className="row" style={{ marginLeft: 'auto' }}>
          <button className="btn btn--ghost btn--sm"
                  onClick={() => { setAuditPage(1); setShowAudit(true); }}>Change log</button>
        </div>
      </div>

      {!featureEnabled && (
        <div className="alert alert--error" style={{ marginBottom: '.9rem' }}>
          Auto-authorisation is disabled for this deployment. No rule can be switched on until it is enabled in the
          API configuration.
        </div>
      )}

      <div className="alert alert--info" style={{ marginBottom: '.9rem' }}>
        <p style={{ marginBottom: '.4rem' }}>
          <b>What this does.</b> When a rule is on, a numeric result inside this patient's reference range is
          authorised by the system at the moment it is saved — no one reads it first. Out-of-range values, narrative
          results and coded results are never auto-authorised.
        </p>
        <p style={{ margin: 0 }}>
          Every automatic authorisation is recorded separately from a human one, so the results released without
          review can always be listed.
        </p>
      </div>

      {/* ---- the unlock ---- */}
      <div className="card" style={{ marginBottom: '1rem' }}>
        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor="autoauth-password">
            Auto-authorisation password
            {unlocked && <span className="badge badge--infinity" style={{ marginLeft: '.5rem' }}>verified</span>}
          </label>
          <input
            id="autoauth-password"
            className="input"
            type="password"
            autoComplete="off"
            placeholder="Required for every change"
            value={password}
            onChange={(e) => { setPassword(e.target.value); setUnlocked(false); }}
            style={{ maxWidth: 320 }}
          />
          <span className="muted" style={{ fontSize: '.72rem' }}>
            Kept in this tab only, never saved. Five wrong attempts in fifteen minutes locks the setting out.
          </span>
        </div>
      </div>

      <div className="row" style={{ marginBottom: '.8rem', flexWrap: 'wrap' }}>
        <input className="input" placeholder="Search tests or departments…" value={search}
               onChange={(e) => setSearch(e.target.value)} style={{ minWidth: 260 }} />
        <label className="row" style={{ gap: '.4rem', fontSize: '.8rem', cursor: 'pointer' }}>
          <input type="checkbox" checked={onlyEnabled} onChange={(e) => setOnlyEnabled(e.target.checked)} />
          Only rules that are on
        </label>
      </div>

      {error && <div className="alert alert--error" style={{ marginBottom: '.9rem' }}>{error}</div>}
      {notice && <div className="alert alert--ok" style={{ marginBottom: '.9rem' }}>{notice}</div>}

      {loading ? (
        <div className="center"><InfinityLoader /><span className="muted">Loading…</span></div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th style={{ width: 90 }}>Scope</th>
                <th>Name</th>
                <th style={{ width: 110 }}>Code</th>
                <th>Department</th>
                <th style={{ width: 170 }}>Last changed</th>
                <th style={{ width: 120, textAlign: 'right' }}>Auto-authorise</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const key = `${r.scopeType}:${r.scopeKey}`;
                return (
                  <tr key={key} className={r.enabled ? 'worksheet-grid__touched' : undefined}>
                    <td>
                      <span className={`badge badge--${r.scopeType === 'department' ? 'telo' : 'lis'}`}>
                        {r.scopeType}
                      </span>
                    </td>
                    <td>{r.label ?? '—'}</td>
                    <td className="mono muted" style={{ fontSize: '.76rem' }}>{r.scopeKey}</td>
                    <td className="muted" style={{ fontSize: '.78rem' }}>{r.departmentName ?? '—'}</td>
                    <td className="muted" style={{ fontSize: '.74rem' }}>
                      {r.updatedAt ? (
                        <>
                          {fmtDateTime(r.updatedAt)}
                          <div style={{ fontSize: '.68rem' }}>{r.updatedByUsername ?? ''}</div>
                        </>
                      ) : '—'}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <button
                        className={`btn btn--sm ${r.enabled ? 'btn--danger' : 'btn--ghost'}`}
                        disabled={!featureEnabled || busyKey === key || !password}
                        title={!password ? 'Enter the password above first' : undefined}
                        onClick={() => void toggle(r, !r.enabled)}
                      >
                        {busyKey === key ? '…' : r.enabled ? 'On — turn off' : 'Off — turn on'}
                      </button>
                    </td>
                  </tr>
                );
              })}

              {rows.length === 0 && (
                <tr>
                  <td colSpan={6} className="muted" style={{ textAlign: 'center', padding: '2rem' }}>
                    {onlyEnabled ? 'No rules are switched on.' : 'Nothing matched that search.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>

          <Pager page={page} pageSize={pageSize} total={total} noun="entry" nounPlural="entries"
                 sizes={[50, 100, 250, 500]} onPage={setPage} onPageSize={setPageSize} />
        </div>
      )}

      {showAudit && (
        <div className="modal-backdrop" onClick={() => setShowAudit(false)}>
          <div className="modal modal--wide" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
            <h2 className="modal__title">Auto-authorisation change log</h2>
            <p className="muted" style={{ fontSize: '.78rem' }}>
              Append-only, and includes rejected password attempts.
            </p>
            <div className="table-wrap" style={{ maxHeight: '58vh', overflowY: 'auto' }}>
              <table>
                <thead>
                  <tr>
                    <th style={{ width: 160 }}>When</th>
                    <th style={{ width: 120 }}>Who</th>
                    <th style={{ width: 130 }}>Action</th>
                    <th>Scope</th>
                    <th>Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {audit.map((a) => (
                    <tr key={a.id}>
                      <td className="muted" style={{ fontSize: '.74rem' }}>{fmtDateTime(a.occurredAt)}</td>
                      <td style={{ fontSize: '.78rem' }}>{a.actorUsername ?? '—'}</td>
                      <td>
                        <span
                          className={`badge badge--${a.action === 'enable' ? 'telo' : 'lis'}`}
                          style={a.action === 'unlock_failed'
                            ? { color: 'var(--danger)', borderColor: 'var(--danger-line)', background: 'var(--danger-soft)' }
                            : undefined}
                        >
                          {a.action.replace(/_/g, ' ')}
                        </span>
                      </td>
                      <td style={{ fontSize: '.78rem' }}>
                        {a.scopeLabel ?? a.scopeKey ?? '—'}
                        <div className="muted mono" style={{ fontSize: '.68rem' }}>{a.scopeType}</div>
                      </td>
                      <td className="muted" style={{ fontSize: '.74rem' }}>{a.detail ?? '—'}</td>
                    </tr>
                  ))}
                  {audit.length === 0 && (
                    <tr>
                      <td colSpan={5} className="muted" style={{ textAlign: 'center', padding: '2rem' }}>
                        Nothing recorded yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <Pager page={auditPage} pageSize={auditPageSize} total={auditTotal}
                   noun="entry" nounPlural="entries" onPage={setAuditPage} />

            <div className="modal__actions">
              <button className="btn btn--ghost" onClick={() => setShowAudit(false)}>Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
