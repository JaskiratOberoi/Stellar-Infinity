import type { Level, ThyroidAxis, ThyroidPattern } from '../lib/thyroidPattern';

/**
 * "Reading this thyroid profile" — the figure printed under a thyroid
 * profile's rows in the standard report.
 *
 * A modern reading of the classic TSH-against-T4 teaching square: the same
 * axes as a plain three-by-three grid, TSH low / normal / high across, T4
 * high / normal / low down, with T3 on the right-hand side of the grid
 * where the original drew it — the two thyroid hormones usually move
 * together, so the T3 level is marked on the same rows. Each cell is named
 * in everyday words and the patient's cell is picked out and tagged; no
 * dot, the cell itself is the answer. Beside it, each hormone on its own
 * scale — a red stretch below the band, the green band, a red stretch above
 * — with a marker where the value sits, so the reader can see WHY that cell
 * lit. Beneath, the pattern's name and two or three sentences on what it
 * usually means, with the note that this is a guide to reading the numbers,
 * not a diagnosis.
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
const GREEN_FAINT = '#f0fdf4';
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

const GRID_X = 74;
const GRID_Y = 24;
const CELL_W = 88;
const CELL_H = 58;
const GRID_R = GRID_X + 3 * CELL_W;

const BAR_X = 440;
const BAR_W = 250;

const levelWord = (l: Level) => (l === 'normal' ? 'within range' : l === 'high' ? 'above range' : 'below range');
const levelColor = (l: Level) => (l === 'normal' ? GREEN : RED);

function RangeBar({ a, y }: { a: ThyroidAxis; y: number }) {
  // The scale shows the band with a margin of 60% of its width either side,
  // so an out-of-range marker still lands on the bar rather than off it.
  const span = a.hi - a.lo;
  const min = Math.max(0, a.lo - span * 0.6);
  const max = a.hi + span * 0.6;
  const px = (v: number) => BAR_X + ((Math.min(max, Math.max(min, v)) - min) / (max - min)) * BAR_W;
  const c = levelColor(a.level);
  const lo = px(a.lo);
  const hi = px(a.hi);
  const at = px(a.value);
  const barY = y + 9;
  return (
    <g>
      <text x={BAR_X} y={y} fontSize="11" fontWeight="700" fill={INK}>{a.label}</text>
      <text x={BAR_X + BAR_W} y={y} fontSize="11" fontWeight="700" fill={c} textAnchor="end">
        {a.text}{a.unit ? ` ${a.unit}` : ''}
        <tspan fontWeight="400" fill={MUTED}> · {levelWord(a.level)}</tspan>
      </text>
      {/* below the band · the band · above the band */}
      <rect x={BAR_X} y={barY} width={BAR_W} height={9} rx="4.5" fill={RED_SOFT} />
      <rect x={lo} y={barY} width={Math.max(2, hi - lo)} height={9} fill={GREEN_SOFT} />
      <rect x={BAR_X} y={barY} width={BAR_W} height={9} rx="4.5" fill="none" stroke={LINE} strokeWidth="0.6" />
      {/* the marker: a pointer down onto the bar */}
      <path d={`M${at} ${barY + 1} l-4.5 -7 h9 z`} fill={c} />
      <line x1={at} y1={barY} x2={at} y2={barY + 9} stroke={c} strokeWidth="1.6" />
      <text x={lo} y={barY + 20} fontSize="8.5" fill={FAINT} textAnchor="middle">{a.lo}</text>
      <text x={hi} y={barY + 20} fontSize="8.5" fill={FAINT} textAnchor="middle">{a.hi}</text>
    </g>
  );
}

const ROW_OF: Record<Level, 0 | 1 | 2> = { high: 0, normal: 1, low: 2 };

