import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  interfacingApi, ApiError,
  type BusinessUnit, type InterfacingDailyRow, type InterfacingOverview,
  type ResultSourceRow, type SiteInstrument, type SiteOverview,
} from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { fmtDateTime } from '../lib/format';
import { InfinityLoader } from '../components/InfinityLoader';

/** Today on the IST calendar — the lab's day, not the browser's. See Dashboard. */
function todayIst() {
  return new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
}

function addDays(iso: string, days: number) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/** "2026-08-06" -> "6 Aug". Parsed as parts — new Date(iso) reads bare dates as UTC. */
function fmtDay(iso: string) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

const n = (v: number) => v.toLocaleString('en-IN');

/** Status → the badge palette the rest of the app already speaks. */
function statusBadge(status: string): string {
  switch (status) {
    case 'online': return 'badge--online';
    case 'listening': return 'badge--ok';
    case 'connecting': return 'badge--muted';
    case 'offline':
    case 'error': return 'badge--bad';
    default: return 'badge--muted';
  }
}

function alertLabel(kind: string): string {
  switch (kind) {
    case 'disconnected': return 'disconnected';
    case 'stuck-connecting': return 'stuck connecting';
    case 'stale': return 'not reporting';
    default: return kind;
  }
}

/** online + listening both mean "the connection is up and waiting or talking". */
const isUp = (i: SiteInstrument) => i.status === 'online' || i.status === 'listening';

