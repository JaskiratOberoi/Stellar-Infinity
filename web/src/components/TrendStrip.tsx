import type { AnalyteTrend, ResultTrendResponse } from '../api/client';
import { buildTrend, type TrendAnalyte } from '../lib/trendBands';
import { trendWorthy } from '../lib/trendEligibility';
import '../trend.css';

/**
 * A parameter's history, two ways.
 *
 * The Smart Report gets the full picture under each result card: the
 * reference bands as rows, one column per visit, the value sitting in the
 * band it fell in that day — the "risk level" matrix, kept compact enough
 * to sit beside a reading. The standard report, which the lab prints and
 * doctors scan, gets one line: the previous value, when, and how far this
 * one moved — a single comparison point, nothing to study.
 *
 * Both draw only the parameters a trend is meaningful for (lib/trendEligibility)
 * and only where the same person has an earlier numeric result (script 75's
 * identity rule, unchanged).
 */

const MAX_COLS = 6;

const fmtDay = (iso: string | null, year = true) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return d.toLocaleDateString('en-IN', year ? { day: '2-digit', month: 'short', year: '2-digit' } : { day: '2-digit', month: 'short' });
};
const fmtNum = (n: number) => (Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2))));

function change(a: TrendAnalyte): { arrow: string; text: string; pct: string | null; flat: boolean } {
  const n = a.cells.length;
  const last = a.cells[n - 1]!.value, prev = a.cells[n - 2]!.value;
  const delta = last - prev;
  const flat = Math.abs(delta) < 1e-9;
  const pct = !flat && Math.abs(prev) > 1e-9 ? (delta / Math.abs(prev)) * 100 : null;
  return {
    arrow: flat ? '=' : delta > 0 ? '▲' : '▼',
    text: flat ? 'no change' : `${delta > 0 ? '+' : '−'}${fmtNum(Math.abs(delta))}${a.unit ? ` ${a.unit}` : ''}`,
    pct: pct == null ? null : `${Math.abs(pct) >= 999 ? '>999' : fmtNum(Math.abs(pct))}%`,
    flat,
  };
}

/** The Smart Report's matrix: bands down, visits across, compact. */
export function TrendMatrixCompact({ a }: { a: TrendAnalyte }) {
  const start = Math.max(0, a.cells.length - MAX_COLS);
  const cols = a.columns.slice(start);
  const cells = a.cells.slice(start);
  const healthyIdx = a.bands.findIndex((b) => b.healthy);
  const ch = change(a);
  const lastCell = cells[cells.length - 1]!;
  const lastOff = healthyIdx >= 0 ? !a.bands[lastCell.bandIndex].healthy : lastCell.abnormal;
  return (
    <div className="tm">
      <div className="tm__head">
        <span className="tm__title">Your trend <span className="tm__n">· {a.cells.length} visits</span></span>
        <span className={`tm__chip${ch.flat ? ' tm__chip--flat' : lastOff ? ' tm__chip--off' : ' tm__chip--ok'}`}>
          {ch.arrow} {ch.text}{ch.pct && <span className="tm__pct"> ({ch.pct})</span>}
        </span>
      </div>
      {/* A grid of divs, deliberately not a <table>: Chromium starts a new
          page before a break-inside:avoid block that holds a table, which put
          every short chapter of the booklet on a page of its own. Measured in
          the render sidecar, 2026-09-28. */}
      <div className="tm__grid" style={{ gridTemplateColumns: `38% repeat(${cols.length}, 1fr)` }} role="table" aria-label={`${a.name} by visit`}>
        <div className="tm__hd tm__bandhead" />
        {cols.map((c, i) => (
          <div key={`h${i}`} className={c.isCurrent ? 'tm__hd tm__col tm__col--now' : 'tm__hd tm__col'}>
            {fmtDay(c.date, false)}<span className="tm__yr">{c.date ? new Date(c.date).getFullYear() : ''}</span>
          </div>
        ))}
        {a.bands.map((b, bi) => {
          const above = healthyIdx >= 0 && bi < healthyIdx;
          const below = healthyIdx >= 0 && bi > healthyIdx;
          const rowCls = `tm__td${b.healthy ? ' tm__td--ok' : above ? ' tm__td--above' : below ? ' tm__td--below' : ''}${bi === a.bands.length - 1 ? ' tm__td--last' : ''}`;
          return [
            <div key={`b${bi}`} className={`${rowCls} tm__band`}>
              <span className="tm__bandname">{b.label}</span>
              <span className="tm__limits">{limits(b)}</span>
            </div>,
            ...cells.map((cell, ci) => (
              <div key={`c${bi}-${ci}`} className={`${rowCls} tm__cell${cols[ci].isCurrent ? ' tm__cell--now' : ''}`}>
                {cell && cell.bandIndex === bi && (
                  <span className={`tm__val${b.healthy ? '' : ' tm__val--off'}`}>{cell.label}</span>
                )}
              </div>
            )),
          ];
        })}
      </div>
    </div>
  );
}

/** The standard report's one line: the previous value and how far this one moved. */
export function PreviousValue({ a }: { a: TrendAnalyte }) {
  const n = a.cells.length;
  const prevCell = a.cells[n - 2]!, prevCol = a.columns[n - 2];
  const healthyIdx = a.bands.findIndex((b) => b.healthy);
  const prevBand = a.bands[prevCell.bandIndex];
  const prevOff = healthyIdx >= 0 ? !prevBand.healthy : prevCell.abnormal;
  const ch = change(a);
  return (
    <div className="pv">
      <span className="pv__label">Previously</span>
      <span className="pv__val">{prevOff ? (prevCell.bandIndex < healthyIdx ? '▲ ' : '▼ ') : ''}{prevCell.label}{a.unit ? ` ${a.unit}` : ''}</span>
      <span className="pv__when">on {fmtDay(prevCol.date)}</span>
      <span className="pv__sep">·</span>
      <span className={`pv__change${ch.flat ? ' pv__change--flat' : ''}`}>{ch.arrow} {ch.text.replace(a.unit ? ` ${a.unit}` : '', '')}{ch.pct && ` (${ch.pct})`}</span>
      {n > 2 && <span className="pv__more">· {n - 1} earlier visits</span>}
    </div>
  );
}

function limits(b: { lo: number | null; hi: number | null }): string {
  if (b.lo != null && b.hi != null) return `${fmtNum(b.lo)} – ${fmtNum(b.hi)}`;
  if (b.hi != null) return `< ${fmtNum(b.hi)}`;
  if (b.lo != null) return `≥ ${fmtNum(b.lo)}`;
  return '';
}

const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

/** The key a report row or booklet analyte is looked up by: the panel code and the LIS's own name. */
export function trendKey(code: string | null | undefined, lisName: string | null | undefined): string {
  return `${norm(code)}|${norm(lisName)}`;
}

/** Every trend-worthy analyte with a drawable history, keyed by code and LIS name. */
export function trendIndex(trend: ResultTrendResponse | null | undefined): Map<string, TrendAnalyte> {
  const map = new Map<string, TrendAnalyte>();
  if (!trend) return map;
  const byKey = new Map<string, AnalyteTrend>(trend.analytes.map((a) => [a.testKey, a]));
  for (const t of buildTrend(trend.analytes)) {
    const src = byKey.get(t.key);
    if (!trendWorthy(src?.testName, src?.testCode)) continue;
    map.set(trendKey(src?.testCode, src?.testName), t);
  }
  return map;
}
