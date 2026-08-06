import { useCallback, useEffect, useState } from 'react';
import { catalogApi, type CatalogItem } from '../api/client';
import { inr, plainText } from '../lib/format';
import { Pager } from '../components/Pager';
import { InfinityLoader } from '../components/InfinityLoader';
import { ClientPicker } from '../components/ClientPicker';

const KINDS = [
  { value: '', label: 'Everything' },
  { value: 'test', label: 'Tests' },
  { value: 'profile', label: 'Profiles' },
  { value: 'master', label: 'Master profiles' },
];

/**
 * Where a price comes from. Shown on every row rather than only the total,
 * because the interesting case is one line silently falling through to MRP on a
 * client who should be on a negotiated rate — a margin leak that a correct
 * -looking total hides.
 */
export function RateSourceBadge({ source }: { source: string }) {
  const label = source === 'ratelist' ? 'rate list'
    : source === 'special' ? 'special'
      : source === 'mrp' ? 'MRP'
        : 'no price';

  const hue = source === 'special' ? 'status--lime'
    : source === 'ratelist' ? 'status--green'
      : source === 'mrp' ? 'status--neutral'
        : 'status--red';

  return <span className={`badge badge--lis-status ${hue}`}>{label}</span>;
}

/**
 * The test catalogue, priced for one client.
 *
 * Picking a client is the whole point: without one every row shows MRP, which
 * is not what a B2B client is billed. The rate and its source are shown side by
 * side with MRP so the difference is visible before an order is built on it.
 */
export function Catalogue() {
  const [mcc, setMcc] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState('');
  const [rows, setRows] = useState<CatalogItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(100);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await catalogApi.search(mcc, search, kind, page, pageSize);
      setRows(r.rows);
      setTotal(r.total);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the catalogue.');
    } finally {
      setLoading(false);
    }
  }, [mcc, search, kind, page, pageSize]);

  useEffect(() => {
    const t = setTimeout(() => void load(), 300);
    return () => clearTimeout(t);
  }, [load]);

  // Any narrowing changes how many pages there are.
  useEffect(() => { setPage(1); }, [mcc, search, kind, pageSize]);

  const unpriced = rows.filter((r) => r.rateSource === 'none').length;

  return (
    <div className="page">
      <div className="page__head">
        <div>
          <h1 className="page__title">Catalogue</h1>
          <p className="page__sub">
            {total.toLocaleString()} item{total === 1 ? '' : 's'}
            {mcc == null ? ' · priced at MRP — choose a client for their rates' : ' · priced for this client'}
          </p>
        </div>

        <div className="row" style={{ marginLeft: 'auto', flexWrap: 'wrap' }}>
          <ClientPicker value={mcc} onChange={setMcc} />
          <input className="input" placeholder="Search name or code…" value={search}
                 onChange={(e) => setSearch(e.target.value)} style={{ minWidth: 200 }} />
          <select className="input" value={kind} onChange={(e) => setKind(e.target.value)}>
            {KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
          </select>
        </div>
      </div>

      {unpriced > 0 && (
        <div className="alert alert--info" style={{ marginBottom: '.9rem' }}>
          <b>{unpriced}</b> item{unpriced === 1 ? ' on this page has' : 's on this page have'} no price for
          this client. They cannot be billed until a rate or MRP exists.
        </div>
      )}

      {error && <div className="alert alert--error" style={{ marginBottom: '.9rem' }}>{error}</div>}

      {loading ? (
        <div className="center"><InfinityLoader /><span className="muted">Loading catalogue…</span></div>
      ) : (
        <div className="table-wrap table-wrap--cards">
          <table>
            <thead>
              <tr>
                <th>Test</th>
                <th>Code</th>
                <th>Department</th>
                <th style={{ textAlign: 'right' }}>MRP</th>
                <th style={{ textAlign: 'right' }}>Rate</th>
                <th>Source</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.kind}:${r.id}`}>
                  <td className="cell--lead">
                    {plainText(r.name) || r.code || `#${r.id}`}
                    {r.kind !== 'test' && (
                      <span className="muted" style={{ fontSize: '.7rem' }}>
                        {' '}· {r.kind === 'master' ? 'master profile' : 'profile'}
                      </span>
                    )}
                  </td>
                  <td className="mono muted cell--meta" data-label="Code">{r.code ?? '—'}</td>
                  <td className="muted cell--meta" data-label="Department">{r.departmentName ?? '—'}</td>
                  <td className="mono muted cell--meta" data-label="MRP" style={{ textAlign: 'right' }}>
                    {r.mrp != null && r.mrp > 0 ? inr(r.mrp) : '—'}
                  </td>
                  <td className="mono cell--tag" style={{ textAlign: 'right', fontWeight: 600 }}>
                    {r.rate != null ? inr(r.rate) : <span className="muted">no price</span>}
                  </td>
                  <td className="cell--tag"><RateSourceBadge source={r.rateSource} /></td>
                </tr>
              ))}

              {rows.length === 0 && (
                <tr>
                  <td colSpan={6} className="muted" style={{ textAlign: 'center', padding: '2rem' }}>
                    Nothing matches that search.
                  </td>
                </tr>
              )}
            </tbody>
          </table>

          <Pager page={page} pageSize={pageSize} total={total} noun="item"
                 onPage={setPage} onPageSize={setPageSize} />
        </div>
      )}
    </div>
  );
}
