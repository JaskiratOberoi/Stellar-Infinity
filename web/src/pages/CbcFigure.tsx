import type { CbcAxis, CbcPattern, Level } from '../lib/cbcPattern';

/**
 * "Reading this CBC" — the figure printed under a Complete Blood Count's
 * rows in the standard report, the blood-count counterpart of
 * ThyroidFigure.
 *
 * Three cards across, one per family of the count, each in its own colour
 * as the lab's reference layout has them: RED CELLS in crimson — a
 * three-by-three grid, MCV low / normal / high across and haemoglobin
 * normal / low / high down, each cell named for the pattern it is and the
 * patient's cell picked out and tagged; WHITE CELLS in blue — the same
 * grid, which kind predominates across and the total count high / normal /
 * low down; PLATELETS in green — the count on its reference band, and MPV
 * below it where the lab reports one. The grid axes carry the patient's
 * OWN reference limits, read off the rows above, so the figure can never
 * disagree with the ▲▼ flags beside the numbers. Under each grid, the
 * pattern's name and a few sentences on what it usually means; under all
 * three, one line that puts them together in a navy "Final CBC
 * Interpretation" strip, and the standing notes.
 *
 * Colour carries the theme, never the meaning: in range and out of range
 * are still told apart by weight, by the ▲▼ glyph and by the band on the
 * scales, and the chosen cell by its tag and heavy border, so a
 * black-and-white printer loses nothing but the tint.
 */

interface Theme { ink: string; soft: string; line: string; mid: string }
const RED: Theme = { ink: '#c0182f', soft: '#fff3f4', line: '#f1b8c1', mid: '#e5a0ab' };
const BLUE: Theme = { ink: '#1d4ed8', soft: '#eef4ff', line: '#b9cdf5', mid: '#9ab7ee' };
const GREEN: Theme = { ink: '#15803d', soft: '#f0fdf4', line: '#b7e4c4', mid: '#86cfa0' };
const INK = '#111827';
const MUTED = '#3f3f46';

/* Red-cell grid labels, [row (Hb normal / low / high)][col (MCV low / normal / high)]. */
const RED_CELLS: string[][][] = [
  [['Microcytosis', '(without anaemia)'], ['Normal', 'red-cell profile'], ['Macrocytosis', '(without anaemia)']],
  [['Microcytic', 'anaemia'], ['Normocytic', 'anaemia'], ['Macrocytic', 'anaemia']],
  [['Raised Hb,', 'small cells'], ['Raised Hb', '(erythrocytosis)'], ['Raised Hb,', 'large cells']],
];
/* White-cell grid labels, [row (TLC high / normal / low)][col (neutrophils / balanced / lymphocytes)]. */
const WHITE_CELLS: string[][][] = [
  [['Neutrophil-', 'predominant', 'leukocytosis'], ['Mixed', 'leukocytosis'], ['Lymphocytosis', '(viral / other)']],
  [['Relative', 'neutrophilia'], ['Normal', 'white cells'], ['Relative', 'lymphocytosis']],
  [['Leukopenia', 'with lymphopenia'], ['Leukopenia'], ['Leukopenia', 'with neutropenia']],
];

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10));
const glyph = (l: Level) => (l === 'high' ? '▲ ' : l === 'low' ? '▼ ' : '');
const levelWord = (l: Level) => (l === 'normal' ? 'within range' : l === 'high' ? 'above range' : 'below range');

const HEAD_W = 58;
/* Five percent more room than the labels first had, so "(without anaemia)"
   and "Lymphocytosis" sit inside their cells (asked 07/10/2026). */
const CELL_W = 63;
const CELL_H = 44;
const GRID_W = HEAD_W + 3 * CELL_W;
const GRID_H = 24 + 3 * CELL_H;

