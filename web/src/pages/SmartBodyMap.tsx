import type { ReactNode } from 'react';

/**
 * "Your body map" — the Smart Report's format-v2 page.
 *
 * One figure, front on, drawn as an anatomy poster: the organs in their real
 * places and their natural colours, callouts on either side with the organ
 * glyph and a leader line to the organ. The systems this report LOOKED AT are
 * drawn in colour and labelled; the ones that need attention are red; the
 * organs a report did not cover stay on the figure in a faint grey so it
 * still reads as a body, but carry no label — the page is about what was
 * tested.
 *
 * The systems are the booklet's own body-system categories (SmartMeta), so
 * the map is a picture of the same grouping the chapters use: "Heart &
 * Cholesterol" points at the heart, "Blood Sugar" at the pancreas, and so on.
 * A system is red when any result in it is flagged — the Attention badge's
 * rule, deliberately binary; the Low/Moderate/High meter belongs to the
 * chapter, not to a page a patient reads in two seconds.
 *
 * Everything here is drawn in code (no licensed artwork): the silhouette is
 * one half of an outline, mirrored, and each organ is a hand-set path in the
 * same 600×1000 space — patient's LEFT on the viewer's RIGHT, as in every
 * anatomy chart. Asked for on 2026-09-16, redrawn the same day after the
 * first, cruder figure.
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

const GREEN = '#1b7a44';
const GREEN_SOFT = '#e8f5ee';
const ATTN = '#d0262d';
const ATTN_SOFT = '#fceaea';
const INK = '#232838';
const MUTED = '#616779';
const FAINT = '#8a8fa0';
const HAIR = '#e6e8f0';
const LEADER = '#9aa0b6';

/** The figure's skin. A warm, light tone, as on an anatomy poster. */
const SKIN = '#f5d9c9';
const SKIN_EDGE = '#e9c2ae';
/** An organ the report did not look at. */
const REST = '#dcdfe8';
const REST_EDGE = '#cfd3df';

/**
 * Natural, slightly muted colours for the organs of a TESTED, healthy system.
 * The flagged state overrides all of them with red, so no healthy organ is
 * itself drawn red — the heart is a deep rose here for exactly that reason.
 */
const NATURAL: Record<string, { fill: string; edge: string }> = {
  hormones: { fill: '#d8a3b7', edge: '#b97e95' },
  thyroid: { fill: '#c98aa2', edge: '#a96a84' },
  heart: { fill: '#b8485a', edge: '#8f3242' },
  liver: { fill: '#a65642', edge: '#7e3d2e' },
  diabetes: { fill: '#e2b061', edge: '#bd8d3f' },
  kidney: { fill: '#9a4f3f', edge: '#75392c' },
  infection: { fill: '#7e4262', edge: '#5f2d49' },
  urine: { fill: '#e4c56e', edge: '#bfa04a' },
  vitamins: { fill: '#ece2cf', edge: '#c9b998' },
  blood: { fill: '#b8485a', edge: '#8f3242' },
};

function tone(id: string, sys: BodySystem | undefined): { fill: string; edge: string } {
  if (!sys) return { fill: REST, edge: REST_EDGE };
  if (sys.alerts > 0) return { fill: ATTN, edge: '#9e1c22' };
  return NATURAL[id] ?? { fill: '#c9b8d8', edge: '#a693ba' };
}

/**
 * Where each body system lives on the figure, which side its callout sits,
 * and the glyph on the callout. `at` is the point the leader line ends on.
 * The callout slots run down each side in this order (top to bottom on the
 * body), so lines never cross however many systems are tested.
 */
const ORGAN_MAP: ReadonlyArray<{ id: string; side: 'left' | 'right'; at: [number, number]; icon: string }> = [
  { id: 'thyroid', side: 'left', at: [286, 186], icon: 'thyroid' },
  // Trunk organs are drawn scaled (see Organs), so their points are the
  // scaled ones: x' = 300 + (x − 300)·1.15, y' = 380 + (y − 380)·1.06.
  { id: 'liver', side: 'left', at: [236, 384], icon: 'liver' },
  { id: 'kidney', side: 'left', at: [222, 442], icon: 'kidney' },
  { id: 'urine', side: 'left', at: [284, 546], icon: 'flask' },
  { id: 'vitamins', side: 'left', at: [246, 690], icon: 'bone' },
  { id: 'hormones', side: 'right', at: [318, 62], icon: 'spark' },
  { id: 'heart', side: 'right', at: [326, 302], icon: 'heart' },
  { id: 'blood', side: 'right', at: [452, 418], icon: 'blood' },
  { id: 'infection', side: 'right', at: [415, 394], icon: 'shield' },
  { id: 'diabetes', side: 'right', at: [364, 430], icon: 'pancreas' },
];

