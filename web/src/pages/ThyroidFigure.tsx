import type { Level, ThyroidAxis, ThyroidPattern } from '../lib/thyroidPattern';

/**
 * "Reading this thyroid profile" — the figure printed under a thyroid
 * profile's rows in the standard report.
 *
 * A modern reading of the classic TSH-against-T4 teaching square: the same
 * two axes as a plain three-by-three grid, TSH low / normal / high across,
 * T4 high / normal / low down, each cell named in everyday words, the
 * patient's cell picked out and their dot placed inside it by how far the
 * two values sit from their bands. Beside it, each hormone on its own
 * reference band — value, band, and a marker — so the reader can see WHY
 * the dot landed where it did. Beneath, the pattern's name and two or three
 * sentences on what it usually means, with the note that this is a guide to
 * reading the numbers, not a diagnosis.
 *
 * Pure SVG in the report's own type, so the print pipeline draws it exactly
 * as the screen does; no image, no font of its own. Colours are the
 * report's: green for in range, the abnormal red for out of it.
 */

const INK = '#111827';
const MUTED = '#4b5563';
const FAINT = '#9ca3af';
const LINE = '#d1d5db';
const GREEN = '#15803d';
const GREEN_SOFT = '#dcfce7';
const RED = '#b91c1c';
const RED_SOFT = '#fee2e2';
const CELL = '#f9fafb';
const CELL_LINE = '#e5e7eb';

/* The grid's short labels, [row (T4 high→low)][col (TSH low→high)]. */
const CELL_LABELS: string[][][] = [
  [['Overactive'], ['High T4,', 'normal TSH'], ['Unusual —', 'needs review']],
  [['Mildly', 'overactive'], ['Normal'], ['Mildly', 'underactive']],
  [['Low TSH', 'and low T4'], ['Low T4,', 'normal TSH'], ['Underactive']],
];

const GRID_X = 78;
const GRID_Y = 22;
const CELL_W = 88;
const CELL_H = 58;

/** Where a value sits across its cell: inside the band by proportion; beyond it, by how far. */
function within(a: ThyroidAxis): number {
  const span = a.hi - a.lo;
  if (a.level === 'normal') return clamp((a.value - a.lo) / span);
  if (a.level === 'high') return clamp((a.value - a.hi) / span);
  return clamp(1 - (a.lo - a.value) / span);
}
const clamp = (n: number) => Math.max(0.08, Math.min(0.92, n));

const levelWord = (l: Level) => (l === 'normal' ? 'within range' : l === 'high' ? 'above range' : 'below range');
const levelColor = (l: Level) => (l === 'normal' ? GREEN : RED);

function RangeBar({ a, y }: { a: ThyroidAxis; y: number }) {
  // The scale shows the band with a margin of 60% of its width either side,
  // so an out-of-range marker still lands on the bar rather than off it.
  const span = a.hi - a.lo;
  const min = Math.max(0, a.lo - span * 0.6);
  const max = a.hi + span * 0.6;
  const x0 = 392;
  const w = 296;
  const px = (v: number) => x0 + ((Math.min(max, Math.max(min, v)) - min) / (max - min)) * w;
  const c = levelColor(a.level);
  return (
    <g>
      <text x={x0} y={y} fontSize="11" fontWeight="700" fill={INK}>{a.label}</text>
      <text x={x0 + w} y={y} fontSize="11" fontWeight="700" fill={c} textAnchor="end">
        {a.text}{a.unit ? ` ${a.unit}` : ''}
        <tspan fontWeight="400" fill={MUTED}> · {levelWord(a.level)}</tspan>
      </text>
      <rect x={x0} y={y + 7} width={w} height={8} rx="4" fill="#eef0f3" />
      <rect x={px(a.lo)} y={y + 7} width={Math.max(2, px(a.hi) - px(a.lo))} height={8} rx="4" fill={GREEN_SOFT} stroke={GREEN} strokeWidth="0.8" />
      <circle cx={px(a.value)} cy={y + 11} r="5" fill="#fff" stroke={c} strokeWidth="2.4" />
      <text x={px(a.lo)} y={y + 27} fontSize="8.5" fill={FAINT} textAnchor="middle">{a.lo}</text>
      <text x={px(a.hi)} y={y + 27} fontSize="8.5" fill={FAINT} textAnchor="middle">{a.hi}</text>
    </g>
  );
}

