import type { CbcAxis, CbcPattern, Level } from '../lib/cbcPattern';

/**
 * "Reading this CBC" — the figure printed under a Complete Blood Count's
 * rows in the standard report, the blood-count counterpart of
 * ThyroidFigure.
 *
 * Three panels across, one per family of the count. RED CELLS: a
 * three-by-three grid, MCV low / normal / high across and haemoglobin
 * normal / low / high down, each cell named for the pattern it is
 * (microcytic anaemia, macrocytosis without anaemia …) and the patient's
 * cell picked out and tagged. WHITE CELLS: the same grid, which kind
 * predominates across and the total count high / normal / low down.
 * PLATELETS: the count on its reference band, and MPV below it where the
 * lab reports one. The grid axes are labelled with the patient's OWN
 * reference limits, read off the rows above, so the figure can never
 * disagree with the ▲▼ flags beside the numbers. Under each panel, the
 * pattern's name and a few sentences on what it usually means; under all
 * three, one line that puts them together, and the standing notes.
 *
 * Greyscale by design, like the thyroid figure: in range and out of range
 * are told apart by weight, glyph and hatching, the chosen cell by a heavy
 * border and a darker fill, so a black-and-white printer loses nothing.
 */

const INK = '#111827';
const MUTED = '#3f3f46';
const FAINT = '#595959';
const LINE = '#9ca3af';
const CELL = '#fafafa';
const CELL_LINE = '#c4c7cd';
const HERE_FILL = '#e4e4e7';

const PANEL_W = 232;
const PANEL_GAP = 2;
const PANEL_H = 196;
const CELL_W = 56;
const CELL_H = 40;
/* Room on the grid's left for "TLC normal ▸" and its limits under it. */
const ROW_HEAD_W = 58;

/* Red-cell grid labels, [row (Hb normal / low / high)][col (MCV low / normal / high)]. */
const RED_CELLS: string[][][] = [
  [['Microcytosis', '(no anaemia)'], ['Normal', 'red cells'], ['Macrocytosis', '(no anaemia)']],
  [['Microcytic', 'anaemia'], ['Normocytic', 'anaemia'], ['Macrocytic', 'anaemia']],
  [['Raised Hb,', 'small cells'], ['Raised Hb', '(erythrocytosis)'], ['Raised Hb,', 'large cells']],
];
/* White-cell grid labels, [row (TLC high / normal / low)][col (neutrophils / balanced / lymphocytes)]. */
const WHITE_CELLS: string[][][] = [
  [['Neutrophil', 'leukocytosis'], ['Mixed', 'leukocytosis'], ['Lymphocytosis']],
  [['Relative', 'neutrophilia'], ['Normal', 'white cells'], ['Relative', 'lymphocytosis']],
  [['Leukopenia,', 'lymphopenia'], ['Leukopenia'], ['Leukopenia,', 'neutropenia']],
];

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10));
const levelWord = (l: Level) => (l === 'normal' ? 'within range' : l === 'high' ? 'above range' : 'below range');
const glyph = (l: Level) => (l === 'high' ? '▲ ' : l === 'low' ? '▼ ' : '');

function Grid({
  x, y, labels, colHeads, rowHeads, col, row, normalRow, normalCol,
}: {
  x: number; y: number; labels: string[][][];
  colHeads: string[][]; rowHeads: string[][];
  col: 0 | 1 | 2; row: 0 | 1 | 2; normalRow: number; normalCol: number;
}) {
  const gx = x + ROW_HEAD_W;
  return (
    <g>
      {/* column heads above the grid */}
      {colHeads.map((lines, c) => lines.map((l, li) => (
        <text key={`${c}${li}`} x={gx + c * CELL_W + CELL_W / 2} y={y + 8 + li * 9}
              fontSize={li === 0 ? 8.2 : 7.2} fontWeight={c === col ? 700 : 500} fill={c === col ? INK : MUTED} textAnchor="middle">
          {li === 0 && c === col ? '▾ ' : ''}{l}
        </text>
      )))}
      {/* row heads down the left */}
      {rowHeads.map((lines, r) => lines.map((l, li) => (
        <text key={`${r}${li}`} x={gx - 4} y={y + 22 + r * CELL_H + CELL_H / 2 - 2 + li * 9}
              fontSize={li === 0 ? 8.2 : 7.2} fontWeight={r === row ? 700 : 500} fill={r === row ? INK : MUTED} textAnchor="end">
          {l}{li === 0 && r === row ? ' ▸' : ''}
        </text>
      )))}
      {labels.map((rowLabels, r) => rowLabels.map((lines, c) => {
        const here = r === row && c === col;
        const normal = r === normalRow && c === normalCol;
        const cx = gx + c * CELL_W;
        const cy = y + 22 + r * CELL_H;
        return (
          <g key={`${r}${c}`}>
            <rect x={cx + 1} y={cy + 1} width={CELL_W - 2} height={CELL_H - 2} rx="4"
                  fill={here ? HERE_FILL : normal ? '#ffffff' : CELL}
                  stroke={here ? INK : normal ? MUTED : CELL_LINE}
                  strokeWidth={here ? 2.2 : normal ? 1 : 0.8}
                  strokeDasharray={normal && !here ? '3 2' : undefined} />
            {lines.map((l, i) => (
              <text key={i} x={cx + CELL_W / 2}
                    y={cy + CELL_H / 2 + (i - (lines.length - 1) / 2) * 9.5 + (here ? 6 : 3)}
                    fontSize={here ? 7.8 : 7.4} fontWeight={here || normal ? 700 : 500}
                    fill={here || normal ? INK : MUTED} textAnchor="middle">
                {l}
              </text>
            ))}
            {here && (
              <g>
                <rect x={cx + CELL_W / 2 - 24} y={cy + 3} width={48} height={9} rx="4.5" fill={INK} />
                <text x={cx + CELL_W / 2} y={cy + 9.8} fontSize="5.8" fontWeight="700" fill="#ffffff" textAnchor="middle">
                  THIS RESULT
                </text>
              </g>
            )}
          </g>
        );
      }))}
    </g>
  );
}