export function ThyroidFigure({ p }: { p: ThyroidPattern }) {
  const c = p.ok ? GREEN : RED;
  const axes = [p.tsh, p.t4, ...(p.t3 ? [p.t3] : [])];
  const t3Row = p.t3 ? ROW_OF[p.t3.level] : null;
  const t3c = p.t3 ? levelColor(p.t3.level) : MUTED;

  return (
    <div className="lr__fig">
      <div className="lr__fig-head">
        <h3>Reading this thyroid profile</h3>
        <span>a guide to the pattern the results make, not a diagnosis</span>
      </div>
      <svg viewBox="0 0 700 262" role="img" aria-label={`Thyroid pattern: ${p.title}`}>
        {/* ── the grid ── */}
        {CELL_LABELS.map((rowLabels, r) =>
          rowLabels.map((lines, col) => {
            const here = r === p.row && col === p.col;
            const normal = r === 1 && col === 1;
            const x = GRID_X + col * CELL_W;
            const y = GRID_Y + r * CELL_H;
            return (
              <g key={`${r}${col}`}>
                <rect x={x + 1} y={y + 1} width={CELL_W - 2} height={CELL_H - 2} rx="5"
                      fill={here ? (p.ok ? GREEN_SOFT : RED_SOFT) : normal ? GREEN_FAINT : CELL}
                      stroke={here ? c : CELL_LINE} strokeWidth={here ? 2 : 0.8} />
                {lines.map((l, i) => (
                  <text key={i} x={x + CELL_W / 2}
                        y={y + CELL_H / 2 + (i - (lines.length - 1) / 2) * 12 + (here ? 7 : 4)}
                        fontSize={here ? 10.5 : 9.5} fontWeight={here ? 700 : 500}
                        fill={here ? c : normal ? GREEN : MUTED} textAnchor="middle">
                    {l}
                  </text>
                ))}
                {here && (
                  <g>
                    <rect x={x + CELL_W / 2 - 31} y={y + 4} width={62} height={12} rx="6" fill="#fff" stroke={c} strokeWidth="0.9" />
                    <text x={x + CELL_W / 2} y={y + 12.8} fontSize="7.5" fontWeight="700" fill={c} textAnchor="middle">
                      THIS RESULT
                    </text>
                  </g>
                )}
              </g>
            );
          }))}

        {/* TSH across the bottom */}
        {(['TSH low', 'TSH normal', 'TSH high'] as const).map((t, i) => (
          <text key={t} x={GRID_X + i * CELL_W + CELL_W / 2} y={GRID_Y + 3 * CELL_H + 14}
                fontSize="9.5" fontWeight={i === p.col ? 700 : 500} fill={i === p.col ? c : MUTED} textAnchor="middle">
            {t}
          </text>
        ))}
        <text x={GRID_X + 1.5 * CELL_W} y={GRID_Y + 3 * CELL_H + 27} fontSize="8.5" fill={FAINT} textAnchor="middle">
          TSH — the pituitary’s signal to the thyroid →
        </text>

        {/* T4 down the left, T3 down the right: the two hormones the thyroid makes */}
        {(['T4 high', 'T4 normal', 'T4 low'] as const).map((t, i) => (
          <text key={t} x={GRID_X - 8} y={GRID_Y + i * CELL_H + CELL_H / 2 + 3.5}
                fontSize="9.5" fontWeight={i === p.row ? 700 : 500} fill={i === p.row ? c : MUTED} textAnchor="end">
            {t}
          </text>
        ))}
        <text x={2} y={GRID_Y - 9} fontSize="8.5" fill={FAINT}>↑ T4 — what the thyroid makes</text>
        {p.t3 && (
          <>
            {(['T3 high', 'T3 normal', 'T3 low'] as const).map((t, i) => (
              <text key={t} x={GRID_R + 8} y={GRID_Y + i * CELL_H + CELL_H / 2 + 3.5}
                    fontSize="9.5" fontWeight={i === t3Row ? 700 : 500} fill={i === t3Row ? t3c : MUTED}>
                {i === t3Row ? '◀ ' : ''}{t}
              </text>
            ))}
            <text x={GRID_R + 8} y={GRID_Y - 9} fontSize="8.5" fill={FAINT}>↑ T3 — usually moves with T4</text>
          </>
        )}

        {/* ── the scales ── */}
        {axes.map((a, i) => <RangeBar key={a.label} a={a} y={GRID_Y + 4 + i * 50} />)}
        <text x={BAR_X} y={GRID_Y + 4 + axes.length * 50 - 6} fontSize="8.5" fill={FAINT}>
          green: within the reference band · red: below or above it
        </text>

        {/* ── the reading ── */}
        <line x1={0} y1={236} x2={700} y2={236} stroke={LINE} strokeWidth="0.8" />
        <rect x={0} y={243} width={6} height={14} rx="1.5" fill={c} />
        <text x={12} y={254.5} fontSize="11.5" fontWeight="700" fill={c}>
          Pattern: {p.title}
        </text>
      </svg>
      <p className="lr__fig-text">{p.meaning}</p>
      <p className="lr__fig-note">
        Read from TSH and {p.t4.label} against the reference bands printed above, with {p.t3 ? `${p.t3.label} alongside` : 'T3 where measured'};
        medicines, pregnancy and recent illness all change the reading. Your doctor interprets it with the clinical picture.
      </p>
    </div>
  );
}
