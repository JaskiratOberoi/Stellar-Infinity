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
 * scale — hatched below and above the band, clear within it — with a
 * pointer where the value sits, so the reader can see WHY that cell lit.
 * Beneath, the pattern's name and two or three sentences on what it usually
 * means, with the note that this is a guide to reading the numbers, not a
 * diagnosis.
 *
 * GREYSCALE by design: most reports leave the lab on a black-and-white
 * printer, so nothing here means anything by colour alone. In range and out
 * of range are told apart by weight, by the ▲▼ glyph the report already
 * uses, and by the hatching on the scales; the chosen cell by a heavy
 * border and a darker fill. Every text tone clears 7:1 on white (#595959 is
 * the lightest), so the small captions survive a light toner cartridge.
 * Pure SVG in the report's own type, so the print pipeline draws it exactly
 * as the screen does.
 */

const INK = '#111827';
const MUTED = '#3f3f46';
const FAINT = '#595959';
const LINE = '#9ca3af';
const CELL = '#fafafa';
const CELL_LINE = '#c4c7cd';
const HERE_FILL = '#e4e4e7';
const BAND_FILL = '#ffffff';

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
const glyph = (l: Level) => (l === 'high' ? '▲ ' : l === 'low' ? '▼ ' : '');

function RangeBar({ a, y }: { a: ThyroidAxis; y: number }) {
  // The scale shows the band with a margin of 60% of its width either side,
  // so an out-of-range marker still lands on the bar rather than off it.
  // TSH is the exception: an underactive thyroid can push it to 50 or 100,
  // so its scale runs to 100 — on a log axis, or the 0.35–5.50 band would
  // be a sliver at the left edge and a value of 8 indistinguishable from 80.
  const span = a.hi - a.lo;
  const tsh = a.label === 'TSH';
  const min = tsh ? 0.05 : Math.max(0, a.lo - span * 0.6);
  const max = tsh ? 100 : a.hi + span * 0.6;
  const f = (v: number) => (tsh ? Math.log10(v) : v);
  const px = (v: number) => BAR_X + ((f(Math.min(max, Math.max(min, v))) - f(min)) / (f(max) - f(min))) * BAR_W;
  const lo = px(a.lo);
  const hi = px(a.hi);
  const at = px(a.value);
  const barY = y + 9;
  const off = a.level !== 'normal';
  return (
    <g>
      <text x={BAR_X} y={y} fontSize="11" fontWeight="700" fill={INK}>{a.label}</text>
      <text x={BAR_X + BAR_W} y={y} fontSize="11" fontWeight={off ? 700 : 500} fill={INK} textAnchor="end">
        {glyph(a.level)}{a.text}{a.unit ? ` ${a.unit}` : ''}
        <tspan fontWeight="400" fill={MUTED}> · {levelWord(a.level)}</tspan>
      </text>
      {/* below the band · the band · above the band */}
      <rect x={BAR_X} y={barY} width={BAR_W} height={10} rx="5" fill="url(#tf-hatch)" />
      <rect x={lo} y={barY} width={Math.max(2, hi - lo)} height={10} fill={BAND_FILL} stroke={INK} strokeWidth="0.9" />
      <rect x={BAR_X} y={barY} width={BAR_W} height={10} rx="5" fill="none" stroke={LINE} strokeWidth="0.7" />
      {/* the marker: a pointer down onto the bar */}
      <path d={`M${at} ${barY + 1} l-4.5 -7 h9 z`} fill={INK} />
      <line x1={at} y1={barY} x2={at} y2={barY + 10} stroke={INK} strokeWidth="1.8" />
      <text x={lo} y={barY + 21} fontSize="8.5" fill={FAINT} textAnchor="middle">{a.lo}</text>
      <text x={hi} y={barY + 21} fontSize="8.5" fill={FAINT} textAnchor="middle">{a.hi}</text>
      {tsh && (
        <>
          <text x={px(100)} y={barY + 21} fontSize="8.5" fill={FAINT} textAnchor="end">100</text>
          <text x={BAR_X + 30} y={y} fontSize="8" fill={FAINT}>· log scale to 100</text>
        </>
      )}
    </g>
  );
}

const ROW_OF: Record<Level, 0 | 1 | 2> = { high: 0, normal: 1, low: 2 };

