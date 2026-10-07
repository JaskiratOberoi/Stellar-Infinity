import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  salesLedgerApi,
  type SalesKind, type SalesLedgerLine, type SalesLedgerQuery, type SalesSource, type SalesSummary, type SalesTotals,
} from '../api/client';
import { Pager } from '../components/Pager';
import { MenuSelect } from '../components/MenuSelect';
import { InfinityLoader } from '../components/InfinityLoader';
import { fmtDateTime, inr } from '../lib/format';

/**
 * Company sales — every sale line in the lab, as it happens, and the same
 * lines summed up (Billing › Company sales; the lab's roles only).
 *
 * A sale line is what the LIS and the per-client Sales page call one: an
 * amount-checked test row dated by the day the lab charged the tube, at the
 * rate the centre was charged, plus the charged extras. The Lab-sales figure
 * on the dashboard is the sum of exactly these, so a day here adds up to it.
 * A package order is ONE line of kind Master at the package rate.
 *
 * Two tabs over one filter bar. The LEDGER is the feed: newest first, paged,
 * with the filter's totals above it, and a 30-second refresh while today is
 * in the range. The DASHBOARD is the same filter grouped: by day, by
 * business unit, by client, by kind, by item (with the lowest and highest
 * rate it sold at), by source, and — the cut Jas asked for — by item, client
 * and rate, so "which client sold which package at what rate" is one table,
 * sharpest with the kind filter on Packages.
 */

const KINDS: { value: SalesKind | ''; label: string }[] = [
  { value: '', label: 'All kinds' },
  { value: 'Master', label: 'Master profiles' },
  { value: 'Profile', label: 'Profiles' },
  { value: 'Test', label: 'Tests' },
  { value: 'Extra', label: 'Extras' },
];
const SOURCES: { value: SalesSource | ''; label: string }[] = [
  { value: '', label: 'All sources' },
  { value: 'lis', label: 'LIS' },
  { value: 'infinity', label: 'Infinity' },
  { value: 'telo', label: 'Telo' },
];
const KIND_LABEL: Record<SalesKind, string> = { Master: 'Master profile', Profile: 'Profile', Test: 'Test', Extra: 'Extra' };
/** The badge on a line: short, so the kind column stays one word wide (Jas, 2026-10-07). */
const KIND_BADGE: Record<SalesKind, string> = { Master: 'MPro', Profile: 'Pro', Test: 'Test', Extra: 'Extra' };