/* ── the figure ─────────────────────────────────────────────────────────── */

/** The silhouette's RIGHT half (viewer's right), top of the head to the
 *  crotch, as cubic segments; the left half is this mirrored. */
type Seg = [c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number];
const HEAD_TOP: [number, number] = [300, 8];
const CROTCH: [number, number] = [300, 576];
const HALF: Seg[] = [
  [334, 8, 352, 40, 352, 76],        // crown to the widest point of the skull
  [352, 110, 336, 136, 316, 146],    // cheek down to the chin
  [314, 158, 318, 174, 324, 186],    // the neck
  [352, 194, 406, 200, 436, 218],    // trapezius out to the shoulder
  [454, 230, 464, 250, 466, 270],    // the deltoid
  [470, 314, 474, 364, 478, 402],    // upper arm to the elbow
  [482, 444, 488, 504, 490, 556],    // forearm to the wrist
  [492, 580, 494, 604, 488, 622],    // the hand
  [484, 640, 468, 644, 458, 634],    // fingertips
  [452, 618, 452, 594, 456, 564],    // hand, inner edge, up to the wrist
  [454, 514, 448, 464, 444, 424],    // forearm, inner edge, to the elbow
  [438, 380, 430, 326, 420, 292],    // upper arm to the armpit
  [414, 282, 408, 278, 404, 286],    // the armpit
  [408, 336, 404, 386, 396, 428],    // chest side down to the waist
  [392, 474, 416, 504, 424, 534],    // waist out to the hip
  [430, 558, 430, 576, 428, 596],    // hip to the top of the thigh
  [424, 666, 412, 726, 404, 784],    // thigh to the knee
  [400, 844, 396, 904, 390, 962],    // calf to the ankle
  [390, 982, 400, 994, 412, 998],    // ankle to the toes
  [396, 1002, 362, 1002, 352, 996],  // the sole
  [346, 986, 348, 970, 350, 958],    // heel up to the inner ankle
  [346, 902, 340, 842, 338, 784],    // inner calf to the knee
  [334, 724, 320, 644, 300, 576],    // inner thigh to the crotch
];

function silhouette(): string {
  const parts: string[] = [`M${HEAD_TOP[0]} ${HEAD_TOP[1]}`];
  for (const [a, b, c, d, x, y] of HALF) parts.push(`C${a} ${b} ${c} ${d} ${x} ${y}`);
  // Back up the other side: each segment reversed and mirrored about x = 300.
  const m = (x: number) => 600 - x;
  let end: [number, number] = CROTCH;
  for (let i = HALF.length - 1; i >= 0; i--) {
    const [a, b, c, d] = HALF[i];
    const start: [number, number] = i === 0 ? HEAD_TOP : [HALF[i - 1][4], HALF[i - 1][5]];
    parts.push(`C${m(c)} ${d} ${m(a)} ${b} ${m(start[0])} ${start[1]}`);
    end = start;
  }
  void end;
  return parts.join(' ') + ' Z';
}

const BODY_D = silhouette();