export function ThyroidFigure({ p }: { p: ThyroidPattern }) {
  const axes = [p.tsh, p.t4, ...(p.t3 ? [p.t3] : [])];
  const t3Row = p.t3 ? ROW_OF[p.t3.level] : null;

  return (
    <div className="lr__fig">
      <div className="lr__fig-head">
        <h3>Reading this thyroid profile</h3>
        <span>a guide to the pattern the results make, not a diagnosis</span>
      </div>
      <svg viewBox="0 0 700 262" role="img" aria-label={`Thyroid pattern: ${p.title}`}>
        <defs>
          {/* outside the band: a fine diagonal hatch, which survives any printer */}
          <pattern id="tf-hatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="5" height="5" fill="#f4f4f5" />
            <line x1="0" y1="0" x2="0" y2="5" stroke="#8a8f98" strokeWidth="1.2" />
          </pattern>
        </defs>

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
                      fill={here ? HERE_FILL : normal ? '#ffffff' : CELL}
                      stroke={here ? INK : normal ? MUTED : CELL_LINE}
                      strokeWidth={here ? 2.4 : normal ? 1 : 0.8}
                      strokeDasharray={normal && !here ? '3 2' : undefined} />
                {lines.map((l, i) => (
                  <text key={i} x={x + CELL_W / 2}
                        y={y + CELL_H / 2 + (i - (lines.length - 1) / 2) * 12 + (here ? 7 : 4)}
                        fontSize={here ? 10.5 : 9.5} fontWeight={here || normal ? 700 : 500}
                        fill={here || normal ? INK : MUTED} textAnchor="middle">
                    {l}
                  </text>
                ))}
                {here && (
                  <g>
                    <rect x={x + CELL_W / 2 - 31} y={y + 4} width={62} height={12} rx="6" fill={INK} />
                    <text x={x + CELL_W / 2} y={y + 12.8} fontSize="7.5" fontWeight="700" fill="#ffffff" textAnchor="middle">
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
                fontSize="9.5" fontWeight={i === p.col ? 700 : 500} fill={i === p.col ? INK : MUTED} textAnchor="middle">
            {i === p.col ? '▸ ' : ''}{t}
          </text>
        ))}
        <text x={GRID_X + 1.5 * CELL_W} y={GRID_Y + 3 * CELL_H + 27} fontSize="8.5" fill={FAINT} textAnchor="middle">
          TSH — the pituitary’s signal to the thyroid →
        </text>

        {/* T4 down the left, T3 down the right: the two hormones the thyroid makes */}
        {(['T4 high', 'T4 normal', 'T4 low'] as const).map((t, i) => (
          <text key={t} x={GRID_X - 8} y={GRID_Y + i * CELL_H + CELL_H / 2 + 3.5}
                fontSize="9.5" fontWeight={i === p.row ? 700 : 500} fill={i === p.row ? INK : MUTED} textAnchor="end">
            {t}{i === p.row ? ' ▸' : ''}
          </text>
        ))}
        <text x={2} y={GRID_Y - 9} fontSize="8.5" fill={FAINT}>↑ T4 — what the thyroid makes</text>
        {p.t3 && (
          <>
            {(['T3 high', 'T3 normal', 'T3 low'] as const).map((t, i) => (
              <text key={t} x={GRID_R + 8} y={GRID_Y + i * CELL_H + CELL_H / 2 + 3.5}
                    fontSize="9.5" fontWeight={i === t3Row ? 700 : 500} fill={i === t3Row ? INK : MUTED}>
                {i === t3Row ? '◂ ' : ''}{t}
              </text>
            ))}
            <text x={GRID_R + 8} y={GRID_Y - 9} fontSize="8.5" fill={FAINT}>↑ T3 — usually moves with T4</text>
          </>
        )}

        {/* ── the scales ── */}
        {axes.map((a, i) => <RangeBar key={a.label} a={a} y={GRID_Y + 4 + i * 50} />)}
        <text x={BAR_X} y={GRID_Y + 4 + axes.length * 50 - 6} fontSize="8.5" fill={FAINT}>
          clear: within the reference band · hatched: below or above it
        </text>

        {/* ── the reading ── */}
        <line x1={0} y1={236} x2={700} y2={236} stroke={LINE} strokeWidth="0.8" />
        <rect x={0} y={243} width={6} height={14} rx="1.5" fill={INK} />
        <text x={12} y={254.5} fontSize="11.5" fontWeight="700" fill={INK}>
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