function RangeBar({ a, x, y, w }: { a: CbcAxis; x: number; y: number; w: number }) {
  const span = a.hi - a.lo;
  const min = Math.max(0, a.lo - span * 0.6);
  const max = a.hi + span * 0.6;
  const px = (v: number) => x + ((Math.min(max, Math.max(min, v)) - min) / (max - min)) * w;
  const lo = px(a.lo);
  const hi = px(a.hi);
  const at = px(a.value);
  const barY = y + 10;
  const off = a.level !== 'normal';
  return (
    <g>
      <text x={x} y={y} fontSize="8.5" fontWeight="700" fill={INK}>{a.label}</text>
      <text x={x + w} y={y} fontSize="8.5" fontWeight={off ? 700 : 500} fill={INK} textAnchor="end">
        {glyph(a.level)}{a.text}{a.unit ? ` ${a.unit}` : ''}
        <tspan fontWeight="400" fill={MUTED}> · {levelWord(a.level)}</tspan>
      </text>
      <rect x={x} y={barY} width={w} height={9} rx="4.5" fill="url(#cf-hatch)" />
      <rect x={lo} y={barY} width={Math.max(2, hi - lo)} height={9} fill="#ffffff" stroke={INK} strokeWidth="0.9" />
      <rect x={x} y={barY} width={w} height={9} rx="4.5" fill="none" stroke={LINE} strokeWidth="0.7" />
      <path d={`M${at} ${barY + 1} l-4 -6 h8 z`} fill={INK} />
      <line x1={at} y1={barY} x2={at} y2={barY + 9} stroke={INK} strokeWidth="1.6" />
      <text x={lo} y={barY + 19} fontSize="7.5" fill={FAINT} textAnchor="middle">{fmt(a.lo)}</text>
      <text x={hi} y={barY + 19} fontSize="7.5" fill={FAINT} textAnchor="middle">{fmt(a.hi)}</text>
    </g>
  );
}

function PanelFrame({ x, n, title, children }: { x: number; n: number; title: string; children: React.ReactNode }) {
  return (
    <g>
      <rect x={x + 0.5} y={0.5} width={PANEL_W - 1} height={PANEL_H - 1} rx="5" fill="none" stroke={LINE} strokeWidth="0.8" />
      <circle cx={x + 13} cy={13} r={7.5} fill={INK} />
      <text x={x + 13} y={16} fontSize="8.5" fontWeight="700" fill="#ffffff" textAnchor="middle">{n}</text>
      <text x={x + 25} y={16.5} fontSize="9.5" fontWeight="700" fill={INK}>{title}</text>
      <line x1={x + 6} y1={23} x2={x + PANEL_W - 6} y2={23} stroke={CELL_LINE} strokeWidth="0.7" />
      {children}
    </g>
  );
}

