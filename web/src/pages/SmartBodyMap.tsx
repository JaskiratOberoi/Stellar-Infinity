import { useEffect, useRef, type ReactNode } from 'react';
import { BODY_OUTLINE_D, BODY_OUTLINE_TRANSFORM } from './bodyOutline';

/**
 * "Your body map" — the Smart Report's format-v2 page.
 *
 * A real anatomical illustration, not a drawing of our own: the organs are
 * the medical renderings from Mikael Häggström's "Man shadow anatomy" and
 * "Female shadow anatomy" (Wikimedia Commons, CC0 1.0 public domain), each
 * one its own image in public/branding/anatomy, placed exactly where the
 * artist placed it inside that drawing's body. The figure follows the
 * patient's sex: a female patient gets the female drawing and its organ
 * placement, everyone else the male. Callouts on either side carry the
 * organ's own picture and a leader line to it, the way an anatomy poster
 * does. The whole body is shown, head to feet, whether or not a part was
 * tested.
 *
 * What the map SAYS is the booklet's own grouping (SmartMeta's body-system
 * categories): "Heart & Cholesterol" points at the heart, "Blood Sugar" at
 * the pancreas, "Infection & Immunity" at the lymph nodes and spleen, "Blood
 * Counts" at the veins of the arm, "Vitamins, Minerals & Bone" at the bones
 * of the arm. A tested system's organ is drawn at full strength; a system
 * with any flagged result is tinted red with a red glow — the Attention
 * badge's rule, deliberately binary; an organ the report never looked at
 * fades to a faint grey so the figure still reads as a body but the eye goes
 * to what was tested.
 *
 * The images load asynchronously, so the page reports readiness: the print
 * route holds its data-print-ready flag until every organ has arrived, or
 * the renderer would photograph a body with holes in it.
 *
 * Size: the organ files are kept near the resolution the page prints them
 * at (about 300 dpi of their printed size), the arm bones cropped to the
 * upper arm and the urinary tract split into kidneys and bladder, so the
 * booklet carries no more image than it shows.
 */

export interface BodySystem {
  id: string;
  title: string;
  /** Results in this system. */
  tests: number;
  /** Flagged results — any makes the organ red. */
  alerts: number;
  /** The flagged results, for the "needs attention" strip under the figure. */
  flagged: Array<{ name: string; value: string | null; unit: string | null }>;
}

export type FigureSex = 'male' | 'female';

/** The figure for a patient: female for a female patient, male otherwise. */
export function figureFor(sex: string | null | undefined): FigureSex {
  return /^f/i.test((sex ?? '').trim()) ? 'female' : 'male';
}

const GREEN = '#1b7a44';
const GREEN_SOFT = '#e8f5ee';
const ATTN = '#d0262d';
const ATTN_SOFT = '#fceaea';
const INK = '#232838';
const MUTED = '#616779';
const FAINT = '#8a8fa0';
const HAIR = '#e6e8f0';
const LEADER = '#9aa0b6';
const SKIN = '#f4dccf';
const SKIN_EDGE = '#e6c3b0';

type State = 'rest' | 'ok' | 'attn';
type Matrix = [number, number, number, number, number, number];
const ID: Matrix = [1, 0, 0, 1, 0, 0];

/**
 * One illustration layer. `x y w h` and `m` are the image's own frame and
 * its matrix in the source drawing's canvas, copied verbatim so nothing
 * moves. `system` names the booklet category the layer stands for; layers
 * with none are scenery and always at rest. `follows` lets a small organ
 * take its neighbour's state (the gall bladder goes with the liver).
 */
interface Layer {
  key: string;
  file: string;
  x: number; y: number; w: number; h: number;
  m: Matrix;
  system?: string;
  follows?: string;
}

interface Pointer {
  id: string;
  side: 'left' | 'right';
  /** Where the leader line ends, on the organ. */
  at: [number, number];
  /** The layer whose picture the callout disc shows, and the window of the drawing it shows. */
  pic: string;
  win: [number, number, number, number];
}

