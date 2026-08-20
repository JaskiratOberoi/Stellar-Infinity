import { useEffect, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { accountsApi, type ClientAccount } from '../api/client';
import { inr } from '../lib/format';
import { InfinityLoader } from '../components/InfinityLoader';

/**
 * The Billing menu's Sales entry.
 *
 * Sales data is per client, so the nav link has to resolve WHOSE sales the
 * visitor means. For a client signed into a single tagged code — most of them —
 * there is exactly one answer and this page is never seen: it forwards straight
 * to that account's sales. Anyone with more than one account in scope (the lab,
 * or a client holding several codes) picks from a list first.
 *
 * A resolver, not a dashboard: it holds no totals of its own, because summing
 * sales across clients is the LAB dashboard's job and a mixed number here would
 * be read as one client's figure.
 */
export function SalesHome() {
  const [rows, setRows] = useState<ClientAccount[]>([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** Set once from the pristine first load — a search narrowing to one row is
   *  the operator working the list, not a single-account visitor. */
  const [only, setOnly] = useState<ClientAccount | null>(null);
  const [resolved, setResolved] = useState(false);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    const t = setTimeout(() => {
      accountsApi.list(search, false, 1, 100)
        .then((r) => {
          if (!live) return;
          setRows(r.rows);
          setTotal(r.total);
          if (!resolved) {
            setResolved(true);
            if (!search.trim() && r.total === 1 && r.rows.length === 1) setOnly(r.rows[0]);
          }
        })
        .catch((e) => { if (live) setError(e instanceof Error ? e.message : 'Could not load accounts.'); })
        .finally(() => { if (live) setLoading(false); });
    }, search ? 300 : 0);
    return () => { live = false; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  if (only) return <Navigate to={`/accounts/${only.mccId}/sales`} replace />;

  if (!resolved) {
    return (
      <div className="page">
        <div className="center"><InfinityLoader /><span className="muted">Opening sales…</span></div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page__head">
        <div>
          <h1 className="page__title">Sales</h1>
          <p className="page__sub">Pick the client whose sales to open.</p>
        </div>
        <input className="input" placeholder="Search code or name…" value={search}
               onChange={(e) => setSearch(e.target.value)}
               style={{ marginLeft: 'auto', minWidth: 220 }} />
      </div>

      {error && <div className="alert alert--error" style={{ marginBottom: '.8rem' }}>{error}</div>}

      {loading ? (
        <div className="center"><InfinityLoader /></div>
      ) : (
        <div className="table-wrap table-wrap--cards">
          <table>
            <thead>
              <tr><th>Client</th><th style={{ textAlign: 'right' }}>Owed</th><th /></tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.mccId}>
                  <td className="cell--lead">
                    <b className="mono">{a.clientCode}</b>
                    <div className="muted" style={{ fontSize: '.74rem' }}>{a.clientName ?? '—'}</div>
                  </td>
                  <td className="mono cell--tag" style={{ textAlign: 'right' }}>
                    {a.owed > 0 ? <span style={{ color: 'var(--danger)' }}>{inr(a.owed)}</span> : <span className="muted">—</span>}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <Link className="btn btn--ghost btn--sm" to={`/accounts/${a.mccId}/sales`}>
                      Sales →
                    </Link>
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={3} className="muted" style={{ textAlign: 'center', padding: '2rem' }}>
                    No accounts match.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          {total > rows.length && (
            <p className="muted" style={{ fontSize: '.74rem', padding: '.6rem .8rem' }}>
              Showing the first {rows.length.toLocaleString()} of {total.toLocaleString()} — search to narrow.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