/** The three-by-three pattern grid, in a card's colour. */
function Grid({
  t, labels, colHeads, rowHeads, col, row, normalRow, normalCol,
}: {
  t: Theme; labels: string[][][]; colHeads: string[][]; rowHeads: string[][];
  col: 0 | 1 | 2; row: 0 | 1 | 2; normalRow: number; normalCol: number;
}) {
  return (
    <svg viewBox={`0 0 ${GRID_W} ${GRID_H}`} className="lr__cbc-grid" role="img" aria-label="pattern grid">
      {colHeads.map((lines, c) => lines.map((l, li) => (
        <text key={`${c}${li}`} x={HEAD_W + c * CELL_W + CELL_W / 2} y={9 + li * 9}
              fontSize={li === 0 ? 8.4 : 7.4} fontWeight={li === 0 ? 700 : 500} fill={c === col ? INK : MUTED} textAnchor="middle">
          {l}
        </text>
      )))}
      {rowHeads.map((lines, r) => lines.map((l, li) => (
        <text key={`${r}${li}`} x={HEAD_W - 5} y={24 + r * CELL_H + CELL_H / 2 - 2 + li * 9}
              fontSize={li === 0 ? 8.4 : 7.4} fontWeight={li === 0 ? 700 : 500} fill={r === row ? INK : MUTED} textAnchor="end">
          {l}
        </text>
      )))}
      {labels.map((rowLabels, r) => rowLabels.map((lines, c) => {
        const here = r === row && c === col;
        const normal = r === normalRow && c === normalCol;
        const x = HEAD_W + c * CELL_W;
        const y = 24 + r * CELL_H;
        return (
          <g key={`${r}${c}`}>
            <rect x={x + 1} y={y + 1} width={CELL_W - 2} height={CELL_H - 2} rx="4"
                  fill={here ? '#ffffff' : normal ? '#ffffff' : t.soft}
                  stroke={here ? t.ink : t.line}
                  strokeWidth={here ? 2 : 0.8} />
            {lines.map((l, i) => (
              <text key={i} x={x + CELL_W / 2}
                    y={y + CELL_H / 2 + (i - (lines.length - 1) / 2) * 8.6 + (here ? 6 : 3)}
                    fontSize={here ? 7.6 : 7.1} fontWeight={here ? 700 : normal ? 600 : 500}
                    fill={here ? t.ink : INK} textAnchor="middle">
                {l}
              </text>
            ))}
            {here && (
              <g>
                <rect x={x + CELL_W / 2 - 23} y={y + 3} width={46} height={9} rx="2" fill={t.ink} />
                <text x={x + CELL_W / 2} y={y + 9.8} fontSize="5.8" fontWeight="700" fill="#ffffff" textAnchor="middle">
                  THIS RESULT
                </text>
              </g>
            )}
          </g>
        );
      }))}
    </svg>
  );
}

/** A value on its reference band: grey track, green band, dark marker. */
function Gauge({ a, t }: { a: CbcAxis; t: Theme }) {
  const W = 176;
  const span = a.hi - a.lo;
  const min = Math.max(0, a.lo - span * 0.55);
  const max = a.hi + span * 0.55;
  const px = (v: number) => 8 + ((Math.min(max, Math.max(min, v)) - min) / (max - min)) * (W - 16);
  const lo = px(a.lo);
  const hi = px(a.hi);
  const at = px(a.value);
  const off = a.level !== 'normal';
  const unit = (a.unit ?? '').replace(/10\^3/g, '×10³').replace(/10\^6/g, '×10⁶').replace(/x1000/i, '×10³');
  return (
    <svg viewBox={`0 0 ${W} 54`} className="lr__cbc-gauge" role="img" aria-label={`${a.label} ${a.text}`}>
      <text x={0} y={9} fontSize="8.8" fontWeight="700" fill={INK}>{a.label}</text>
      <text x={at} y={22} fontSize="8" fontWeight={off ? 700 : 600} fill={INK} textAnchor={at < 40 ? 'start' : at > W - 40 ? 'end' : 'middle'}>
        {glyph(a.level)}{a.text}{unit ? ` ${unit}` : ''}
        <tspan fontWeight="400" fill={MUTED}> · {levelWord(a.level)}</tspan>
      </text>
      <rect x={8} y={30} width={W - 16} height={9} rx="4.5" fill="#e5e7eb" />
      <rect x={lo} y={30} width={Math.max(2, hi - lo)} height={9} fill={t.mid} />
      <rect x={8} y={30} width={W - 16} height={9} rx="4.5" fill="none" stroke="#cbd5e1" strokeWidth="0.7" />
      <path d={`M${at} ${31} l-4 -6 h8 z`} fill={INK} />
      <line x1={at} y1={30} x2={at} y2={39} stroke={INK} strokeWidth="1.6" />
      <text x={lo} y={50} fontSize="7.8" fill={MUTED} textAnchor="middle">{fmt(a.lo)}</text>
      <text x={hi} y={50} fontSize="7.8" fill={MUTED} textAnchor="middle">{fmt(a.hi)}</text>
    </svg>
  );
}

