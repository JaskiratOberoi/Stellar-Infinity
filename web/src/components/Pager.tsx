/**
 * The pager used by every list in Infinity.
 *
 * It exists so that no screen has to invent its own answer to "is this
 * everything?". Every control here is driven by a server-supplied `total`.
 * Nothing infers whether more rows exist from the size of the page in hand —
 * that inference is wrong whenever the total divides evenly by the page size,
 * and it is meaningless the moment any filtering happens client-side.
 *
 * If a list cannot supply a real total, it should not use this component; it
 * should be fixed to supply one.
 */
export function Pager({
  page,
  pageSize,
  total,
  onPage,
  onPageSize,
  sizes = [50, 100, 250, 500, 1000],
  noun = 'row',
  nounPlural,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (page: number) => void;
  onPageSize?: (size: number) => void;
  sizes?: number[];
  noun?: string;
  /** For nouns that do not pluralise with a bare "s" — "entry" / "entries". */
  nounPlural?: string;
}) {
  const plural = nounPlural ?? `${noun}s`;
  const pageCount = pageSize > 0 ? Math.ceil(total / pageSize) : 0;
  const first = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);

  return (
    <div className="pager">
      <span className="pager__range muted">
        {total === 0 ? (
          `No ${plural}`
        ) : (
          <>
            Showing <b>{first.toLocaleString()}–{last.toLocaleString()}</b> of{' '}
            <b>{total.toLocaleString()}</b> {total === 1 ? noun : plural}
          </>
        )}
      </span>

      {pageCount > 1 && (
        <div className="row" style={{ gap: '.3rem' }}>
          <button className="btn btn--ghost btn--sm" disabled={page <= 1}
                  onClick={() => onPage(1)} title="First page" aria-label="First page">«</button>
          <button className="btn btn--ghost btn--sm" disabled={page <= 1}
                  onClick={() => onPage(page - 1)}>Previous</button>

          <span className="muted" style={{ fontSize: '.78rem', padding: '0 .5rem' }}>
            Page {page.toLocaleString()} of {pageCount.toLocaleString()}
          </span>

          <button className="btn btn--ghost btn--sm" disabled={page >= pageCount}
                  onClick={() => onPage(page + 1)}>Next</button>
          <button className="btn btn--ghost btn--sm" disabled={page >= pageCount}
                  onClick={() => onPage(pageCount)} title="Last page" aria-label="Last page">»</button>
        </div>
      )}

      {onPageSize && (
        <label className="row pager__size muted">
          Rows
          <select className="input input--sm" value={pageSize}
                  onChange={(e) => onPageSize(Number(e.target.value))}>
            {sizes.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
      )}
    </div>
  );
}