interface Figure {
  /** The drawing cropped to the whole body, with a column each side for callouts. */
  view: { x: number; y: number; w: number; h: number };
  leftCx: number;
  rightCx: number;
  /** The callout rows' vertical span. */
  slots: { top: number; bottom: number; single: number };
  body: ReactNode;
  layers: Layer[];
  pointers: Pointer[];
}

/* ── the male figure: "Man shadow anatomy.svg", 1363×1212 canvas ────────── */

const MALE_LAYERS: Layer[] = [
  { key: 'arm-bones', file: 'arm-bones.png', x: 172.08743, y: 593.96173, w: 286, h: 387.78, m: ID, system: 'vitamins' },
  { key: 'brain', file: 'brain.gif', x: 544.06586, y: 97.417419, w: 195.72717, h: 172.23991, m: ID, system: 'hormones' },
  { key: 'lymph', file: 'lymph.gif', x: 558.14343, y: 367.61545, w: 181, h: 150, m: ID, system: 'infection' },
  { key: 'trachea', file: 'trachea.gif', x: 613.5813, y: 289.86914, w: 56, h: 201, m: ID },
  { key: 'larynx', file: 'larynx.gif', x: 602.685, y: 405.01453, w: 78, h: 96, m: ID },
  { key: 'veins', file: 'veins.gif', x: -827.09784, y: 669.3103, w: 141, h: 588, m: [-0.9875, 0.1577, 0.1577, 0.9875, 0, 0], system: 'blood' },
  { key: 'thyroid', file: 'thyroid.gif', x: 596.8125, y: 416.89005, w: 102, h: 89, m: ID, system: 'thyroid' },
  { key: 'kidneys', file: 'kidneys.png', x: 506.0394, y: 797.99493, w: 284, h: 263.93, m: ID, system: 'kidney' },
  { key: 'bladder', file: 'bladder.png', x: 506.0394, y: 1061.92, w: 284, h: 161.76, m: ID, system: 'urine' },
  { key: 'spleen', file: 'spleen.gif', x: 560.62506, y: 846.58533, w: 95.372612, h: 110.49987, m: [0.9875, -0.1574, 0.1574, 0.9875, 0, 0], follows: 'infection' },
  { key: 'pancreas', file: 'pancreas.png', x: 440.41748, y: 881.45551, w: 224.59381, h: 135.50154, m: [0.9904, -0.1381, 0.1381, 0.9904, 0, 0], system: 'diabetes' },
  { key: 'stomach', file: 'stomach.png', x: 414.48322, y: 816.49908, w: 230.74571, h: 196.66655, m: [0.9891, -0.1476, 0.1711, 0.9853, 0, 0] },
  { key: 'intestines', file: 'intestines.gif', x: 437.50711, y: 816.84589, w: 430.75607, h: 409.41751, m: ID },
  { key: 'lungs', file: 'lungs.png', x: 488.62833, y: 480.78677, w: 312.85785, h: 314.35516, m: ID },
  { key: 'liver', file: 'liver.png', x: 497.94052, y: 715.14966, w: 262.51471, h: 192.5744, m: ID, system: 'liver' },
  { key: 'heart', file: 'heart.png', x: 575.42419, y: 478.55069, w: 153.08029, h: 274.67694, m: ID, system: 'heart' },
  { key: 'gallbladder', file: 'gallbladder.png', x: 619.59967, y: 474.05014, w: 71, h: 60.06398, m: [0.9963, -0.0862, 0.0862, 0.9963, -108.4392, 423.1945], follows: 'liver' },
];