/** The organs, each in the tone of the system it stands for. */
function Organs({ by }: { by: Map<string, BodySystem> }) {
  const t = (id: string) => tone(id, by.get(id));
  const brain = t('hormones');
  const thyroid = t('thyroid');
  const heart = t('heart');
  const liver = t('liver');
  const pancreas = t('diabetes');
  const kidney = t('kidney');
  const spleen = t('infection');
  const bladder = t('urine');
  const bone = t('vitamins');
  const blood = t('blood');
  const sw = 1.6;
  return (
    <g strokeLinejoin="round" strokeLinecap="round">
      {/* ── brain: the pituitary sits here, so the hormone system points at it */}
      <g fill={brain.fill} stroke={brain.edge} strokeWidth={sw}>
        <path d="M262 68c0-26 18-42 38-42s38 16 38 42c0 18-12 32-28 34h-20c-16-2-28-16-28-34z" />
        <path d="M296 102c2 8 12 10 20 6 4-2 6-6 4-10h-24z" />
      </g>
      <g fill="none" stroke={brain.edge} strokeWidth="1.3" strokeOpacity="0.7">
        <path d="M300 28v72M270 62c8-10 18-6 14 4M284 82c10-6 14 2 8 8M318 44c10-4 14 6 6 12M320 74c10-4 14 6 6 12M276 46c6-6 12-4 12 2" />
      </g>

      {/* ── thyroid: a butterfly on the windpipe */}
      <g fill={thyroid.fill} stroke={thyroid.edge} strokeWidth={sw}>
        <path d="M298 180c-4-10-12-14-18-12-10 2-14 14-10 26 4 10 16 12 24 2 4-4 4-10 4-16z" />
        <path d="M302 180c4-10 12-14 18-12 10 2 14 14 10 26-4 10-16 12-24 2-4-4-4-10-4-16z" />
        <rect x="295" y="186" width="10" height="12" rx="4" />
      </g>

      {/* ── windpipe, under the thyroid and NOT scaled with the trunk, so the
          gland sits on it as it should */}
      <path d="M293 176h14v56h-14z" fill={REST} stroke={REST_EDGE} strokeWidth={sw} />

      {/* The trunk's organs, enlarged a little about the mid-abdomen so they
          fill the ribcage and belly the way a poster draws them. */}
      <g transform="translate(300 380) scale(1.15 1.06) translate(-300 -380)">
      {/* ── lungs: never a category, so always at rest */}
      <g fill={REST} stroke={REST_EDGE} strokeWidth={sw}>
        <path d="M300 236c0 10-18 16-30 26M300 236c0 10 18 16 30 26" fill="none" strokeWidth="6" />
        <path d="M288 238c-18-14-48-8-62 20-18 34-22 80-10 112 10 16 46 16 68 4 6-28 8-80 4-136z" />
        <path d="M312 238c18-14 48-8 62 20 18 34 22 80 10 112-10 16-42 16-62 4 14-22 22-52 14-76-6-18-20-34-24-60z" />
      </g>
      <g fill="none" stroke={REST_EDGE} strokeWidth="1.3">
        <path d="M226 300c26 6 46 18 60 32M218 348c24-4 46 2 66 8M376 300c-20 10-36 22-46 40" />
      </g>

      {/* ── heart, tilted, apex to the patient's left */}
      <g fill={heart.fill} stroke={heart.edge} strokeWidth={sw}>
        <path d="M306 268c-6-16-22-22-34-14-14 10-14 30 0 48 14 20 34 36 48 48 20-14 40-38 42-62 2-20-14-36-30-32-12 2-20 6-26 12z" />
        <path d="M312 266c-2-16 6-26 18-30" fill="none" strokeWidth="9" stroke={heart.edge} strokeOpacity="0.9" />
        <path d="M296 262c-4-14-12-22-22-22" fill="none" strokeWidth="8" stroke={heart.edge} strokeOpacity="0.75" />
      </g>
      <path d="M314 292c10 14 16 26 18 40" fill="none" stroke="#fff" strokeOpacity="0.45" strokeWidth="2" />

      {/* ── liver, under the right lung, with the gall bladder tucked below */}
      <g fill={liver.fill} stroke={liver.edge} strokeWidth={sw}>
        <path d="M204 372c4-18 46-22 96-16l50 6c14 2 16 16 2 24l-52 22c-30 12-70 8-88-8-8-8-10-18-8-28z" />
      </g>
      <path d="M302 358c-8 18-12 32-8 48" fill="none" stroke={liver.edge} strokeOpacity="0.6" strokeWidth="1.3" />
      <path d="M258 404c-6 8-4 20 4 24 8 2 14-6 12-16-2-6-10-12-16-8z" fill={by.has('liver') && !by.get('liver')!.alerts ? '#7fa35a' : liver.fill} stroke={liver.edge} strokeWidth="1.2" />

      {/* ── stomach: never a category */}
      <g fill={REST} stroke={REST_EDGE} strokeWidth={sw}>
        <path d="M318 338c2 8 6 14 8 18" fill="none" />
        <path d="M326 354c16-8 46-2 60 16 14 18 8 42-12 50-18 8-38 0-46-14-8-12-12-34-2-52z" />
      </g>

      {/* ── spleen, behind the stomach on the patient's left: the immune system's marker */}
      <path d="M392 372c12 0 18 18 14 34-4 12-14 14-18 4-4-12-4-30 4-38z" fill={spleen.fill} stroke={spleen.edge} strokeWidth={sw} />

      {/* ── pancreas, lying across behind the stomach */}
      <path d="M296 426c26-10 60-10 92-4 8 4 6 12-2 14-32 2-64 4-86 2-8-2-10-8-4-12z" fill={pancreas.fill} stroke={pancreas.edge} strokeWidth={sw} />

      {/* ── kidneys, either side of the spine, the right one a little lower */}
      <g fill={kidney.fill} stroke={kidney.edge} strokeWidth={sw}>
        <path d="M246 402c-22 0-30 24-28 46 2 20 16 28 32 24 10-6 6-18 2-28-4-10 0-28-6-42z" />
        <path d="M354 396c22 0 30 24 28 46-2 20-16 28-32 24-10-6-6-18-2-28 4-10 0-28 6-42z" />
      </g>
      <g fill="none" stroke={kidney.edge} strokeOpacity="0.55" strokeWidth="1.6">
        <path d="M250 472c8 30 30 48 42 64M350 466c-8 30-30 50-42 66" />
      </g>

      {/* ── intestines: never a category. The colon frames the small bowel,
          which snakes down inside it and ends at the rectum behind the bladder. */}
      <path d="M232 508v-62c0-12 10-18 22-16l92 4c14 0 22 8 22 20v52c0 14-10 22-24 20-14 0-22 8-24 22" fill="none" stroke={REST_EDGE} strokeWidth="22" />
      <path d="M232 508v-62c0-12 10-18 22-16l92 4c14 0 22 8 22 20v52c0 14-10 22-24 20-14 0-22 8-24 22" fill="none" stroke={REST} strokeWidth="18" />
      <path d="M256 452h84a11 11 0 0 1 0 22h-80a11 11 0 0 0 0 22h80a11 11 0 0 1 0 22h-80a11 11 0 0 0 0 22h74" fill="none" stroke={REST_EDGE} strokeWidth="17" />
      <path d="M256 452h84a11 11 0 0 1 0 22h-80a11 11 0 0 0 0 22h80a11 11 0 0 1 0 22h-80a11 11 0 0 0 0 22h74" fill="none" stroke={REST} strokeWidth="13" />

      {/* ── bladder */}
      <path d="M276 526c0-14 48-14 48 0 0 16-11 26-24 26s-24-10-24-26z" fill={bladder.fill} stroke={bladder.edge} strokeWidth={sw} />
      </g>

      {/* ── a femur, standing in for bones and minerals */}
      <g fill={bone.fill} stroke={bone.edge} strokeWidth={sw} transform="rotate(4 250 684)">
        <rect x="242" y="606" width="16" height="156" rx="8" />
        <ellipse cx="252" cy="602" rx="16" ry="11" />
        <ellipse cx="248" cy="766" rx="16" ry="11" />
      </g>

      {/* ── blood: the vein on the inner arm, where the sample was drawn */}
      <path d="M446 300c6 40 8 80 6 96" fill="none" stroke={blood.edge} strokeOpacity="0.5" strokeWidth="2" />
      <path d="M452 396c10 14 14 22 14 30a14 14 0 0 1-28 0c0-8 4-16 14-30z" fill={blood.fill} stroke={blood.edge} strokeWidth={sw} />
    </g>
  );
}