/* ---- the illustrations: a few cells, drawn simply ---------------------- */

function RedCells({ size = 44 }: { size?: number }) {
  const disc = (cx: number, cy: number, r: number) => (
    <g>
      <circle cx={cx} cy={cy} r={r} fill="#e3414f" />
      <circle cx={cx} cy={cy} r={r * 0.55} fill="#f28c95" />
      <circle cx={cx} cy={cy} r={r * 0.3} fill="#e3414f" />
    </g>
  );
  return (
    <svg viewBox="0 0 60 44" width={size} height={size * 44 / 60} aria-hidden="true">
      {disc(16, 15, 12)}
      {disc(40, 26, 13)}
      {disc(26, 34, 8)}
    </svg>
  );
}

function WhiteCells({ size = 44 }: { size?: number }) {
  return (
    <svg viewBox="0 0 60 44" width={size} height={size * 44 / 60} aria-hidden="true">
      <circle cx={18} cy={20} r={15} fill="#dbe7ff" stroke="#8fb0ea" strokeWidth="1" />
      <path d="M11 20 q3 -8 9 -6 q4 1 5 6 q-2 7 -8 6 q-5 -1 -6 -6z" fill="#6d5ac8" />
      <circle cx={43} cy={24} r={13} fill="#e6e0ff" stroke="#a79be4" strokeWidth="1" />
      <circle cx={43} cy={24} r={8} fill="#4f3fb0" />
      <circle cx={9} cy={38} r={5} fill="#c7d7fb" />
      <circle cx={54} cy={8} r={5} fill="#c7d7fb" />
    </svg>
  );
}

function Platelets({ size = 44 }: { size?: number }) {
  const blob = (cx: number, cy: number, r: number, rot: number) => (
    <ellipse cx={cx} cy={cy} rx={r} ry={r * 0.62} transform={`rotate(${rot} ${cx} ${cy})`} fill="#5b4ea6" opacity="0.85" />
  );
  return (
    <svg viewBox="0 0 60 44" width={size} height={size * 44 / 60} aria-hidden="true">
      {blob(14, 14, 9, -20)}
      {blob(38, 12, 7, 30)}
      {blob(26, 30, 8, 10)}
      {blob(48, 32, 6, -35)}
      <circle cx={30} cy={16} r={2} fill="#a79be4" />
      <circle cx={8} cy={32} r={2} fill="#a79be4" />
    </svg>
  );
}

function ClipboardIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <rect x={4} y={3} width={16} height={19} rx="2" fill="#ffffff" />
      <rect x={8} y={1.5} width={8} height={4} rx="1" fill="#c9d4f2" />
      <rect x={7} y={9} width={10} height={1.8} fill="#1e2f6b" />
      <rect x={7} y={13} width={10} height={1.8} fill="#1e2f6b" />
      <rect x={7} y={17} width={6} height={1.8} fill="#1e2f6b" />
    </svg>
  );
}

function Card({ t, n, title, cls, art, children }: {
  t: Theme; n: number; title: string; cls: string; art: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <div className={`lr__cbc-card lr__cbc-card--${cls}`} style={{ borderColor: t.mid, ['--cbc-ink' as string]: t.ink }}>
      <div className="lr__cbc-card-head">
        <span className="lr__cbc-num" style={{ background: t.ink }}>{n}</span>
        <span className="lr__cbc-card-title" style={{ color: t.ink }}>{title}</span>
        <span className="lr__cbc-art">{art}</span>
      </div>
      {children}
    </div>
  );
}