const MALE_POINTERS: Pointer[] = [
  { id: 'thyroid', side: 'left', at: [622, 462], pic: 'thyroid', win: [592, 412, 110, 98] },
  { id: 'liver', side: 'left', at: [600, 800], pic: 'liver', win: [494, 712, 270, 200] },
  { id: 'kidney', side: 'left', at: [566, 880], pic: 'kidneys', win: [506, 800, 284, 190] },
  { id: 'urine', side: 'left', at: [640, 1180], pic: 'bladder', win: [560, 1090, 176, 134] },
  { id: 'vitamins', side: 'left', at: [352, 800], pic: 'arm-bones', win: [200, 594, 240, 388] },
  { id: 'hormones', side: 'right', at: [690, 190], pic: 'brain', win: [540, 94, 204, 180] },
  { id: 'heart', side: 'right', at: [690, 640], pic: 'heart', win: [570, 474, 164, 284] },
  { id: 'infection', side: 'right', at: [722, 436], pic: 'lymph', win: [556, 366, 186, 154] },
  { id: 'blood', side: 'right', at: [884, 800], pic: 'veins', win: [790, 540, 220, 580] },
  { id: 'diabetes', side: 'right', at: [700, 872], pic: 'pancreas', win: [452, 800, 340, 220] },
];

const MALE: Figure = {
  view: { x: -640, y: 60, w: 2540, h: 2250 },
  leftCx: -330,
  rightCx: 1610,
  slots: { top: 260, bottom: 1960, single: 900 },
  body: <path d={BODY_OUTLINE_D} transform={BODY_OUTLINE_TRANSFORM} fill={SKIN} stroke={SKIN_EDGE} strokeWidth="2" strokeLinejoin="round" />,
  layers: MALE_LAYERS,
  pointers: MALE_POINTERS,
};

/* ── the female figure: "Female shadow anatomy without labels.svg", 688×2335 canvas ── */

const FEMALE_LAYERS: Layer[] = [
  { key: 'arm-bones', file: 'female-arm-bones.png', x: 27.082672, y: 501.76453, w: 155, h: 309, m: ID, system: 'vitamins' },
  { key: 'brain', file: 'brain.gif', x: 251.39325, y: 32.89637, w: 195.72717, h: 172.23991, m: ID, system: 'hormones' },
  { key: 'lymph', file: 'lymph.gif', x: 272.29352, y: 300.58777, w: 181, h: 150, m: ID, system: 'infection' },
  { key: 'trachea', file: 'trachea.gif', x: 326.3172, y: 222.84143, w: 56, h: 201, m: ID },
  { key: 'larynx', file: 'larynx.gif', x: 306.93561, y: 337.98694, w: 78, h: 96, m: ID },
  { key: 'veins', file: 'veins.gif', x: -600.47119, y: 514.35529, w: 131.18494, h: 586.87146, m: [-0.9968, 0.0797, 0.056, 0.9984, 0, 0], system: 'blood' },
  { key: 'thyroid', file: 'thyroid.gif', x: 302.48425, y: 349.77869, w: 102, h: 89, m: ID, system: 'thyroid' },
  { key: 'kidneys', file: 'kidneys.png', x: 220.89612, y: 710.82898, w: 263.96713, h: 263.93, m: ID, system: 'kidney' },
  { key: 'bladder', file: 'bladder.png', x: 220.89612, y: 974.75, w: 263.96713, h: 161.76, m: ID, system: 'urine' },
  { key: 'spleen', file: 'spleen.gif', x: 288.05093, y: 717.05664, w: 88.817978, h: 110.31346, m: [0.9856, -0.169, 0.1465, 0.9892, 0, 0], follows: 'infection' },
  { key: 'pancreas', file: 'pancreas.png', x: 173.74751, y: 757.065, w: 209.06493, h: 135.32544, m: [0.9889, -0.1484, 0.1286, 0.9917, 0, 0], system: 'diabetes' },
  { key: 'stomach', file: 'stomach.png', x: 153.53654, y: 689.26953, w: 214.8369, h: 196.27434, m: [0.9874, -0.1585, 0.1594, 0.9872, 0, 0] },
  { key: 'intestines', file: 'intestines.gif', x: 181.09763, y: 746.6925, w: 358.81494, h: 392.40488, m: ID },
  { key: 'lungs', file: 'lungs.png', x: 204.71344, y: 393.62073, w: 290.7894, h: 314.35516, m: ID },
  { key: 'liver', file: 'liver.png', x: 213.36859, y: 627.98376, w: 243.99738, h: 192.5744, m: ID, system: 'liver' },
  { key: 'heart', file: 'heart.png', x: 285.38666, y: 391.38464, w: 142.28227, h: 274.67694, m: ID, system: 'heart' },
  { key: 'gallbladder', file: 'gallbladder.png', x: 619.59967, y: 474.05014, w: 71, h: 60.06398, m: [0.926, -0.0862, 0.0801, 0.9963, -350.2381, 336.0285], follows: 'liver' },
];

