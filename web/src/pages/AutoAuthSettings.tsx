import { useCallback, useEffect, useState } from 'react';
import { Pager } from '../components/Pager';
import { autoAuthApi, type AutoAuthAuditRow, type AutoAuthScopeRow, type BusinessUnit } from '../api/client';
import { fmtDateTime, plainText } from '../lib/format';
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
  // Never persisted — closing the tab discards it.
  const [password, setPassword] = useState('');
  const [unlocked, setUnlocked] = useState(false);

  // The gate. Nothing about which tests release results unread is fetched or
  // rendered until the password has been verified, so reaching the URL is not
  // enough to see the configuration.
  const [gatePassword, setGatePassword] = useState('');
  const [gateBusy, setGateBusy] = useState(false);
  const [gateError, setGateError] = useState<string | null>(null);
  // Until the server has answered, show neither the gate nor the rules —
  // flashing the password prompt at someone who is already unlocked is as
  // wrong as flashing the rules at someone who is not.
  const [gateChecked, setGateChecked] = useState(false);

  // Which lab's rules are being configured. null is the blanket "all units"
  // rule — a real, distinct setting rather than "no filter".
  const [units, setUnits] = useState<BusinessUnit[]>([]);
  const [unitId, setUnitId] = useState<number | null>(null);

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(100);
  const [total, setTotal] = useState(0);

  const [auditPage, setAuditPage] = useState(1);
  const [auditTotal, setAuditTotal] = useState(0);
  const auditPageSize = 100;

  // The unlock is remembered SERVER-side for this session, so a refresh does
  // not re-prompt. The browser holds no secret — only the answer to "is this
  // session through the gate", which it cannot forge.
  useEffect(() => {
    let live = true;
    autoAuthApi.unlockStatus()
      .then(async (r) => {
        if (!live) return;
        if (r.unlocked) {
          setUnlocked(true);
          const u = await autoAuthApi.businessUnits().catch(() => ({ units: [] }));
          if (live) setUnits(u.units);
        }
      })
      .catch(() => { /* treat any failure as locked */ })
      .finally(() => { if (live) setGateChecked(true); });
    return () => { live = false; };
  }, []);

  const load = useCallback(async () => {
    if (!unlocked) return;          // the gate has not been passed
    setLoading(true);
    setError(null);
    try {
      const r = await autoAuthApi.list(search, onlyEnabled, unitId, page, pageSize);
      setRows(r.rows);
      setTotal(r.total);
      setFeatureEnabled(r.featureEnabled);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the settings.');
    } finally {
      setLoading(false);
    }
  }, [search, onlyEnabled, unitId, page, pageSize, unlocked]);

  useEffect(() => {
    const id = setTimeout(() => void load(), 300);
    return () => clearTimeout(id);
  }, [load]);

  // Narrowing the catalogue changes how many pages there are; page 7 of the old
  // result would render blank against the new one.
  useEffect(() => { setPage(1); }, [search, onlyEnabled, unitId, pageSize]);

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
    const key = `${row.scopeType}:${row.scopeKey}`;
    setBusyKey(key);
    setError(null);
    setNotice(null);

    try {
      await autoAuthApi.set({
        scopeType: row.scopeType,
        scopeKey: row.scopeKey,
        scopeLabel: row.label,
        businessUnitId: unitId,
        enabled,
        requireInRange: true,
        allowOutOfRange: false,
        // The server accepts the session's unlock grant; the password is only
        // sent when this tab still happens to hold it (same visit as the gate).
        password,
      });

      setUnlocked(true);
      const where = unitId == null
        ? 'every business unit'
        : units.find((u) => u.id === unitId)?.name ?? `unit ${unitId}`;
      setNotice(
        enabled
          ? `Jarvis is ON for ${row.label ?? row.scopeKey} at ${where}. In-range results will be signed without review.`
          : `Jarvis is OFF for ${row.label ?? row.scopeKey} at ${where}.`,
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

  /**
   * Pass the gate. The password is verified SERVER-side against the PBKDF2
   * hash — there is no client-side comparison to bypass — and only then is the
   * catalogue fetched. A rejected attempt is recorded in the change log
   * exactly as a rejected toggle is.
   */
  const unlock = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!gatePassword) return;
    setGateBusy(true);
    setGateError(null);
    try {
      await autoAuthApi.unlock(gatePassword);
      // Carried into the page so an admin toggling six tests types it once.
      setPassword(gatePassword);
      setUnlocked(true);
      setGatePassword('');
      const u = await autoAuthApi.businessUnits();
      setUnits(u.units);
    } catch (err) {
      setGateError(err instanceof Error ? err.message : 'That password was not accepted.');
    } finally {
      setGateBusy(false);
    }
  };

  // ---- the gate ----------------------------------------------------------
  if (!gateChecked) {
    return (
      <div className="page">
        <div className="center"><InfinityLoader /><span className="muted">Checking Jarvis…</span></div>
      </div>
    );
  }

  if (!unlocked) {
    return (
      <div className="page">
        <div className="jarvis-gate">
          <form className="jarvis-gate__card" onSubmit={unlock}>
            <div className="jarvis-gate__mark"><InfinityLoader size={150} label="Jarvis" /></div>
            <h1 className="jarvis-gate__title">Jarvis</h1>
            <p className="jarvis-gate__sub">
              Automatic authorisation. This screen decides which results reach a patient
              without a person reading them, so it is locked separately from your sign-in.
            </p>

            {gateError && <div className="alert alert--error login__error">{gateError}</div>}

            <div className="field">
              <label htmlFor="jarvis-pw">Auto-authorisation password</label>
              <input
                id="jarvis-pw"
                className="input"
                type="password"
                autoComplete="off"
                autoFocus
                placeholder="Required to view or change any rule"
                value={gatePassword}
                onChange={(e) => setGatePassword(e.target.value)}
              />
            </div>

            <button className="btn btn--primary login__submit" type="submit" disabled={gateBusy || !gatePassword}>
              {gateBusy && <InfinityLoader size={30} mono label="Checking" />}
              {gateBusy ? 'Checking…' : 'Unlock'}
            </button>

            <p className="jarvis-gate__foot">
              Five wrong attempts in fifteen minutes locks this out. Every attempt, accepted or
              not, is recorded against your name.
            </p>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page__head">
        <div>
          <h1 className="page__title">Jarvis <span className="muted" style={{ fontWeight: 300 }}>· auto-authorisation</span></h1>
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

      {/* ---- which lab these rules govern ---- */}
      <div className="card" style={{ marginBottom: '1rem' }}>
        <div className="row" style={{ gap: '1rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div className="field" style={{ marginBottom: 0, minWidth: 260 }}>
            <label htmlFor="jarvis-unit">Business unit</label>
            <select
              id="jarvis-unit"
              className="input"
              value={unitId ?? ''}
              onChange={(e) => setUnitId(e.target.value === '' ? null : Number(e.target.value))}
            >
              <option value="">All business units (blanket rule)</option>
              {units.map((u) => (
                <option key={u.id} value={u.id}>{u.name ?? u.code ?? `Unit ${u.id}`}</option>
              ))}
            </select>
          </div>
          <p className="muted" style={{ fontSize: '.74rem', maxWidth: 460, lineHeight: 1.6 }}>
            {unitId == null
              ? 'Rules set here apply everywhere, unless a specific unit has its own rule for that test.'
              : 'A rule set for this unit overrides the blanket rule — so a test can be automatic here and manual elsewhere.'}
          </p>
          <span className="badge badge--infinity" style={{ marginLeft: 'auto' }}>unlocked</span>
        </div>
      </div>

      <div className="row" style={{ marginBottom: '.8rem', flexWrap: 'wrap' }}>
        <input className="input" placeholder="Search tests…" value={search}
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
        <div className="table-wrap table-wrap--cards">
          <table>
            <thead>
              <tr>
                <th>Test</th>
                <th style={{ width: 110 }}>Code</th>
                <th style={{ width: 180 }}>Department</th>
                <th style={{ width: 160 }}>Applies to</th>
                <th style={{ width: 170 }}>Last changed</th>
                <th style={{ width: 110, textAlign: 'right' }}>Jarvis</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const key = `${r.scopeType}:${r.scopeKey}`;
                return (
                  <tr key={key} className={r.enabled ? 'worksheet-grid__touched' : undefined}>
                    <td className="cell--lead">{plainText(r.label) || '—'}</td>
                    <td className="mono muted cell--meta" data-label="Code" style={{ fontSize: '.76rem' }}>{r.scopeKey}</td>
                    <td className="muted cell--meta" data-label="Department" style={{ fontSize: '.78rem' }}>{r.departmentName ?? '—'}</td>
                    <td className="muted cell--meta" data-label="Applies to" style={{ fontSize: '.76rem' }}>
                      {r.businessUnitName ?? (unitId == null ? 'All units' : '—')}
                    </td>
                    <td className="muted cell--meta" data-label="Last changed" style={{ fontSize: '.74rem' }}>
                      {r.updatedAt ? (
                        <>
                          {fmtDateTime(r.updatedAt)}
                          <div style={{ fontSize: '.68rem' }}>{r.updatedByUsername ?? ''}</div>
                        </>
                      ) : '—'}
                    </td>
                    {/* The switch is the point of the row, so it stays on the
                        headline beside the test name rather than sinking to the
                        bottom of the card. */}
                    <td className="cell--tag">
                      <button
                        type="button"
                        role="switch"
                        aria-checked={r.enabled}
                        aria-label={`Auto-authorise ${plainText(r.label) || r.scopeKey}`}
                        className={`toggle${r.enabled ? ' toggle--on' : ''}`}
                        disabled={!featureEnabled || busyKey === key}
                        title={r.enabled
                          ? 'On — in-range results are signed without review'
                          : 'Off — every result waits for a person'}
                        onClick={() => void toggle(r, !r.enabled)}
                      />
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
            <div className="table-wrap table-wrap--cards" style={{ maxHeight: '58vh', overflowY: 'auto' }}>
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
                      <td className="muted cell--meta" data-label="When" style={{ fontSize: '.74rem' }}>{fmtDateTime(a.occurredAt)}</td>
                      <td className="cell--meta" data-label="Who" style={{ fontSize: '.78rem' }}>{a.actorUsername ?? '—'}</td>
                      <td className="cell--tag">
                        <span
                          className={`badge badge--${a.action === 'enable' ? 'telo' : 'lis'}`}
                          style={a.action === 'unlock_failed'
                            ? { color: 'var(--danger)', borderColor: 'var(--danger-line)', background: 'var(--danger-soft)' }
                            : undefined}
                        >
                          {a.action.replace(/_/g, ' ')}
                        </span>
                      </td>
                      <td className="cell--lead" style={{ fontSize: '.78rem' }}>
                        {plainText(a.scopeLabel) || a.scopeKey || '—'}
                        <div className="muted mono" style={{ fontSize: '.68rem' }}>{a.scopeType}</div>
                      </td>
                      <td className="muted cell--body" data-label="Detail" style={{ fontSize: '.74rem' }}>{a.detail ?? '—'}</td>
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