/** yyyy-mm-dd on the local calendar. */
function isoDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function shift(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00`);
  d.setDate(d.getDate() + n);
  return isoDay(d);
}
const today = isoDay(new Date());

export function CompanySalesPage() {
  const [tab, setTab] = useState<'ledger' | 'dashboard'>('ledger');
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [client, setClient] = useState('');
  const [bu, setBu] = useState<number | null>(null);
  const [kind, setKind] = useState<SalesKind | ''>('');
  const [source, setSource] = useState<SalesSource | ''>('');
  const [search, setSearch] = useState('');
  const [units, setUnits] = useState<{ id: number; code: string | null; name: string | null }[]>([]);

  useEffect(() => {
    salesLedgerApi.options().then((o) => setUnits(o.businessUnits)).catch(() => setUnits([]));
  }, []);

  // One query object for both tabs; a change to any filter re-reads whichever
  // tab is open, and the other re-reads when switched to.
  const query = useMemo<SalesLedgerQuery>(() => ({ from, to, client, bu, kind, source, search }), [from, to, client, bu, kind, source, search]);
  const live = to >= today;

  const preset = (days: number) => { setFrom(shift(today, -(days - 1))); setTo(today); };

  return (
    <div className="page">
      <div className="page__head">
        <div>
          <h1 className="page__title">Company sales</h1>
          <p className="page__sub">
            Every sale line in the lab, LIS included, at the rate the centre was charged — the same lines the
            Lab-sales figure adds up. A master profile is one line at its package rate.
          </p>
        </div>
        <div className="seg" role="tablist" aria-label="View" style={{ marginLeft: 'auto', alignSelf: 'center' }}>
          <button type="button" role="tab" aria-selected={tab === 'ledger'} className={`seg__btn${tab === 'ledger' ? ' is-on' : ''}`}
                  onClick={() => setTab('ledger')}>Ledger</button>
          <button type="button" role="tab" aria-selected={tab === 'dashboard'} className={`seg__btn${tab === 'dashboard' ? ' is-on' : ''}`}
                  onClick={() => setTab('dashboard')}>Dashboard</button>
        </div>
      </div>

      <div className="sl__filters">
        <label className="field sl__f">
          <span>From</span>
          <input className="input input--sm" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value || today)} />
        </label>
        <label className="field sl__f">
          <span>To</span>
          <input className="input input--sm" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value || today)} />
        </label>
        <div className="seg sl__presets" role="group" aria-label="Quick ranges">
          <button type="button" className={`seg__btn${from === today && to === today ? ' is-on' : ''}`} onClick={() => preset(1)}>Today</button>
          <button type="button" className={`seg__btn${from === shift(today, -6) && to === today ? ' is-on' : ''}`} onClick={() => preset(7)}>7 days</button>
          <button type="button" className={`seg__btn${from === shift(today, -29) && to === today ? ' is-on' : ''}`} onClick={() => preset(30)}>30 days</button>
          <button type="button" className={`seg__btn${from === today.slice(0, 8) + '01' && to === today ? ' is-on' : ''}`}
                  onClick={() => { setFrom(today.slice(0, 8) + '01'); setTo(today); }}>This month</button>
        </div>
        <div className="field sl__f">
          <span>Kind</span>
          <MenuSelect ariaLabel="Kind of sale line" value={kind} options={KINDS} onChange={setKind} width={150} />
        </div>
        <div className="field sl__f">
          <span>Business unit</span>
          <MenuSelect ariaLabel="Business unit" value={bu} width={160}
                      options={[{ value: null, label: 'All units' }, ...units.map((u) => ({ value: u.id, label: u.code ?? String(u.id), hint: u.name }))]}
                      onChange={setBu} />
        </div>
        <div className="field sl__f">
          <span>Source</span>
          <MenuSelect ariaLabel="Where the patient was registered" value={source} options={SOURCES} onChange={setSource} width={130} />
        </div>
        <label className="field sl__f sl__f--grow">
          <span>Client</span>
          <input className="input input--sm" placeholder="code or name" value={client} onChange={(e) => setClient(e.target.value)} />
        </label>
        <label className="field sl__f sl__f--grow">
          <span>Item or patient</span>
          <input className="input input--sm" placeholder="test code, name, patient or PID" value={search} onChange={(e) => setSearch(e.target.value)} />
        </label>
        {(client || search || kind || source || bu != null) && (
          <button className="btn btn--ghost btn--sm" style={{ alignSelf: 'flex-end' }}
                  onClick={() => { setClient(''); setSearch(''); setKind(''); setSource(''); setBu(null); }}>Clear</button>
        )}
      </div>

      {tab === 'ledger' ? <Ledger query={query} live={live} /> : <Dashboard query={query} kind={kind} />}
    </div>
  );
}

/* ---------------------------------------------------------------------- */

function TotalsStrip({ t, live, refreshedAt }: { t: SalesTotals | null; live?: boolean; refreshedAt?: Date | null }) {
  if (!t) return null;
  return (
    <div className="sl__totals">
      <span><b className="mono">{inr(t.amount)}</b> <span className="muted">sold</span></span>
      <span><b>{t.lines.toLocaleString('en-IN')}</b> <span className="muted">line{t.lines === 1 ? '' : 's'}</span></span>
      <span><b>{t.patients.toLocaleString('en-IN')}</b> <span className="muted">patient{t.patients === 1 ? '' : 's'}</span></span>
      <span><b>{t.clients.toLocaleString('en-IN')}</b> <span className="muted">client{t.clients === 1 ? '' : 's'}</span></span>
      {t.days > 1 && <span><b className="mono">{inr(Math.round(t.amount / t.days))}</b> <span className="muted">a day</span></span>}
      {live && (
        <span className="muted sl__live" title="Today is in the range: the ledger re-reads every 30 seconds">
          <i className="sl__dot" aria-hidden="true" /> live{refreshedAt ? ` · ${refreshedAt.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}` : ''}
        </span>
      )}
    </div>
  );
}

function Ledger({ query, live }: { query: SalesLedgerQuery; live: boolean }) {
  const [rows, setRows] = useState<SalesLedgerLine[]>([]);
  const [totals, setTotals] = useState<SalesTotals | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(100);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshedAt, setRefreshedAt] = useState<Date | null>(null);
  const [exporting, setExporting] = useState(false);
  const gen = useRef(0);

  const load = useCallback(async (quiet = false) => {
    const my = ++gen.current;
    if (!quiet) setLoading(true);
    setError(null);
    try {
      const r = await salesLedgerApi.ledger(query, page, pageSize);
      if (my !== gen.current) return;
      setRows(r.rows); setTotals(r.totals); setRefreshedAt(new Date());
    } catch (e) {
      if (my === gen.current) setError(e instanceof Error ? e.message : 'Could not load the ledger.');
    } finally {
      if (my === gen.current) setLoading(false);
    }
  }, [query, page, pageSize]);

  useEffect(() => { setPage(1); }, [query]);
  // Debounced on the typed filters; then, while today is in the range, a
  // quiet re-read every 30 seconds — the feed part.
  useEffect(() => {
    const t = setTimeout(() => void load(), 300);
    return () => clearTimeout(t);
  }, [load]);
  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => void load(true), 30000);
    return () => clearInterval(id);
  }, [live, load]);

  /** The whole filter as CSV, a thousand lines a page, capped at ten thousand. */
  const exportCsv = async () => {
    setExporting(true);
    try {
      const all: SalesLedgerLine[] = [];
      for (let p = 1; p <= 10; p++) {
        const r = await salesLedgerApi.ledger(query, p, 1000);
        all.push(...r.rows);
        if (r.rows.length < 1000 || all.length >= r.totals.lines) break;
      }
      const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const head = ['Sold at', 'Client', 'Client name', 'Unit', 'PID', 'Patient', 'SID', 'Kind', 'Code', 'Item', 'Rate', 'MRP', 'Source'];
      const lines = all.map((l) => [fmtDateTime(l.soldAt), l.clientCode, l.clientName, l.buCode, l.pid, l.patient, l.sid,
        KIND_LABEL[l.kind], l.code, l.name, l.amount, l.mrp ?? '', l.source].map(esc).join(','));
      const blob = new Blob(['﻿' + [head.map(esc).join(','), ...lines].join('\r\n')], { type: 'text/csv;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `sales-${query.from}-to-${query.to}${query.kind ? `-${query.kind.toLowerCase()}` : ''}.csv`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not export.');
    } finally {
      setExporting(false);
    }
  };

  return (
    <>
      <div className="row" style={{ alignItems: 'center', gap: '.8rem', flexWrap: 'wrap', marginBottom: '.6rem' }}>
        <TotalsStrip t={totals} live={live} refreshedAt={refreshedAt} />
        <button className="btn btn--ghost btn--sm" style={{ marginLeft: 'auto' }} disabled={exporting || !totals || totals.lines === 0}
                onClick={() => void exportCsv()} title="The whole filter, up to 10,000 lines">
          {exporting ? 'Exporting…' : 'Download CSV'}
        </button>
      </div>
      {error && <div className="alert alert--error" style={{ marginBottom: '.9rem' }}>{error}</div>}
      {loading && rows.length === 0 ? (
        <div className="center"><InfinityLoader /><span className="muted">Loading the ledger…</span></div>
      ) : (
        <>
          <div className="table-wrap table-wrap--cards">
            <table className="sl__table">
              <thead>
                <tr>
                  <th>Sold at</th><th>Client</th><th>Unit</th><th>Patient</th><th>SID</th><th>Kind</th><th>Item</th>
                  <th style={{ textAlign: 'right' }}>Rate</th><th style={{ textAlign: 'right' }}>MRP</th><th>Source</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((l) => (
                  <tr key={`${l.kind}:${l.lineId}`}>
                    <td className="muted cell--meta" data-label="Sold at" style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(l.soldAt)}</td>
                    <td className="cell--lead"><b className="mono">{l.clientCode}</b><span className="muted sl__sub">{l.clientName}</span></td>
                    <td className="muted cell--meta" data-label="Unit">{l.buCode ?? '—'}</td>
                    <td className="cell--head">{l.patient ?? '—'}<span className="muted sl__sub mono">{l.pid}</span></td>
                    <td className="mono cell--meta" data-label="SID">{l.sid ?? '—'}</td>
                    <td className="cell--meta" data-label="Kind"><span className={`badge sl__kind sl__kind--${l.kind.toLowerCase()}`}>{KIND_LABEL[l.kind]}</span></td>
                    <td data-label="Item">{l.name ?? l.code}<span className="muted sl__sub mono">{l.code}</span></td>
                    <td className="mono cell--tag" style={{ textAlign: 'right' }}>{inr(l.amount)}</td>
                    <td className="mono muted cell--meta" data-label="MRP" style={{ textAlign: 'right' }}>{l.mrp != null ? inr(l.mrp) : '—'}</td>
                    <td className="muted cell--meta" data-label="Source">{SOURCES.find((s) => s.value === l.source)?.label ?? l.source}</td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr><td colSpan={10} className="muted" style={{ textAlign: 'center', padding: '2rem' }}>No sale lines match this filter.</td></tr>
                )}
              </tbody>
            </table>
          </div>
          {totals && (
            <Pager page={page} pageSize={pageSize} total={totals.lines} noun="line"
                   onPage={setPage} onPageSize={(s) => { setPageSize(s); setPage(1); }} sizes={[100, 250, 500, 1000]} />
          )}
        </>
      )}
    </>
  );
}

/* ---------------------------------------------------------------------- */

function Dashboard({ query, kind }: { query: SalesLedgerQuery; kind: SalesKind | '' }) {
  const [data, setData] = useState<SalesSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const gen = useRef(0);

  useEffect(() => {
    const my = ++gen.current;
    setLoading(true); setError(null);
    const t = setTimeout(() => {
      salesLedgerApi.summary(query)
        .then((d) => { if (my === gen.current) setData(d); })
        .catch((e) => { if (my === gen.current) setError(e instanceof Error ? e.message : 'Could not load the summary.'); })
        .finally(() => { if (my === gen.current) setLoading(false); });
    }, 300);
    return () => clearTimeout(t);
  }, [query]);

  if (error) return <div className="alert alert--error">{error}</div>;
  if (!data || (loading && !data)) return <div className="center"><InfinityLoader /><span className="muted">Summing up…</span></div>;

  const t = data.totals;
  const maxDay = Math.max(1, ...data.byDay.map((d) => d.amount));
  const share = (amt: number) => (t.amount > 0 ? Math.round((amt / t.amount) * 1000) / 10 : 0);

  return (
    <div className={loading ? 'sl__dim' : undefined}>
      <div className="sl__kpis">
        <Tile label="Sold" value={inr(t.amount)} sub={`${t.days} day${t.days === 1 ? '' : 's'} · ${inr(Math.round(t.amount / Math.max(1, t.days)))} a day`} accent />
        <Tile label="Sale lines" value={t.lines.toLocaleString('en-IN')} sub={`${inr(t.lines ? Math.round(t.amount / t.lines) : 0)} a line`} />
        <Tile label="Patients" value={t.patients.toLocaleString('en-IN')} sub={`${inr(t.patients ? Math.round(t.amount / t.patients) : 0)} a patient`} />
        <Tile label="Clients" value={t.clients.toLocaleString('en-IN')} sub="with at least one line" />
      </div>

      {data.byDay.length > 1 && (
        <div className="card" style={{ marginBottom: '.9rem' }}>
          <h2 className="sl__h">By day</h2>
          <div className="sl__bars" role="img" aria-label="Sales by day">
            {data.byDay.map((d) => (
              <div key={d.day} className="sl__bar" title={`${d.day}: ${inr(d.amount)} · ${d.lines} lines`}>
                <div className="sl__bar-fill" style={{ height: `${Math.max(2, (d.amount / maxDay) * 100)}%` }} />
                <span className="sl__bar-label">{d.day.slice(8)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {kind === 'Master' && (
        <Panel title="Master profile · client · rate" sub="Which client sold which master profile at what rate — one row per rate charged, by amount">
          <table>
            <thead><tr><th>Master profile</th><th>Client</th><th className="num">Rate</th><th className="num">Lines</th><th className="num">Amount</th></tr></thead>
            <tbody>
              {data.byItemClientRate.map((r, i) => (
                <tr key={i}>
                  <td>{r.name}<span className="muted sl__sub mono">{r.code}</span></td>
                  <td><b className="mono">{r.clientCode}</b><span className="muted sl__sub">{r.clientName}</span></td>
                  <td className="num mono">{inr(r.rate)}</td>
                  <td className="num">{r.lines.toLocaleString('en-IN')}</td>
                  <td className="num mono">{inr(r.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}

      <div className="sl__grid">
        <Panel title="By business unit" sub="the centre's unit">
          <table>
            <thead><tr><th>Unit</th><th className="num">Clients</th><th className="num">Lines</th><th className="num">Amount</th><th className="num">Share</th></tr></thead>
            <tbody>
              {data.byBusinessUnit.map((b) => (
                <tr key={b.buId ?? 'none'}>
                  <td><b>{b.buCode ?? '—'}</b><span className="muted sl__sub">{b.buName}</span></td>
                  <td className="num">{b.clients}</td><td className="num">{b.lines.toLocaleString('en-IN')}</td>
                  <td className="num mono">{inr(b.amount)}</td><td className="num muted">{share(b.amount)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>

        <Panel title="By kind and source">
          <table>
            <thead><tr><th>Kind</th><th className="num">Lines</th><th className="num">Amount</th><th className="num">Share</th></tr></thead>
            <tbody>
              {data.byKind.map((k) => (
                <tr key={k.kind}><td>{KIND_LABEL[k.kind] ?? k.kind}</td><td className="num">{k.lines.toLocaleString('en-IN')}</td>
                  <td className="num mono">{inr(k.amount)}</td><td className="num muted">{share(k.amount)}%</td></tr>
              ))}
              {data.bySource.map((s) => (
                <tr key={s.source}><td className="muted">Registered in {SOURCES.find((x) => x.value === s.source)?.label ?? s.source}</td>
                  <td className="num">{s.lines.toLocaleString('en-IN')}</td><td className="num mono">{inr(s.amount)}</td><td className="num muted">{share(s.amount)}%</td></tr>
              ))}
            </tbody>
          </table>
        </Panel>

        <Panel title="Top clients" sub="by amount, top 40">
          <table>
            <thead><tr><th>Client</th><th className="num">Patients</th><th className="num">Lines</th><th className="num">Amount</th></tr></thead>
            <tbody>
              {data.byClient.map((c) => (
                <tr key={c.clientCode ?? '—'}>
                  <td><b className="mono">{c.clientCode}</b><span className="muted sl__sub">{c.clientName}</span></td>
                  <td className="num">{c.patients.toLocaleString('en-IN')}</td><td className="num">{c.lines.toLocaleString('en-IN')}</td>
                  <td className="num mono">{inr(c.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>

        <Panel title="Top items" sub="by amount, top 40 · the lowest and highest rate it sold at">
          <table>
            <thead><tr><th>Item</th><th className="num">Clients</th><th className="num">Lines</th><th className="num">Rate range</th><th className="num">Amount</th></tr></thead>
            <tbody>
              {data.byItem.map((i) => (
                <tr key={`${i.kind}:${i.code}`}>
                  <td><span className={`badge sl__kind sl__kind--${i.kind.toLowerCase()}`}>{KIND_LABEL[i.kind]}</span> {i.name}<span className="muted sl__sub mono">{i.code}</span></td>
                  <td className="num">{i.clients}</td><td className="num">{i.lines.toLocaleString('en-IN')}</td>
                  <td className="num mono">{i.minRate === i.maxRate ? inr(i.minRate) : `${inr(i.minRate)} – ${inr(i.maxRate)}`}</td>
                  <td className="num mono">{inr(i.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>

        {kind !== 'Master' && (
          <Panel title="Item · client · rate" sub="one row per item, client and rate charged — top 300 by amount">
            <table>
              <thead><tr><th>Item</th><th>Client</th><th className="num">Rate</th><th className="num">Lines</th><th className="num">Amount</th></tr></thead>
              <tbody>
                {data.byItemClientRate.map((r, i) => (
                  <tr key={i}>
                    <td><span className={`badge sl__kind sl__kind--${r.kind.toLowerCase()}`}>{KIND_LABEL[r.kind]}</span> {r.name}<span className="muted sl__sub mono">{r.code}</span></td>
                    <td><b className="mono">{r.clientCode}</b></td>
                    <td className="num mono">{inr(r.rate)}</td><td className="num">{r.lines.toLocaleString('en-IN')}</td><td className="num mono">{inr(r.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        )}
      </div>
    </div>
  );
}

function Tile({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: boolean }) {
  return (
    <div className="card">
      <div className="muted" style={{ fontSize: '.66rem', letterSpacing: '.14em', textTransform: 'uppercase' }}>{label}</div>
      <div style={{ fontSize: '1.5rem', fontWeight: 300, marginTop: '.35rem', letterSpacing: '.01em', color: accent ? 'var(--teal)' : undefined }}>{value}</div>
      {sub && <div className="muted" style={{ fontSize: '.74rem', marginTop: '.2rem' }}>{sub}</div>}
    </div>
  );
}

function Panel({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <div className="card sl__panel">
      <h2 className="sl__h">{title}{sub && <span className="muted sl__h-sub">{sub}</span>}</h2>
      <div className="sl__panel-body">{children}</div>
    </div>
  );
}