export function Interfacing() {
  const { can } = useAuth();
  const [overview, setOverview] = useState<InterfacingOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  // Shared range for the two history cards. Default: the last 7 days.
  const [from, setFrom] = useState(() => addDays(todayIst(), -6));
  const [to, setTo] = useState(todayIst);

  const [daily, setDaily] = useState<InterfacingDailyRow[]>([]);
  const [dailyError, setDailyError] = useState<string | null>(null);
  const [dailyLoading, setDailyLoading] = useState(true);

  const [sources, setSources] = useState<ResultSourceRow[]>([]);
  const [sourcesError, setSourcesError] = useState<string | null>(null);
  const [sourcesLoading, setSourcesLoading] = useState(true);

  const [showRegister, setShowRegister] = useState(false);
  const [editSite, setEditSite] = useState<SiteOverview | null>(null);

  const loadOverview = useCallback(async (initial = false) => {
    if (initial) setLoading(true);
    try {
      setOverview(await interfacingApi.overview());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the interfacing overview.');
    } finally {
      if (initial) setLoading(false);
    }
  }, []);

  useEffect(() => { void loadOverview(true); }, [loadOverview]);

  // Live view: poll every 15s, but not while the tab is hidden — a background
  // dashboard should not keep a request stream open against the API.
  useEffect(() => {
    const t = window.setInterval(() => {
      if (document.hidden) return;
      void loadOverview();
    }, 15_000);
    return () => window.clearInterval(t);
  }, [loadOverview]);

  // When an alert appears BETWEEN polls, flash the tab title briefly so a
  // minimised or backgrounded tab has a chance of being noticed. The banner
  // below is the real surface; this is just the knock on the door.
  const seenAlerts = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!overview) return;
    const next = new Set(overview.alerts.map((a) => `${a.siteId}:${a.instrumentKey}:${a.kind}`));
    const prev = seenAlerts.current;
    seenAlerts.current = next;
    if (prev === null) return; // first load is not "new"
    if (![...next].some((k) => !prev.has(k))) return;

    const original = document.title;
    document.title = '⚠ Interfacing';
    const t = window.setTimeout(() => { document.title = original; }, 5_000);
    return () => { window.clearTimeout(t); document.title = original; };
  }, [overview]);

  // The two history cards follow the shared range, independently: the daily
  // table reads Infinity's own small tables, the sources table aggregates the
  // live LIS (cached server-side) — the fast one must not wait for the slow one.
  useEffect(() => {
    let live = true;
    setDailyLoading(true);
    setDailyError(null);
    interfacingApi.daily(from, to)
      .then((r) => { if (live) setDaily(r.rows); })
      .catch((e) => { if (live) setDailyError(e instanceof Error ? e.message : 'Could not load throughput.'); })
      .finally(() => { if (live) setDailyLoading(false); });
    return () => { live = false; };
  }, [from, to]);

  useEffect(() => {
    let live = true;
    setSourcesLoading(true);
    setSourcesError(null);
    interfacingApi.resultSources(from, to)
      .then((r) => { if (live) setSources(r.rows); })
      .catch((e) => { if (live) setSourcesError(e instanceof Error ? e.message : 'Could not load result sources.'); })
      .finally(() => { if (live) setSourcesLoading(false); });
    return () => { live = false; };
  }, [from, to]);

  // Per-lab per-day fold of the instrument-grain rows the API returns.
  const dailyBySite = useMemo(() => {
    const map = new Map<string, { code: string; name: string; day: string; samples: number; results: number; errors: number }>();
    for (const r of daily) {
      const key = `${r.day}|${r.siteId}`;
      const hit = map.get(key);
      if (hit) {
        hit.samples += r.samples;
        hit.results += r.results;
        hit.errors += r.errors;
      } else {
        map.set(key, { code: r.code, name: r.name, day: r.day, samples: r.samples, results: r.results, errors: r.errors });
      }
    }
    return [...map.values()].sort((a, b) => b.day.localeCompare(a.day) || a.code.localeCompare(b.code));
  }, [daily]);

  // Per-lab per-day: interfaced vs manual, with the per-machine split kept for
  // the breakdown line under each row.
  const sourcesByDay = useMemo(() => {
    const map = new Map<string, {
      day: string; lab: string; manual: number; interfaced: number;
      machines: { name: string; count: number }[];
    }>();
    for (const r of sources) {
      const lab = r.businessUnitName ?? r.businessUnitCode ?? 'Unassigned';
      const key = `${r.day}|${r.businessUnitId ?? 'none'}`;
      let hit = map.get(key);
      if (!hit) {
        hit = { day: r.day, lab, manual: 0, interfaced: 0, machines: [] };
        map.set(key, hit);
      }
      if (r.entryMode === 'interfaced') {
        hit.interfaced += r.resultCount;
        hit.machines.push({ name: r.machineName ?? '?', count: r.resultCount });
      } else {
        hit.manual += r.resultCount;
      }
    }
    for (const row of map.values()) row.machines.sort((a, b) => b.count - a.count);
    return [...map.values()].sort((a, b) => b.day.localeCompare(a.day) || a.lab.localeCompare(b.lab));
  }, [sources]);

  const toggle = (id: number) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const sites = overview?.sites ?? [];
  const alerts = overview?.alerts ?? [];
  const expandedSites = sites.filter((s) => expanded.has(s.id));

  return (
    <div className="page">
      <div className="page__head">
        <div>
          <h1 className="page__title">Interfacing</h1>
          <p className="page__sub">
            Remote labs running the Stellar Synapse middleware — connection status, throughput,
            and how their results are entered
          </p>
        </div>
        {can('user:manage') && (
          <div className="row" style={{ marginLeft: 'auto' }}>
            <button className="btn btn--primary btn--sm" onClick={() => setShowRegister(true)}>
              Register lab site
            </button>
          </div>
        )}
      </div>

      {error && <div className="alert alert--error" style={{ marginBottom: '.8rem' }}>{error}</div>}

      {/* ---- alert strip ------------------------------------------------- */}
      {alerts.length > 0 && (
        <div
          className={`alert ${alerts.some((a) => a.kind !== 'stale') ? 'alert--error' : 'alert--warn'}`}
          style={{ marginBottom: '.8rem' }}
        >
          <b>{alerts.length} instrument{alerts.length === 1 ? '' : 's'} need attention</b>
          <ul style={{ margin: '.35rem 0 0', paddingLeft: '1.1rem', lineHeight: 1.7 }}>
            {alerts.map((a) => (
              <li key={`${a.siteId}:${a.instrumentKey}:${a.kind}`}>
                <b>{a.instrumentName ?? a.instrumentKey}</b> at <b>{a.siteName}</b>: {alertLabel(a.kind)}
                {a.since ? <span className="muted"> since {fmtDateTime(a.since)}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ---- site cards --------------------------------------------------- */}
      {loading ? (
        <div className="center"><InfinityLoader /><span className="muted">Loading sites…</span></div>
      ) : (
        <div className="grid2" style={{ marginBottom: '1.1rem' }}>
          {sites.map((s) => {
            const up = s.instruments.filter(isUp).length;
            const todaySamples = s.instruments.reduce((sum, i) => sum + i.todaySamples, 0);
            const todayResults = s.instruments.reduce((sum, i) => sum + i.todayResults, 0);
            return (
              <div key={s.id} className="card" style={{ padding: '.8rem 1rem' }}>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <div>
                    <b style={{ fontSize: '.9rem' }}>{s.name}</b>{' '}
                    <span className="mono muted" style={{ fontSize: '.74rem' }}>{s.code}</span>
                    <div className="muted" style={{ fontSize: '.74rem' }}>
                      {s.location ?? s.labLocation ?? '—'}
                      {s.businessUnitName ? ` · ${s.businessUnitName}` : ''}
                    </div>
                  </div>
                  <span className={`badge ${!s.isActive ? 'badge--muted' : s.online ? 'badge--online' : 'badge--bad'}`}>
                    {!s.isActive ? 'disabled' : s.online ? 'online' : 'offline'}
                  </span>
                </div>
                <div className="row" style={{ gap: '.9rem', marginTop: '.5rem', fontSize: '.74rem', flexWrap: 'wrap' }}>
                  <span className={up < s.instruments.length ? '' : 'muted'}
                        style={up < s.instruments.length ? { color: 'var(--warn)' } : undefined}>
                    <b>{up}/{s.instruments.length}</b> instruments up
                  </span>
                  <span className="muted">today <b>{n(todaySamples)}</b> samples · <b>{n(todayResults)}</b> results</span>
                </div>
                <div className="row" style={{ gap: '.9rem', marginTop: '.35rem', fontSize: '.72rem' }}>
                  <span className="muted">agent {s.agentVersion ?? '—'}</span>
                  <span className="muted" style={{ marginLeft: 'auto' }}>
                    {s.lastSeenAt ? `seen ${fmtDateTime(s.lastSeenAt)}` : 'never seen'}
                  </span>
                </div>
                <div className="row" style={{ marginTop: '.55rem' }}>
                  <button className="btn btn--ghost btn--sm" onClick={() => toggle(s.id)}>
                    {expanded.has(s.id) ? 'Hide instruments' : 'Show instruments'}
                  </button>
                  {can('user:manage') && (
                    <button className="btn btn--ghost btn--sm" onClick={() => setEditSite(s)}>Edit</button>
                  )}
                </div>
              </div>
            );
          })}
          {sites.length === 0 && (
            <div className="card">
              <p className="muted" style={{ fontSize: '.84rem', lineHeight: 1.6 }}>
                No lab sites registered yet. Register one to get an API key, then configure its
                Synapse agent with <code>X-Site-Code</code> / <code>X-Site-Key</code> pointed at{' '}
                <code>POST /api/interfacing/report</code>.
              </p>
            </div>
          )}
        </div>
      )}

      {/* ---- expanded instrument tables ----------------------------------- */}
      {expandedSites.map((s) => (
        <div key={s.id} className="card" style={{ marginBottom: '1.1rem', padding: '.8rem 1rem' }}>
          <div className="row" style={{ marginBottom: '.5rem' }}>
            <b style={{ fontSize: '.86rem' }}>{s.name}</b>
            <span className="mono muted" style={{ fontSize: '.74rem' }}>{s.code}</span>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Instrument</th>
                  <th>Driver</th>
                  <th>Transport</th>
                  <th>Last message</th>
                  <th>Today</th>
                  <th>Totals</th>
                  <th>Alert</th>
                </tr>
              </thead>
              <tbody>
                {s.instruments.map((i) => (
                  <tr key={i.key}>
                    <td>
                      <span className={`badge ${i.enabled ? statusBadge(i.status) : 'badge--muted'}`}>
                        {i.enabled ? i.status : 'off'}
                      </span>
                    </td>
                    <td>
                      {i.name ?? <span className="muted">—</span>}
                      <div className="mono muted" style={{ fontSize: '.7rem' }}>{i.key}</div>
                    </td>
                    <td className="muted" style={{ fontSize: '.76rem' }}>{i.driverId ?? '—'}</td>
                    <td className="muted" style={{ fontSize: '.76rem' }}>
                      {i.transport ?? '—'}
                      {i.address ? <span className="mono"> {i.address}</span> : null}
                    </td>
                    <td className="muted" style={{ fontSize: '.76rem', whiteSpace: 'nowrap' }}>
                      {i.lastMessageAt ? fmtDateTime(i.lastMessageAt) : '—'}
                    </td>
                    <td style={{ fontSize: '.78rem', whiteSpace: 'nowrap' }}>
                      <b>{n(i.todaySamples)}</b> <span className="muted">smp</span>{' '}
                      <b>{n(i.todayResults)}</b> <span className="muted">res</span>
                      {i.todayErrors > 0 && <span style={{ color: 'var(--danger)' }}> {n(i.todayErrors)} err</span>}
                    </td>
                    <td className="muted" style={{ fontSize: '.72rem', whiteSpace: 'nowrap' }}>
                      {n(i.messagesReceived)} msg · {n(i.resultsProcessed)} res · {n(i.resultParamsProcessed)} par
                      {i.errors > 0 && <span style={{ color: 'var(--danger)' }}> · {n(i.errors)} err</span>}
                    </td>
                    <td>
                      {i.alert ? (
                        <span className={`badge ${i.alert.kind === 'stale' ? 'badge--muted' : 'badge--bad'}`}>
                          {alertLabel(i.alert.kind)}
                        </span>
                      ) : <span className="muted">—</span>}
                    </td>
                  </tr>
                ))}
                {s.instruments.length === 0 && (
                  <tr>
                    <td colSpan={8} className="muted" style={{ textAlign: 'center', padding: '1.4rem' }}>
                      The agent has not reported any instruments yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      ))}

      {/* ---- daily throughput --------------------------------------------- */}
      <div className="card" style={{ marginBottom: '1.1rem', padding: '.8rem 1rem' }}>
        <div className="row" style={{ marginBottom: '.6rem', flexWrap: 'wrap' }}>
          <b style={{ fontSize: '.86rem' }}>Daily throughput</b>
          <span className="muted" style={{ fontSize: '.74rem' }}>per lab, as its agent counts it</span>
          <div className="row" style={{ marginLeft: 'auto' }}>
            <input type="date" className="input" value={from} max={to}
                   onChange={(e) => e.target.value && setFrom(e.target.value)} />
            <span className="muted">to</span>
            <input type="date" className="input" value={to} min={from}
                   onChange={(e) => e.target.value && setTo(e.target.value)} />
          </div>
        </div>
        {dailyError && <div className="alert alert--error" style={{ marginBottom: '.6rem' }}>{dailyError}</div>}
        {dailyLoading ? (
          <div className="center"><InfinityLoader /><span className="muted">Loading throughput…</span></div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Day</th>
                  <th>Lab</th>
                  <th>Samples</th>
                  <th>Results</th>
                  <th>Errors</th>
                </tr>
              </thead>
              <tbody>
                {dailyBySite.map((r) => (
                  <tr key={`${r.day}|${r.code}`}>
                    <td style={{ whiteSpace: 'nowrap' }}>{fmtDay(r.day)}</td>
                    <td>{r.name} <span className="mono muted" style={{ fontSize: '.72rem' }}>{r.code}</span></td>
                    <td>{n(r.samples)}</td>
                    <td>{n(r.results)}</td>
                    <td className={r.errors > 0 ? '' : 'muted'}
                        style={r.errors > 0 ? { color: 'var(--danger)' } : undefined}>
                      {n(r.errors)}
                    </td>
                  </tr>
                ))}
                {dailyBySite.length === 0 && (
                  <tr>
                    <td colSpan={5} className="muted" style={{ textAlign: 'center', padding: '1.4rem' }}>
                      No throughput reported in this range.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ---- result entry sources ----------------------------------------- */}
      <div className="card" style={{ padding: '.8rem 1rem' }}>
        <div className="row" style={{ marginBottom: '.6rem', flexWrap: 'wrap' }}>
          <b style={{ fontSize: '.86rem' }}>Result entry sources</b>
          <span className="muted" style={{ fontSize: '.74rem' }}>
            interfaced vs typed, from the LIS result table for the same range — by the sample's registration day
          </span>
        </div>
        {sourcesError && <div className="alert alert--error" style={{ marginBottom: '.6rem' }}>{sourcesError}</div>}
        {sourcesLoading ? (
          <div className="center"><InfinityLoader /><span className="muted">Counting results…</span></div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Day</th>
                  <th>Lab</th>
                  <th>Interfaced</th>
                  <th>Manual</th>
                  <th>By machine</th>
                </tr>
              </thead>
              <tbody>
                {sourcesByDay.map((r) => {
                  const total = r.interfaced + r.manual;
                  return (
                    <tr key={`${r.day}|${r.lab}`}>
                      <td style={{ whiteSpace: 'nowrap' }}>{fmtDay(r.day)}</td>
                      <td>{r.lab}</td>
                      <td>
                        <b>{n(r.interfaced)}</b>
                        {total > 0 && (
                          <span className="muted" style={{ fontSize: '.72rem' }}>
                            {' '}({Math.round((r.interfaced / total) * 100)}%)
                          </span>
                        )}
                      </td>
                      <td>{n(r.manual)}</td>
                      <td className="muted" style={{ fontSize: '.72rem', lineHeight: 1.6 }}>
                        {r.machines.length === 0
                          ? '—'
                          : r.machines.map((m) => `${m.name} ${n(m.count)}`).join(' · ')}
                      </td>
                    </tr>
                  );
                })}
                {sourcesByDay.length === 0 && (
                  <tr>
                    <td colSpan={5} className="muted" style={{ textAlign: 'center', padding: '1.4rem' }}>
                      No results in this range.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <p className="muted" style={{ fontSize: '.72rem', marginTop: '1rem', lineHeight: 1.6 }}>
        Throughput figures are what each site's Synapse agent reports about itself; the entry-source
        counts come from the LIS result table (machine_name set = written by an analyser or import,
        empty = typed by a person). The two describing the same day differently is signal, not error.
      </p>

      {showRegister && (
        <SiteModal site={null}
                   onClose={() => setShowRegister(false)}
                   onDone={() => { setShowRegister(false); void loadOverview(); }} />
      )}
      {editSite && (
        <SiteModal site={editSite}
                   onClose={() => setEditSite(null)}
                   onDone={() => { setEditSite(null); void loadOverview(); }} />
      )}
    </div>
  );
}

/**
 * Register or edit a lab site. The API mints the key server-side and returns
 * it EXACTLY ONCE (on create, or when rotation is requested) — only a hash is
 * stored, so the modal must not close until the operator has copied it.
 */
function SiteModal({ site, onClose, onDone }: {
  site: SiteOverview | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [code, setCode] = useState(site?.code ?? '');
  const [name, setName] = useState(site?.name ?? '');
  const [location, setLocation] = useState(site?.location ?? '');
  const [businessUnitId, setBusinessUnitId] = useState<number | ''>(site?.businessUnitId ?? '');
  const [isActive, setIsActive] = useState(site?.isActive ?? true);
  const [rotateKey, setRotateKey] = useState(false);
  const [units, setUnits] = useState<BusinessUnit[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mintedKey, setMintedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let live = true;
    interfacingApi.businessUnits()
      .then((r) => { if (live) setUnits(r.units); })
      .catch(() => { /* the dropdown just stays empty */ });
    return () => { live = false; };
  }, []);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const r = await interfacingApi.upsertSite({
        id: site?.id ?? null,
        code: code.trim(),
        name: name.trim(),
        location: location.trim() || null,
        businessUnitId: businessUnitId === '' ? null : businessUnitId,
        isActive,
        rotateKey,
      });
      if (r.apiKey) setMintedKey(r.apiKey);
      else onDone();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not save the site.');
    } finally {
      setBusy(false);
    }
  }

  async function copyKey() {
    if (!mintedKey) return;
    try {
      await navigator.clipboard.writeText(mintedKey);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard can be denied; the input below still allows select-and-copy.
    }
  }

  return (
    <div className="modal-backdrop" onClick={mintedKey ? onDone : onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal__title">
          {mintedKey ? 'Site API key' : site ? `Edit ${site.code}` : 'Register a lab site'}
        </h2>

        {error && <div className="alert alert--error">{error}</div>}

        {mintedKey ? (
          <>
            <div className="alert alert--warn">
              Copy this key now — it will not be shown again. Only a hash is stored, so losing it
              means rotating the key, not recovering it.
            </div>
            <div className="field">
              <label htmlFor="site-key">API key for {code.trim()}</label>
              <input id="site-key" className="input mono" readOnly value={mintedKey}
                     onFocus={(e) => e.currentTarget.select()} />
            </div>
            <p className="muted" style={{ fontSize: '.74rem', lineHeight: 1.6 }}>
              The Synapse agent sends it as <code>X-Site-Key</code>, with{' '}
              <code>X-Site-Code: {code.trim()}</code>, to <code>/api/interfacing/ping</code> and{' '}
              <code>/api/interfacing/report</code>.
            </p>
            <div className="modal__actions">
              <button className="btn btn--ghost" onClick={() => void copyKey()}>
                {copied ? 'Copied' : 'Copy key'}
              </button>
              <button className="btn btn--primary" onClick={onDone}>Done</button>
            </div>
          </>
        ) : (
          <>
            <div className="field">
              <label htmlFor="site-code">Code</label>
              <input id="site-code" value={code} maxLength={20}
                     onChange={(e) => setCode(e.target.value)}
                     placeholder="AGRA-01" autoFocus={!site} />
              <span className="muted" style={{ fontSize: '.7rem' }}>
                Max 20 characters — the agent sends it as X-Site-Code on every request.
              </span>
            </div>
            <div className="field">
              <label htmlFor="site-name">Name</label>
              <input id="site-name" value={name} maxLength={200}
                     onChange={(e) => setName(e.target.value)}
                     placeholder="Agra processing lab" />
            </div>
            <div className="field">
              <label htmlFor="site-location">Location</label>
              <input id="site-location" value={location} maxLength={200}
                     onChange={(e) => setLocation(e.target.value)}
                     placeholder="Agra, UP" />
            </div>
            <div className="field">
              <label htmlFor="site-bu">Business unit</label>
              <select id="site-bu" className="input" value={businessUnitId}
                      onChange={(e) => setBusinessUnitId(e.target.value === '' ? '' : Number(e.target.value))}>
                <option value="">— none —</option>
                {units.map((u) => (
                  <option key={u.id} value={u.id}>{u.name ?? u.code ?? String(u.id)}</option>
                ))}
              </select>
              <span className="muted" style={{ fontSize: '.7rem' }}>
                Links the site to the lab whose interfaced-vs-manual counts it should explain.
              </span>
            </div>
            <div className="field">
              <label style={{ display: 'flex', alignItems: 'center', gap: '.45rem' }}>
                <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
                Active — inactive sites are refused at the door, within a minute
              </label>
            </div>
            {site && (
              <div className="field">
                <label style={{ display: 'flex', alignItems: 'center', gap: '.45rem' }}>
                  <input type="checkbox" checked={rotateKey} onChange={(e) => setRotateKey(e.target.checked)} />
                  Rotate the API key — the current key stops working immediately
                </label>
              </div>
            )}
            <div className="modal__actions">
              <button className="btn btn--ghost" onClick={onClose} disabled={busy}>Cancel</button>
              <button className="btn btn--primary" onClick={() => void submit()}
                      disabled={busy || !code.trim() || !name.trim()}>
                {busy ? 'Saving…' : site ? 'Save' : 'Register'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