export function CbcFigure({ p }: { p: CbcPattern }) {
  const x1 = 0;
  const x2 = PANEL_W + PANEL_GAP;
  const x3 = 2 * (PANEL_W + PANEL_GAP);
  const width = 3 * PANEL_W + 2 * PANEL_GAP;

  const redCols = [
    ['MCV low', `(<${fmt(p.mcv.lo)})`], ['MCV normal', `(${fmt(p.mcv.lo)} – ${fmt(p.mcv.hi)})`], ['MCV high', `(>${fmt(p.mcv.hi)})`],
  ];
  const redRows = [
    ['Hb normal', `(${fmt(p.hb.lo)} – ${fmt(p.hb.hi)})`], ['Hb low', `(<${fmt(p.hb.lo)})`], ['Hb high', `(>${fmt(p.hb.hi)})`],
  ];
  const whiteCols = [
    ['Neutrophils', 'predominant'], ['Balanced', 'differential'], ['Lymphocytes', 'predominant'],
  ];
  const whiteRows = [
    ['TLC high', `(>${fmt(p.tlc.hi)})`], ['TLC normal', `(${fmt(p.tlc.lo)} – ${fmt(p.tlc.hi)})`], ['TLC low', `(<${fmt(p.tlc.lo)})`],
  ];

  const readings = [
    { n: 1, r: p.red }, { n: 2, r: p.white }, { n: 3, r: p.platelet },
  ];

  return (
    <div className="lr__fig lr__fig--cbc">
      <div className="lr__fig-head">
        <h3>Reading this CBC</h3>
        <span>a guide to the pattern the results make, not a diagnosis</span>
      </div>
      <svg viewBox={`0 0 ${width} ${PANEL_H}`} role="img" aria-label={`CBC pattern: ${p.summary}`}>
        <defs>
          <pattern id="cf-hatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="5" height="5" fill="#f4f4f5" />
            <line x1="0" y1="0" x2="0" y2="5" stroke="#8a8f98" strokeWidth="1.2" />
          </pattern>
        </defs>

        <PanelFrame x={x1} n={1} title="Red cells (anaemia pattern)">
          <Grid x={x1 + 4} y={30} labels={RED_CELLS} colHeads={redCols} rowHeads={redRows}
                col={p.redCol} row={p.redRow} normalRow={0} normalCol={1} />
          <text x={x1 + 8} y={PANEL_H - 7} fontSize="7" fill={FAINT}>
            Hb {glyph(p.hb.level)}{p.hb.text} {p.hb.unit ?? ''} · MCV {glyph(p.mcv.level)}{p.mcv.text} {p.mcv.unit ?? ''}
            {p.rdw ? ` · RDW ${glyph(p.rdw.level)}${p.rdw.text}` : ''}
          </text>
        </PanelFrame>

        <PanelFrame x={x2} n={2} title="White cells">
          <Grid x={x2 + 4} y={30} labels={WHITE_CELLS} colHeads={whiteCols} rowHeads={whiteRows}
                col={p.whiteCol} row={p.whiteRow} normalRow={1} normalCol={1} />
          <text x={x2 + 8} y={PANEL_H - 7} fontSize="7" fill={FAINT}>
            TLC {glyph(p.tlc.level)}{p.tlc.text} · N {glyph(p.neut.level)}{p.neut.text}% · L {glyph(p.lymph.level)}{p.lymph.text}%
            {p.eos ? ` · E ${glyph(p.eos.level)}${p.eos.text}%` : ''}
          </text>
        </PanelFrame>

        <PanelFrame x={x3} n={3} title="Platelets">
          <RangeBar a={p.plt} x={x3 + 12} y={44} w={PANEL_W - 24} />
          {p.mpv
            ? <RangeBar a={p.mpv} x={x3 + 12} y={100} w={PANEL_W - 24} />
            : (
              <text x={x3 + 12} y={104} fontSize="7.5" fill={FAINT}>
                Mean platelet volume is not part of this count.
              </text>
            )}
          {p.anc && p.alc && (
            <>
              <text x={x3 + 12} y={PANEL_H - 50} fontSize="7.8" fontWeight="700" fill={INK}>Absolute white-cell counts</text>
              <text x={x3 + 12} y={PANEL_H - 39} fontSize="7.2" fill={MUTED}>
                Neutrophils {glyph(p.anc.level)}{p.anc.text} · band {fmt(p.anc.lo)} – {fmt(p.anc.hi)}
              </text>
              <text x={x3 + 12} y={PANEL_H - 29} fontSize="7.2" fill={MUTED}>
                Lymphocytes {glyph(p.alc.level)}{p.alc.text} · band {fmt(p.alc.lo)} – {fmt(p.alc.hi)}
              </text>
            </>
          )}
          <text x={x3 + 12} y={PANEL_H - 8} fontSize="6.8" fill={FAINT}>
            clear: within the band · hatched: outside it
          </text>
        </PanelFrame>
      </svg>

      <div className="lr__cbc-readings">
        {readings.map(({ n, r }) => (
          <div key={n} className="lr__cbc-reading">
            <p className="lr__cbc-pattern"><b>Pattern:</b> {r.title}</p>
            <p className="lr__cbc-meaning">{r.meaning}</p>
          </div>
        ))}
      </div>

      <div className="lr__cbc-final">
        <p className="lr__cbc-final-head">Final CBC interpretation</p>
        <p className="lr__cbc-final-line">{p.summary}</p>
        <p className="lr__cbc-final-note">
          This is a pattern-based reading and not a diagnosis. The findings should be correlated with the clinical
          history, examination and other relevant investigations; further tests such as iron studies, a peripheral
          smear or inflammatory markers may be considered on clinical grounds.
        </p>
      </div>

      <ol className="lr__cbc-notes">
        <li>Reference intervals are age and sex specific and may vary between laboratories.</li>
        <li>Abnormal results should always be interpreted in the clinical context.</li>
        <li>This reading is based on commonly seen patterns and may not cover every clinical situation.</li>
        <li>Please consult your doctor for appropriate evaluation and management.</li>
      </ol>
    </div>
  );
}
