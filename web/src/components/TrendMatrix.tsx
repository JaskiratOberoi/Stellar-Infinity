import type { ResultTrendResponse } from '../api/client';
import { buildTrend, type TrendAnalyte } from '../lib/trendBands';
import '../trend.css';

/**
 * The Trending report: one block per analyte, the bands down the side and
 * a column per visit, the value printed in the band it fell in that day.
 *
 * Greyscale by design, like the thyroid figure: the healthy band's row is
 * white with a solid rule, the others are lightly hatched, a value out of
 * its healthy band is bold with the report's ▲▼ glyph, and the current
 * visit's column is tinted. Reads identically in ink and on screen.
 */

const fmtDay = (iso: string | null) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso.slice(0, 10) : d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' });
};

const fmtNum = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(Math.min(2, (String(n).split('.')[1] ?? '').length)));

export function trendBlocks(trend: ResultTrendResponse | null | undefined): TrendAnalyte[] {
  return trend ? buildTrend(trend.analytes) : [];
}

export function TrendMatrix({ trend, blocks, compact = false }: {
  trend: ResultTrendResponse;
  blocks?: TrendAnalyte[];
  /** Tighter type and padding, for the booklet's page. */
  compact?: boolean;
}) {
  const list = blocks ?? trendBlocks(trend);
  if (list.length === 0) return null;
  return (
    <div className={`tr${compact ? ' tr--compact' : ''}`}>
      <p className="tr__basis">
        {trend.match.matchedOn === 'name+mobile+gender'
          ? <>Earlier visits matched on name, mobile and sex, with an age check — {trend.match.priorVisits} earlier {trend.match.priorVisits === 1 ? 'visit' : 'visits'}. A shared family phone can still look like one person: check the dates before reading a trend.</>
          : <>Results from this visit only.</>}
      </p>
      <div className="tr__grid">
        {list.map((a) => <AnalyteBlock key={a.key} a={a} />)}
      </div>
    </div>
  );
}

function AnalyteBlock({ a }: { a: TrendAnalyte }) {
  const last = a.cells[a.cells.length - 1];
  const lastBand = last ? a.bands[last.bandIndex] : null;
  const arrow = a.delta == null || Math.abs(a.delta) < 1e-9 ? '=' : a.delta > 0 ? '▲' : '▼';
  return (
    <div className="tr__block">
      <div className="tr__head">
        <span className="tr__name">{a.name}</span>
        <span className="tr__latest">
          {last && <b className={last.bandIndex !== -1 && lastBand && !lastBand.healthy ? 'tr__off' : ''}>{last.label}</b>}
          {a.unit && <span className="tr__unit"> {a.unit}</span>}
          {a.delta != null && (
            <span className="tr__delta"> {arrow} {a.delta === 0 ? 'no change' : `${a.delta > 0 ? '+' : '−'}${fmtNum(Math.abs(a.delta))} since last`}</span>
          )}
        </span>
      </div>
      <table className="tr__table">
        <thead>
          <tr>
            <th className="tr__bandhead">Band</th>
            {a.columns.map((c, i) => (
              <th key={i} className={c.isCurrent ? 'tr__col tr__col--now' : 'tr__col'}>{fmtDay(c.date)}{c.isCurrent ? <span className="tr__now">this visit</span> : null}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {a.bands.map((b, bi) => (
            <tr key={bi} className={b.healthy ? 'tr__row tr__row--ok' : 'tr__row'}>
              <td className="tr__band">
                <span className="tr__bandname">{b.label}</span>
                <span className="tr__limits">{limits(b)}</span>
              </td>
              {a.cells.map((cell, ci) => (
                <td key={ci} className={a.columns[ci].isCurrent ? 'tr__cell tr__cell--now' : 'tr__cell'}>
                  {cell && cell.bandIndex === bi ? (
                    <span className={b.healthy ? 'tr__val' : 'tr__val tr__val--off'}>
                      {b.healthy ? '' : bi < a.bands.findIndex((x) => x.healthy) ? '▲ ' : '▼ '}{cell.label}
                    </span>
                  ) : null}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function limits(b: { lo: number | null; hi: number | null }): string {
  if (b.lo != null && b.hi != null) return `${fmtNum(b.lo)} – ${fmtNum(b.hi)}`;
  if (b.hi != null) return `< ${fmtNum(b.hi)}`;
  if (b.lo != null) return `≥ ${fmtNum(b.lo)}`;
  return '';
}