export function ThyroidFigure({ p }: { p: ThyroidPattern }) {
  const c = p.ok ? GREEN : RED;
  const dotX = GRID_X + p.col * CELL_W + within(p.tsh) * CELL_W;
  // T4 runs upward: a higher value sits higher in the cell.
  const dotY = GRID_Y + p.row * CELL_H + (1 - within(p.t4)) * CELL_H;
  const axes = [p.tsh, p.t4, ...(p.t3 ? [p.t3] : [])];

  return (
    <div className="lr__fig">
      <div className="lr__fig-head">
        <h3>Reading this thyroid profile</h3>
        <span>a guide to the pattern the results make, not a diagnosis</span>
      </div>
      <svg viewBox="0 0 700 256" role="img" aria-label={`Thyroid pattern: ${p.title}`}>
        {/* ── the grid ── */}
        {CELL_LABELS.map((rowLabels, r) =>
          rowLabels.map((lines, col) => {
            const here = r === p.row && col === p.col;
            const normal = r === 1 && col === 1;
            const x = GRID_X + col * CELL_W;
            const y = GRID_Y + r * CELL_H;
            return (
              <g key={`${r}${col}`}>
                <rect x={x} y={y} width={CELL_W} height={CELL_H}
                      fill={here ? (p.ok ? GREEN_SOFT : RED_SOFT) : normal ? '#f0fdf4' : CELL}
                      stroke={here ? c : CELL_LINE} strokeWidth={here ? 2 : 0.8} />
                {lines.map((l, i) => (
                  // A white halo keeps the label legible where the patient's dot lands on it.
                  <text key={i} x={x + CELL_W / 2} y={y + CELL_H / 2 + (i - (lines.length - 1) / 2) * 12 + 4}
                        fontSize={here ? 10.5 : 9.5} fontWeight={here ? 700 : 500}
                        fill={here ? c : normal ? GREEN : MUTED} textAnchor="middle"
                        paintOrder="stroke" stroke={here ? '#fff' : 'none'} strokeWidth={here ? 3 : 0} strokeLinejoin="round">
                    {l}
                  </text>
                ))}
              </g>
            );
          }))}

        {/* axis captions */}
        {(['TSH low', 'TSH normal', 'TSH high'] as const).map((t, i) => (
          <text key={t} x={GRID_X + i * CELL_W + CELL_W / 2} y={GRID_Y + 3 * CELL_H + 14}
                fontSize="9.5" fontWeight={i === p.col ? 700 : 500} fill={i === p.col ? c : MUTED} textAnchor="middle">
            {t}
          </text>
        ))}
        <text x={GRID_X + 1.5 * CELL_W} y={GRID_Y + 3 * CELL_H + 27} fontSize="8.5" fill={FAINT} textAnchor="middle">
          the pituitary’s signal to the thyroid →
        </text>
        {(['T4 high', 'T4 normal', 'T4 low'] as const).map((t, i) => (
          <text key={t} x={GRID_X - 8} y={GRID_Y + i * CELL_H + CELL_H / 2 + 3.5}
                fontSize="9.5" fontWeight={i === p.row ? 700 : 500} fill={i === p.row ? c : MUTED} textAnchor="end">
            {t}
          </text>
        ))}
        <text x={2} y={GRID_Y - 8} fontSize="8.5" fill={FAINT}>↑ what the thyroid makes</text>

        {/* the patient */}
        <circle cx={dotX} cy={dotY} r="9" fill={c} fillOpacity="0.18" />
        <circle cx={dotX} cy={dotY} r="4.5" fill={c} stroke="#fff" strokeWidth="1.6" />

        {/* ── the bands ── */}
        {axes.map((a, i) => <RangeBar key={a.label} a={a} y={GRID_Y + 6 + i * 44} />)}
        <text x={392} y={GRID_Y + 6 + axes.length * 44 - 6} fontSize="8.5" fill={FAINT}>
          each hormone on its own scale; the green stretch is its reference band
        </text>

        {/* ── the reading ── */}
        <line x1={0} y1={232} x2={700} y2={232} stroke={LINE} strokeWidth="0.8" />
        <text x={0} y={249} fontSize="11.5" fontWeight="700" fill={c}>
          Pattern: {p.title}
        </text>
      </svg>
      <p className="lr__fig-text">{p.meaning}</p>
      <p className="lr__fig-note">
        Read from TSH and {p.t4.label} against the reference bands printed above; T3, medicines, pregnancy and
        recent illness all change the reading. Your doctor interprets it with the clinical picture.
      </p>
    </div>
  );
}