export function CbcFigure({ p }: { p: CbcPattern }) {
  const redCols = [
    ['MCV low', `(<${fmt(p.mcv.lo)})`], ['MCV normal', `(${fmt(p.mcv.lo)} – ${fmt(p.mcv.hi)})`], ['MCV high', `(>${fmt(p.mcv.hi)})`],
  ];
  const redRows = [
    ['Hb normal', `(${fmt(p.hb.lo)} – ${fmt(p.hb.hi)})`], ['Hb low', `(<${fmt(p.hb.lo)})`], ['Hb high', `(>${fmt(p.hb.hi)})`],
  ];
  const whiteCols = [['Neutrophils', 'predominant'], ['Normal', 'differential'], ['Lymphocytes', 'predominant']];
  const whiteRows = [
    ['TLC high', `(>${fmt(p.tlc.hi)})`], ['TLC normal', `(${fmt(p.tlc.lo)} – ${fmt(p.tlc.hi)})`], ['TLC low', `(<${fmt(p.tlc.lo)})`],
  ];

  return (
    <div className="lr__fig lr__fig--cbc">
      <div className="lr__cbc-head">
        <h3>Reading this CBC</h3>
        <span>– a guide to the pattern made by the results, not a diagnosis</span>
      </div>

      <div className="lr__cbc-cards">
        <Card t={RED} n={1} title="RED CELL (ANAEMIA) PATTERN" cls="red" art={<RedCells />}>
          <Grid t={RED} labels={RED_CELLS} colHeads={redCols} rowHeads={redRows}
                col={p.redCol} row={p.redRow} normalRow={0} normalCol={1} />
          <p className="lr__cbc-pattern" style={{ color: RED.ink }}>Pattern: {p.red.title}</p>
          <p className="lr__cbc-meaning">{p.red.meaning}</p>
          <p className="lr__cbc-values">
            Hb {glyph(p.hb.level)}{p.hb.text} {p.hb.unit ?? ''} · MCV {glyph(p.mcv.level)}{p.mcv.text} {p.mcv.unit ?? ''}
            {p.rdw ? ` · RDW ${glyph(p.rdw.level)}${p.rdw.text}${p.rdw.unit ? ` ${p.rdw.unit}` : ''}` : ''}
            {p.mchc ? ` · MCHC ${glyph(p.mchc.level)}${p.mchc.text}` : ''}
          </p>
        </Card>

        <Card t={BLUE} n={2} title="WHITE CELL PATTERN" cls="blue" art={<WhiteCells />}>
          <Grid t={BLUE} labels={WHITE_CELLS} colHeads={whiteCols} rowHeads={whiteRows}
                col={p.whiteCol} row={p.whiteRow} normalRow={1} normalCol={1} />
          <p className="lr__cbc-pattern" style={{ color: BLUE.ink }}>Pattern: {p.white.title}</p>
          <p className="lr__cbc-meaning">{p.white.meaning}</p>
          <p className="lr__cbc-values">
            TLC {glyph(p.tlc.level)}{p.tlc.text} · Neutrophils {glyph(p.neut.level)}{p.neut.text}% · Lymphocytes {glyph(p.lymph.level)}{p.lymph.text}%
            {p.eos ? ` · Eosinophils ${glyph(p.eos.level)}${p.eos.text}%` : ''}
            {p.anc ? ` · ANC ${glyph(p.anc.level)}${p.anc.text}` : ''}
            {p.alc ? ` · ALC ${glyph(p.alc.level)}${p.alc.text}` : ''}
          </p>
        </Card>

        <Card t={GREEN} n={3} title="PLATELET PATTERN" cls="green" art={<Platelets />}>
          <div className="lr__cbc-gauges">
            <Gauge a={p.plt} t={GREEN} />
            {p.mpv
              ? <Gauge a={p.mpv} t={GREEN} />
              : <p className="lr__cbc-values">Mean platelet volume is not part of this count.</p>}
          </div>
          <p className="lr__cbc-pattern" style={{ color: GREEN.ink }}>Pattern: {p.platelet.title}</p>
          <p className="lr__cbc-meaning">{p.platelet.meaning}</p>
        </Card>
      </div>

      <div className="lr__cbc-final">
        <div className="lr__cbc-final-head"><ClipboardIcon /><span>Final CBC Interpretation</span></div>
        <div className="lr__cbc-final-body">
          <p className="lr__cbc-final-line">{p.summary}</p>
          <p className="lr__cbc-final-note">
            This is a pattern-based interpretation and not a diagnosis. The findings should be correlated with the
            clinical history, examination findings and other relevant investigations. Further tests such as iron
            studies, peripheral smear and inflammatory markers may be considered based on clinical context.
          </p>
        </div>
      </div>

      <p className="lr__cbc-notes-head">Note</p>
      <ol className="lr__cbc-notes">
        <li>Reference intervals are age and sex specific and may vary between laboratories.</li>
        <li>Abnormal results should always be interpreted in the clinical context.</li>
        <li>This interpretation is based on commonly seen patterns and may not cover all possible clinical situations.</li>
        <li>Please consult your doctor for appropriate evaluation and management.</li>
      </ol>
    </div>
  );
}