const FEMALE_POINTERS: Pointer[] = [
  { id: 'thyroid', side: 'left', at: [330, 394], pic: 'thyroid', win: [298, 346, 110, 98] },
  { id: 'liver', side: 'left', at: [300, 716], pic: 'liver', win: [210, 625, 250, 200] },
  { id: 'kidney', side: 'left', at: [268, 792], pic: 'kidneys', win: [221, 712, 264, 190] },
  { id: 'urine', side: 'left', at: [352, 1100], pic: 'bladder', win: [270, 1000, 166, 136] },
  { id: 'vitamins', side: 'left', at: [96, 690], pic: 'arm-bones', win: [27, 502, 155, 309] },
  { id: 'hormones', side: 'right', at: [396, 122], pic: 'brain', win: [247, 29, 204, 180] },
  { id: 'heart', side: 'right', at: [398, 552], pic: 'heart', win: [281, 387, 152, 284] },
  { id: 'infection', side: 'right', at: [436, 372], pic: 'lymph', win: [270, 299, 186, 154] },
  { id: 'blood', side: 'right', at: [584, 760], pic: 'veins', win: [497, 466, 164, 596] },
  { id: 'diabetes', side: 'right', at: [410, 782], pic: 'pancreas', win: [269, 694, 224, 165] },
];

const FEMALE: Figure = {
  view: { x: -964, y: 5, w: 2620, h: 2320 },
  leftCx: -650,
  rightCx: 1346,
  slots: { top: 260, bottom: 2020, single: 900 },
  // The drawing's silhouette is a flat tan image; shown at half strength it
  // sits at the same light tone as the male outline.
  body: <image href="/branding/anatomy/female-body.png" x="26.266747" y="10" width="641" height="2315" opacity="0.5" preserveAspectRatio="none" />,
  layers: FEMALE_LAYERS,
  pointers: FEMALE_POINTERS,
};

const FIGURES: Record<FigureSex, Figure> = { male: MALE, female: FEMALE };

/* ── painting ───────────────────────────────────────────────────────────── */

const R = 115;

function slotY(fig: Figure, n: number, i: number): number {
  const { top, bottom, single } = fig.slots;
  if (n <= 1) return single;
  const span = Math.min(bottom - top, (n - 1) * 425);
  const start = top + ((bottom - top) - span) / 2;
  return start + (span * i) / (n - 1);
}

function splitTitle(title: string): string[] {
  if (title.length <= 15) return [title];
  const mid = title.length / 2;
  let best = -1;
  let bestDist = Infinity;
  for (const j of [' & ', ', ']) {
    let i = title.indexOf(j);
    while (i >= 0) {
      const d = Math.abs(i + j.length - mid);
      if (d < bestDist) { bestDist = d; best = i + (j === ', ' ? 1 : 0); }
      i = title.indexOf(j, i + 1);
    }
  }
  if (best < 0) {
    let i = title.indexOf(' ');
    while (i >= 0) {
      const d = Math.abs(i - mid);
      if (d < bestDist) { bestDist = d; best = i; }
      i = title.indexOf(' ', i + 1);
    }
  }
  if (best < 0) return [title];
  return [title.slice(0, best).trim(), title.slice(best).trim()];
}