/* ── callouts ───────────────────────────────────────────────────────────── */

const VIEW = { x: -210, y: 0, w: 1020, h: 1010 };
/** Callout rows down one side: five fill the height; fewer spread out over
 *  the same span so a two-system report is not crowded into the top corner. */
function slotY(n: number, i: number): number {
  const top = 96;
  const bottom = 880;
  if (n <= 1) return 292;
  const span = Math.min(bottom - top, (n - 1) * 196);
  const start = top + ((bottom - top) - span) / 2;
  return start + (span * i) / (n - 1);
}
const LEFT_CX = -128;
const RIGHT_CX = 728;
const R = 25;

/** A system's title on one line when it fits under the disc, else broken at
 *  its natural join (" & ", ", ") nearest the middle, or the middle-most space. */
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

function Callout({ sys, side, y, icon, at, renderIcon }: {
  sys: BodySystem;
  side: 'left' | 'right';
  y: number;
  icon: string;
  at: [number, number];
  renderIcon: (name: string, color: string, size: number) => ReactNode;
}) {
  const cx = side === 'left' ? LEFT_CX : RIGHT_CX;
  const attn = sys.alerts > 0;
  const c = attn ? ATTN : GREEN;
  const edgeX = side === 'left' ? cx + R : cx - R;
  const kneeX = side === 'left' ? edgeX + 34 : edgeX - 34;
  const status = attn
    ? `${sys.alerts} of ${sys.tests} to look at`
    : `${sys.tests} ${sys.tests === 1 ? 'result' : 'results'} · healthy`;
  const lines = splitTitle(sys.title);
  return (
    <g>
      {/* leader: a short horizontal run, then straight to the organ */}
      <path
        d={`M${edgeX} ${y} L${kneeX} ${y} L${at[0]} ${at[1]}`}
        fill="none"
        stroke={attn ? ATTN : LEADER}
        strokeWidth={attn ? 2 : 1.5}
        strokeLinejoin="round"
      />
      <circle cx={at[0]} cy={at[1]} r="5" fill="#fff" stroke={c} strokeWidth="2.2" />
      {attn && <circle cx={at[0]} cy={at[1]} r="11" fill="none" stroke={ATTN} strokeOpacity="0.35" strokeWidth="2.5" />}

      {/* the disc */}
      {attn && <circle cx={cx} cy={y} r={R + 6} fill={ATTN} fillOpacity="0.1" />}
      <circle cx={cx} cy={y} r={R} fill="#fff" stroke={c} strokeWidth="2.4" />
      <foreignObject x={cx - 14} y={y - 14} width="28" height="28">
        <div style={{ width: '28px', height: '28px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {renderIcon(icon, c, 26)}
        </div>
      </foreignObject>

      {/* label under the disc */}
      {lines.map((l, i) => (
        <text key={i} x={cx} y={y + R + 17 + i * 15} textAnchor="middle" fontSize="12.5" fontWeight="800" fill={INK}>
          {l}
        </text>
      ))}
      <text x={cx} y={y + R + 17 + lines.length * 15} textAnchor="middle" fontSize="10" fontWeight="700" fill={c}>
        {status}
      </text>
    </g>
  );
}

export function BodyMapPage({ systems, name, renderIcon, title }: {
  systems: BodySystem[];
  name: string;
  renderIcon: (name: string, color: string, size: number) => ReactNode;
  title: (children: ReactNode) => ReactNode;
}) {
  const by = new Map(systems.map((s) => [s.id, s]));
  const placed = ORGAN_MAP.filter((o) => by.has(o.id));
  const left = placed.filter((o) => o.side === 'left');
  const right = placed.filter((o) => o.side === 'right');
  // "Other Tests" has no organ; it is counted in the caption, not drawn.
  const unmapped = systems.filter((s) => !ORGAN_MAP.some((o) => o.id === s.id));
  const attention = systems.filter((s) => s.alerts > 0 && by.has(s.id));
  const tested = placed.length;

  return (
    <div style={{ breakBefore: 'page', pageBreakBefore: 'always', breakAfter: 'page', pageBreakAfter: 'always', paddingTop: '2px' }}>
      {title('Your body map')}
      <div style={{ fontSize: '12px', color: MUTED, lineHeight: 1.6, marginTop: '8px', maxWidth: '660px' }}>
        {name}, this report looked at{' '}
        <strong style={{ color: INK }}>{tested} {tested === 1 ? 'organ or body system' : 'organs and body systems'}</strong>
        {unmapped.length > 0 && (
          <> (plus {unmapped.map((u) => u.title.toLowerCase()).join(', ')})</>
        )}
        . Each one is drawn in on the figure and labelled —{' '}
        <strong style={{ color: GREEN }}>green</strong> where everything sits in a healthy range,{' '}
        <strong style={{ color: ATTN }}>red</strong> where something is worth a closer look with your doctor.
        Organs in grey were not part of this report.
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
        <svg viewBox={`${VIEW.x} ${VIEW.y} ${VIEW.w} ${VIEW.h}`} width="100%" style={{ display: 'block' }} role="img" aria-label="Body map of the systems tested">
          <path d={BODY_D} fill={SKIN} stroke={SKIN_EDGE} strokeWidth="1.5" strokeLinejoin="round" />
          <Organs by={by} />
          {left.map((o, i) => (
            <Callout key={o.id} sys={by.get(o.id)!} side="left" y={slotY(left.length, i)} icon={o.icon} at={o.at} renderIcon={renderIcon} />
          ))}
          {right.map((o, i) => (
            <Callout key={o.id} sys={by.get(o.id)!} side="right" y={slotY(right.length, i)} icon={o.icon} at={o.at} renderIcon={renderIcon} />
          ))}
        </svg>

        {/* legend */}
        <div style={{ display: 'flex', gap: '18px', justifyContent: 'center', flexWrap: 'wrap', padding: '2px 0 6px', fontSize: '9.5px', fontWeight: 700, color: MUTED }}>
          {[
            [GREEN, 'Tested · healthy'],
            [ATTN, 'Tested · needs attention'],
            [REST, 'Not part of this report'],
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
      </div>
    </div>
  );
}
