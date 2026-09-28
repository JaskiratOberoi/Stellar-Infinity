import type { AnalyteTrend, ResultTrendResponse } from '../api/client';
import { buildTrend, type Band, type TrendAnalyte } from '../lib/trendBands';
import '../trend.css';

/**
 * A parameter's trend, printed right under its row: the earlier visits as a
 * small line chart with the healthy band shaded behind it, the value over
 * each point, the date under it, and how the latest reading moved since the
 * one before.
 *
 * Built from the same history the worksheet's delta trend uses (name +
 * mobile + sex with an age check, see script 75) and the bands the row's
 * own reference text names (lib/trendBands). Colour is a light tint and a
 * teal line, chosen to survive a black-and-white print: the band is still
 * a lighter stripe, the line still dark, the flagged values still carry
 * the report's ▲▼ glyph.
 */

const W = 400;
const H = 60;
const PAD_L = 8;
const PAD_R = 8;
const TOP = 15;   // room for the value labels
const BOTTOM = 14; // room for the dates

const fmtDay = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso.slice(0, 10) : d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' });
};
const fmtNum = (n: number) => (Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2))));

/** The bands a value must sit in to count as healthy; the first one shades the chart. */
function healthyBand(bands: Band[]): Band | null {
  return bands.find((b) => b.healthy) ?? null;
}

export function TrendStrip({ a, compact = false }: { a: TrendAnalyte; compact?: boolean }) {
  const n = a.cells.length;
  if (n < 2) return null;
  const vals = a.cells.map((c) => c!.value);
  const hb = healthyBand(a.bands);
  // The scale covers the values and the healthy band's finite limits, with
  // a little air, so the band is always in frame beside the points.
  const finite = [...vals, ...(hb ? [hb.lo, hb.hi].filter((x): x is number => x != null) : [])];
  let min = Math.min(...finite), max = Math.max(...finite);
  if (max === min) { max += Math.abs(max) * 0.1 || 1; min -= Math.abs(min) * 0.1 || 1; }
  const air = (max - min) * 0.12;
  min -= air; max += air;
  const plotH = H - TOP - BOTTOM;
  const y = (v: number) => TOP + (1 - (v - min) / (max - min)) * plotH;
  const x = (i: number) => PAD_L + 22 + (i * (W - PAD_L - PAD_R - 44)) / (n - 1);

  const bandTop = hb ? (hb.hi != null ? y(hb.hi) : TOP) : null;
  const bandBot = hb ? (hb.lo != null ? y(hb.lo) : TOP + plotH) : null;
  const path = vals.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
  const last = a.cells[n - 1]!, prev = a.cells[n - 2]!;
  const delta = last.value - prev.value;
  const pct = Math.abs(prev.value) > 1e-9 ? (delta / Math.abs(prev.value)) * 100 : null;
  const flat = Math.abs(delta) < 1e-9;
  const arrow = flat ? '=' : delta > 0 ? '▲' : '▼';
  const off = (c: NonNullable<typeof last>) => (hb ? !a.bands[c.bandIndex].healthy : c.abnormal);
  const glyph = (c: NonNullable<typeof last>) => {
    if (!off(c)) return '';
    const hi = a.bands.findIndex((b) => b.healthy);
    return hi < 0 ? '' : c.bandIndex < hi ? '▲ ' : '▼ ';
  };

  return (
    <div className={`ts${compact ? ' ts--compact' : ''}`}>
      <svg viewBox={`0 0 ${W} ${H}`} className="ts__chart" role="img"
           aria-label={`${a.name}: ${a.cells.map((c, i) => `${fmtDay(a.columns[i].date)} ${c!.label}`).join(', ')}`}>
        {hb && bandTop != null && bandBot != null && (
          <g>
            <rect x={PAD_L} y={Math.min(bandTop, bandBot)} width={W - PAD_L - PAD_R} height={Math.max(2, Math.abs(bandBot - bandTop))} className="ts__band" />
            {hb.hi != null && <line x1={PAD_L} x2={W - PAD_R} y1={bandTop} y2={bandTop} className="ts__limit" />}
            {hb.lo != null && <line x1={PAD_L} x2={W - PAD_R} y1={bandBot} y2={bandBot} className="ts__limit" />}
          </g>
        )}
        <path d={path} className="ts__line" />
        {a.cells.map((c, i) => {
          const cx = x(i), cy = y(c!.value);
          const now = a.columns[i].isCurrent;
          return (
            <g key={i}>
              <circle cx={cx} cy={cy} r={now ? 4.2 : 3.2} className={now ? 'ts__dot ts__dot--now' : 'ts__dot'} />
              <text x={cx} y={cy - 7} textAnchor="middle" className={off(c!) ? 'ts__val ts__val--off' : 'ts__val'}>
                {glyph(c!)}{c!.label}
              </text>
              <text x={cx} y={H - 3} textAnchor="middle" className={now ? 'ts__date ts__date--now' : 'ts__date'}>
                {fmtDay(a.columns[i].date)}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="ts__meta">
        <span className={`ts__chip${flat ? ' ts__chip--flat' : ''}`}>
          <b>{arrow}</b> {flat ? 'no change' : `${delta > 0 ? '+' : '−'}${fmtNum(Math.abs(delta))}${a.unit ? ` ${a.unit}` : ''}`}
          {pct != null && !flat && <span className="ts__pct"> ({Math.abs(pct) >= 999 ? '>999' : fmtNum(Math.abs(pct))}%)</span>}
        </span>
        <span className="ts__note">
          since {fmtDay(a.columns[n - 2].date)} · {n} visits
          {hb && <> · shaded: {hb.label.toLowerCase()}{hb.lo != null || hb.hi != null ? ` (${hb.lo != null ? fmtNum(hb.lo) : ''}${hb.lo != null && hb.hi != null ? ' – ' : ''}${hb.hi != null ? (hb.lo != null ? fmtNum(hb.hi) : `< ${fmtNum(hb.hi)}`) : (hb.lo != null ? ' and up' : '')})` : ''}</>}
        </span>
      </div>
    </div>
  );
}

const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

/** The key a report row or booklet analyte is looked up by: the panel code and the LIS's own name. */
export function trendKey(code: string | null | undefined, lisName: string | null | undefined): string {
  return `${norm(code)}|${norm(lisName)}`;
}

/** Every analyte with a drawable history, keyed by code and LIS name. */
export function trendIndex(trend: ResultTrendResponse | null | undefined): Map<string, TrendAnalyte> {
  const map = new Map<string, TrendAnalyte>();
  if (!trend) return map;
  const byKey = new Map<string, AnalyteTrend>(trend.analytes.map((a) => [a.testKey, a]));
  for (const t of buildTrend(trend.analytes)) {
    const src = byKey.get(t.key);
    map.set(trendKey(src?.testCode, src?.testName), t);
  }
  return map;
}