function stateOf(layer: Layer, by: Map<string, BodySystem>): State {
  const sysId = layer.system ?? layer.follows;
  if (!sysId) return 'rest';
  const sys = by.get(sysId);
  if (!sys) return 'rest';
  return sys.alerts > 0 ? 'attn' : 'ok';
}

const STATE_STYLE: Record<State, { opacity: number; filter?: string }> = {
  rest: { opacity: 0.28, filter: 'url(#bm-rest)' },
  ok: { opacity: 1 },
  attn: { opacity: 1, filter: 'url(#bm-attn)' },
};

function OrganImage({ layer, state, onLoad }: { layer: Layer; state: State; onLoad: () => void }) {
  const st = STATE_STYLE[state];
  return (
    <g opacity={st.opacity} filter={st.filter}>
      <image
        href={`/branding/anatomy/${layer.file}`}
        x={layer.x} y={layer.y} width={layer.w} height={layer.h}
        transform={`matrix(${layer.m.join(' ')})`}
        preserveAspectRatio="none"
        onLoad={onLoad}
        onError={onLoad}
      />
    </g>
  );
}

function Callout({ fig, sys, side, y, at, pic, win, renderPic }: {
  fig: Figure;
  sys: BodySystem;
  side: 'left' | 'right';
  y: number;
  at: [number, number];
  pic: string;
  win: [number, number, number, number];
  renderPic: (layerKey: string) => ReactNode;
}) {
  const cx = side === 'left' ? fig.leftCx : fig.rightCx;
  const attn = sys.alerts > 0;
  const c = attn ? ATTN : GREEN;
  const edgeX = side === 'left' ? cx + R : cx - R;
  const kneeX = side === 'left' ? edgeX + 90 : edgeX - 90;
  const status = attn
    ? `${sys.alerts} of ${sys.tests} to look at`
    : `${sys.tests} ${sys.tests === 1 ? 'result' : 'results'} · healthy`;
  const lines = splitTitle(sys.title);
  return (
    <g>
      <path
        d={`M${edgeX} ${y} L${kneeX} ${y} L${at[0]} ${at[1]}`}
        fill="none"
        stroke={attn ? ATTN : LEADER}
        strokeWidth={attn ? 5.5 : 4}
        strokeLinejoin="round"
      />
      <circle cx={at[0]} cy={at[1]} r="14" fill="#fff" stroke={c} strokeWidth="6" />
      {attn && <circle cx={at[0]} cy={at[1]} r="30" fill="none" stroke={ATTN} strokeOpacity="0.35" strokeWidth="7" />}

      {attn && <circle cx={cx} cy={y} r={R + 18} fill={ATTN} fillOpacity="0.1" />}
      <circle cx={cx} cy={y} r={R} fill="#fff" stroke={c} strokeWidth="7" />
      <clipPath id={`bm-disc-${sys.id}`}><circle cx={cx} cy={y} r={R - 9} /></clipPath>
      <g clipPath={`url(#bm-disc-${sys.id})`}>
        <svg x={cx - R + 9} y={y - R + 9} width={2 * R - 18} height={2 * R - 18} viewBox={`${win[0]} ${win[1]} ${win[2]} ${win[3]}`} preserveAspectRatio="xMidYMid meet">
          {renderPic(pic)}
        </svg>
      </g>

      {lines.map((l, i) => (
        <text key={i} x={cx} y={y + R + 54 + i * 42} textAnchor="middle" fontSize="38" fontWeight="800" fill={INK}>
          {l}
        </text>
      ))}
      <text x={cx} y={y + R + 54 + lines.length * 42} textAnchor="middle" fontSize="29" fontWeight="700" fill={c}>
        {status}
      </text>
    </g>
  );
}

