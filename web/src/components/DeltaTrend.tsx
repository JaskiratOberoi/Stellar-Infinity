import { useMemo, useState } from 'react';
import type { AnalyteTrend, TrendMatch, TrendPoint } from '../api/client';
import { fmtDateTime } from '../lib/format';

/**
 * Per-parameter delta trends for one sample.
 *
 * The legacy LIS shows a result as a number on a page: whether a creatinine of
 * 1.4 is this patient's normal or a doubling since March is a question it cannot
 * answer without someone pulling old reports by hand. That comparison is where
 * most of the clinical signal lives, so it belongs beside the value.
 *
 * The identity caveat is rendered, never hidden. Prior visits are matched on
 * name + mobile + gender with an age-plausibility check (see
 * 75_usp_inf_result_history.sql for the measurements behind that choice), and a
 * reader can only judge a trend if they can see how its points were gathered.
 */
export function DeltaTrend({ analytes, match }: { analytes: AnalyteTrend[]; match: TrendMatch }) {
  return (
    <div>
      <MatchNote match={match} />

      {analytes.length === 0 ? (
        <div className="muted" style={{ textAlign: 'center', padding: '2rem', fontSize: '.82rem' }}>
          No previous numeric results to compare against.
        </div>
      ) : (
        <div className="trend-grid">
          {analytes.map((a) => (
            <AnalyteCard key={a.testKey} analyte={a} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * States the basis for the comparison in plain words.
 *
 * The `hasMobile: false` case matters most: most registrations carry no mobile
 * number, so an empty trend is usually a missing identifier rather than a
 * patient who has never been tested. Saying nothing here would let an operator
 * read absence as reassurance.
 */
function MatchNote({ match }: { match: TrendMatch }) {
  if (!match.hasMobile) {
    return (
      <div className="alert alert--info" style={{ fontSize: '.76rem' }}>
        This registration has no mobile number recorded, so previous visits cannot be identified.
        Only results from this visit are shown — <b>the patient may well have been tested before</b>.
      </div>
    );
  }

  if (match.priorVisits === 0) {
    return (
      <p className="muted" style={{ fontSize: '.76rem' }}>
        No earlier visit matched on name, mobile and gender. Only this visit is shown.
      </p>
    );
  }

  return (
    <p className="muted" style={{ fontSize: '.76rem' }}>
      Comparing against <b>{match.priorVisits}</b> earlier {match.priorVisits === 1 ? 'visit' : 'visits'},
      matched on name + mobile + gender with an age check. A shared family phone can still
      look like one person — check the dates before acting on a trend.
    </p>
  );
}

function AnalyteCard({ analyte }: { analyte: AnalyteTrend }) {
  const series = useMemo(() => numericSeries(analyte.points), [analyte.points]);
  if (series.length < 2) return null;

  const latest = series[series.length - 1];
  const previous = series[series.length - 2];
  const delta = latest.n - previous.n;
  // Percentage is the more useful reading for most analytes, but it is
  // undefined against a zero baseline and misleading near it.
  const pct = Math.abs(previous.n) > 1e-9 ? (delta / Math.abs(previous.n)) * 100 : null;

  return (
    <div className="trend-card">
      <div className="trend-card__head">
        <div className="trend-card__name" title={analyte.testName ?? analyte.testCode ?? analyte.testKey}>
          {analyte.testName ?? analyte.testCode ?? analyte.testKey}
        </div>
        <DeltaChip delta={delta} pct={pct} />
      </div>

      <Sparkline series={series} />

      <div className="trend-card__foot">
        <span className="mono">
          {previous.label} → <b>{latest.label}</b>
        </span>
        {analyte.unit && <span className="muted"> {analyte.unit}</span>}
      </div>
    </div>
  );
}

function DeltaChip({ delta, pct }: { delta: number; pct: number | null }) {
  // No clinical direction is implied — an analyte going up is not inherently
  // worse, and colouring it red would be the graph telling the reader what to
  // think. Only "unchanged" is given a neutral treatment.
  const flat = Math.abs(delta) < 1e-9;
  const arrow = flat ? '=' : delta > 0 ? '▲' : '▼';
  const magnitude = flat ? 'no change' : `${delta > 0 ? '+' : '−'}${fmtNum(Math.abs(delta))}`;

  return (
    <span className={`trend-chip${flat ? ' trend-chip--flat' : ''}`}>
      <span className="trend-chip__arrow">{arrow}</span>
      {magnitude}
      {pct !== null && !flat && (
        <span className="muted"> ({Math.abs(pct) >= 999 ? '>999' : fmtNum(Math.abs(pct))}%)</span>
      )}
    </span>
  );
}

interface Pt { n: number; label: string; at: string | null; isCurrent: boolean; sid: string | null }

function Sparkline({ series }: { series: Pt[] }) {
  const [hover, setHover] = useState<number | null>(null);

  const W = 240, H = 56, PAD = 8;
  const values = series.map((p) => p.n);
  const min = Math.min(...values);
  const max = Math.max(...values);
  // A flat series has no range to scale into; centre it rather than dividing
  // by zero and sending every point to NaN.
  const span = max - min || Math.abs(max) || 1;
  const lo = max === min ? min - span / 2 : min;

  const x = (i: number) => PAD + (i * (W - PAD * 2)) / Math.max(1, series.length - 1);
  const y = (n: number) => H - PAD - ((n - lo) / (max === min ? span : max - min)) * (H - PAD * 2);

  const path = series.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.n).toFixed(1)}`).join(' ');
  const active = hover !== null ? series[hover] : null;

  return (
    <div className="trend-spark">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height={H}
        role="img"
        aria-label={`Trend: ${series.map((p) => p.label).join(', ')}`}
        onMouseLeave={() => setHover(null)}
      >
        <path d={path} className="trend-spark__line" />

        {series.map((p, i) => (
          <g key={`${p.sid ?? i}-${i}`}>
            <circle
              cx={x(i)}
              cy={y(p.n)}
              r={p.isCurrent ? 3.6 : 2.4}
              className={`trend-spark__dot${p.isCurrent ? ' trend-spark__dot--current' : ''}`}
            />
            {/* A wide invisible target: the dots are far too small to hit. */}
            <rect
              x={x(i) - (W / series.length) / 2}
              y={0}
              width={W / series.length}
              height={H}
              fill="transparent"
              onMouseEnter={() => setHover(i)}
            />
          </g>
        ))}
      </svg>

      <div className="trend-spark__caption muted">
        {active ? (
          <>
            <b className="mono">{active.label}</b>
            {' · '}
            {active.at ? fmtDateTime(active.at) : 'date unknown'}
            {active.isCurrent && ' · this sample'}
          </>
        ) : (
          `${series.length} results`
        )}
      </div>
    </div>
  );
}

/**
 * Keeps only points that parse as numbers and are in chronological order.
 *
 * The procedure already filters to numeric values, but the label shown to the
 * reader is the value as it was RECORDED — reformatting a stored "1.40" to
 * "1.4" would make the screen disagree with the report.
 */
function numericSeries(points: TrendPoint[]): Pt[] {
  return points
    .map((p) => {
      const raw = (p.value ?? '').trim();
      const n = Number(raw);
      return Number.isFinite(n) && raw !== ''
        ? { n, label: raw, at: p.drawnAt, isCurrent: p.isCurrent, sid: p.sid }
        : null;
    })
    .filter((p): p is Pt => p !== null);
}

/** Two decimals at most, and no trailing zeros — deltas are read, not audited. */
function fmtNum(n: number): string {
  if (n >= 100) return n.toFixed(0);
  if (n >= 1) return String(Number(n.toFixed(2)));
  return String(Number(n.toPrecision(2)));
}