export function BodyMapPage({ systems, name, sex, title, onReady }: {
  systems: BodySystem[];
  name: string;
  /** The patient's sex as the LIS records it; picks the figure. */
  sex: string | null | undefined;
  title: (children: ReactNode) => ReactNode;
  /** Called once every organ image has loaded (or failed) — the print route waits for it. */
  onReady?: () => void;
}) {
  const fig = FIGURES[figureFor(sex)];
  const by = new Map(systems.map((s) => [s.id, s]));
  const placed = fig.pointers.filter((o) => by.has(o.id));
  const left = placed.filter((o) => o.side === 'left');
  const right = placed.filter((o) => o.side === 'right');
  const unmapped = systems.filter((s) => !fig.pointers.some((o) => o.id === s.id));
  const attention = systems.filter((s) => s.alerts > 0 && by.has(s.id));
  const tested = placed.length;

  // Readiness: the figure's layers plus one picture per callout disc.
  const expected = fig.layers.length + placed.length;
  const loaded = useRef(0);
  const done = useRef(false);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const tick = () => {
    loaded.current += 1;
    if (!done.current && loaded.current >= expected) {
      done.current = true;
      onReadyRef.current?.();
    }
  };
  // A browser that has the images cached may fire no load events at all for
  // an <image> that was already complete; give it a generous ceiling.
  useEffect(() => {
    const t = setTimeout(() => {
      if (!done.current) { done.current = true; onReadyRef.current?.(); }
    }, 8000);
    return () => clearTimeout(t);
  }, []);

  const byKey = new Map(fig.layers.map((l) => [l.key, l]));
  const renderPic = (layerKey: string) => {
    const l = byKey.get(layerKey);
    if (!l) return null;
    return (
      <image
        href={`/branding/anatomy/${l.file}`}
        x={l.x} y={l.y} width={l.w} height={l.h}
        transform={`matrix(${l.m.join(' ')})`}
        preserveAspectRatio="none"
        onLoad={tick}
        onError={tick}
      />
    );
  };

  const { view } = fig;

  return (
    <div style={{ breakBefore: 'page', pageBreakBefore: 'always', breakAfter: 'page', pageBreakAfter: 'always', paddingTop: '2px' }}>
      {title('Your body map')}
      <div style={{ fontSize: '12px', color: MUTED, lineHeight: 1.6, marginTop: '8px', maxWidth: '660px' }}>
        {name}, this report looked at{' '}
        <strong style={{ color: INK }}>{tested} {tested === 1 ? 'organ or body system' : 'organs and body systems'}</strong>
        {unmapped.length > 0 && (
          <> (plus {unmapped.map((u) => u.title.toLowerCase()).join(', ')})</>
        )}
        . Each one is shown on the figure and labelled —{' '}
        <strong style={{ color: GREEN }}>green</strong> where everything sits in a healthy range,{' '}
        <strong style={{ color: ATTN }}>red</strong> where something is worth a closer look with your doctor.
        Organs shown faintly were not part of this report.
      </div>

      <div
        style={{
          marginTop: '10px',
          border: `1px solid ${HAIR}`,
          borderRadius: '16px',
          background: 'linear-gradient(180deg, #fbfbfe 0%, #ffffff 100%)',
          padding: '6px 4px 2px',
          breakInside: 'avoid',
          pageBreakInside: 'avoid',
        }}
      >
        <svg viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`} width="100%" style={{ display: 'block' }} role="img" aria-label="Body map of the systems tested">
          <defs>
            {/* at rest: nearly grey, so the tested organs carry the colour */}
            <filter id="bm-rest" colorInterpolationFilters="sRGB">
              <feColorMatrix type="saturate" values="0.12" />
            </filter>
            {/* attention: a red cast that keeps the rendering's own shading, over a soft red glow */}
            <filter id="bm-attn" x="-15%" y="-15%" width="130%" height="130%" colorInterpolationFilters="sRGB">
              <feColorMatrix
                in="SourceGraphic"
                type="matrix"
                values="0.85 0.20 0.20 0 0.06   0.12 0.42 0.10 0 0   0.12 0.10 0.42 0 0   0 0 0 1 0"
                result="tinted"
              />
              <feFlood floodColor="#d0262d" floodOpacity="0.55" result="red" />
              <feComposite in="red" in2="SourceAlpha" operator="in" result="redShape" />
              <feGaussianBlur in="redShape" stdDeviation="12" result="glow" />
              <feMerge>
                <feMergeNode in="glow" />
                <feMergeNode in="tinted" />
              </feMerge>
            </filter>
            <clipPath id="bm-crop"><rect x={view.x} y={view.y} width={view.w} height={view.h} /></clipPath>
          </defs>

          <g clipPath="url(#bm-crop)">
            {fig.body}
            {fig.layers.map((l) => (
              <OrganImage key={l.key} layer={l} state={stateOf(l, by)} onLoad={tick} />
            ))}
          </g>

          {left.map((o, i) => (
            <Callout key={o.id} fig={fig} sys={by.get(o.id)!} side="left" y={slotY(fig, left.length, i)} at={o.at} pic={o.pic} win={o.win} renderPic={renderPic} />
          ))}
          {right.map((o, i) => (
            <Callout key={o.id} fig={fig} sys={by.get(o.id)!} side="right" y={slotY(fig, right.length, i)} at={o.at} pic={o.pic} win={o.win} renderPic={renderPic} />
          ))}
        </svg>

        <div style={{ display: 'flex', gap: '18px', justifyContent: 'center', flexWrap: 'wrap', padding: '2px 0 6px', fontSize: '9.5px', fontWeight: 700, color: MUTED }}>
          {[
            [GREEN, 'Tested · healthy'],
            [ATTN, 'Tested · needs attention'],
            ['#d9d5d3', 'Not part of this report'],
          ].map(([c, l]) => (
            <span key={l} style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
              <span style={{ width: '10px', height: '10px', borderRadius: '999px', background: c, display: 'inline-block' }} />
              {l}
            </span>
          ))}
        </div>
      </div>

      {attention.length > 0 ? (
        <div style={{ marginTop: '10px', background: ATTN_SOFT, border: `1px solid ${ATTN}44`, borderRadius: '12px', padding: '10px 15px', breakInside: 'avoid' }}>
          <div style={{ fontSize: '11.5px', fontWeight: 800, color: ATTN }}>
            Marked in red — worth discussing with your doctor
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '4px 18px', marginTop: '6px' }}>
            {attention.map((s) => (
              <div key={s.id} style={{ fontSize: '10px', color: INK, lineHeight: 1.5 }}>
                <span style={{ fontWeight: 800 }}>{s.title}: </span>
                <span style={{ color: MUTED }}>
                  {s.flagged.map((f) => `${f.name} ${f.value ?? ''} ${f.unit ?? ''}`.replace(/\s+/g, ' ').trim()).join(' · ')}
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div style={{ marginTop: '10px', background: GREEN_SOFT, border: `1px solid ${GREEN}44`, borderRadius: '12px', padding: '10px 15px', fontSize: '11px', color: INK, breakInside: 'avoid' }}>
          <span style={{ fontWeight: 800, color: GREEN }}>Nothing in red. </span>
          <span style={{ color: MUTED }}>Every organ and system this report looked at came back in a healthy range.</span>
        </div>
      )}
      <div style={{ fontSize: '8.5px', color: FAINT, marginTop: '6px', lineHeight: 1.5 }}>
        The figure is a guide to where each set of tests points, not a scan of your body. A red mark means a result
        in that area fell outside its usual range — see the chapter for that system for what it can mean.
        Anatomical illustration: Mikael Häggström, public domain.
      </div>
    </div>
  );
}
