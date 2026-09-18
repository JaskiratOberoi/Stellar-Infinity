import type { ReactNode } from 'react';

/**
 * "Your body map" — the Smart Report's format-v2 page.
 *
 * One figure, front on, drawn as an anatomy poster: every organ in its real
 * place and its natural colour, two tones and a little detail each (the
 * bronchial tree, the great vessels, the stomach's folds, the colon's
 * haustra, the ureters), callouts on either side with the organ glyph and a
 * leader line to the organ. The systems this report LOOKED AT are drawn at
 * full strength and labelled; the ones that need attention are red; the
 * organs a report did not cover fade back so the figure still reads as a
 * body but the eye goes to what was tested.
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
 * anatomy chart. Asked for on 2026-09-16; redrawn twice against a poster the
 * lab uses as its reference.
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

/** The figure's skin: the flat warm tone of the poster, a shade darker at the edge. */
const SKIN = '#f6cdb8';
const SKIN_EDGE = '#e9b9a2';

/** How an organ is painted: its base, a darker tone for shading and detail,
 *  and how strongly it shows. */
interface Paint { fill: string; dark: string; opacity: number }

/** Natural colours, as on the poster. The flagged state overrides them with
 *  red, and no healthy organ is drawn in that red — the heart is a deep rose. */
const NATURAL: Record<string, [fill: string, dark: string]> = {
  hormones: ['#e9aab8', '#c77f95'],
  thyroid: ['#d98aa0', '#b56a82'],
  heart: ['#c9414c', '#9f2b36'],
  liver: ['#a84a31', '#7f3322'],
  diabetes: ['#eab868', '#c8944a'],
  kidney: ['#a64f3f', '#7f3628'],
  infection: ['#8c4572', '#6a2f56'],
  urine: ['#efc86c', '#cba44a'],
  vitamins: ['#f1e7d3', '#cfbf9f'],
  blood: ['#c9303a', '#951f27'],
  // never categories — always at rest, so only their natural tones matter
  lungs: ['#e79ca4', '#cd7684'],
  trachea: ['#eadad2', '#c9b3a8'],
  stomach: ['#eba58f', '#ce8170'],
  bowel: ['#e8ab7e', '#c8865a'],
  smallbowel: ['#f2c3a4', '#d49c7c'],
  adrenal: ['#ecc96e', '#c9a24c'],
  veins: ['#7c8ec9', '#5b6ea8'],
};

const REST_OPACITY = 0.38;

function paint(id: string, sys?: BodySystem): Paint {
  const [fill, dark] = NATURAL[id] ?? ['#c9b8d8', '#a693ba'];
  if (sys === undefined) return { fill, dark, opacity: REST_OPACITY };
  if (sys.alerts > 0) return { fill: '#dc3a41', dark: '#a3262c', opacity: 1 };
  return { fill, dark, opacity: 1 };
}

/**
 * Where each body system lives on the figure, which side its callout sits,
 * and the glyph on the callout. `at` is the point the leader line ends on.
 * The callout slots run down each side in this order (top to bottom on the
 * body), so lines never cross however many systems are tested.
 */
const ORGAN_MAP: ReadonlyArray<{ id: string; side: 'left' | 'right'; at: [number, number]; icon: string }> = [
  // Trunk organs are drawn scaled (see Organs), so their points are the
  // scaled ones: x' = 300 + (x − 300)·1.16, y' = 380 + (y − 380)·1.08.
  { id: 'thyroid', side: 'left', at: [287, 186], icon: 'thyroid' },
  { id: 'liver', side: 'left', at: [230, 386], icon: 'liver' },
  { id: 'kidney', side: 'left', at: [221, 446], icon: 'kidney' },
  { id: 'urine', side: 'left', at: [284, 546], icon: 'flask' },
  { id: 'vitamins', side: 'left', at: [250, 690], icon: 'bone' },
  { id: 'hormones', side: 'right', at: [320, 60], icon: 'spark' },
  { id: 'heart', side: 'right', at: [328, 298], icon: 'heart' },
  { id: 'blood', side: 'right', at: [452, 416], icon: 'blood' },
  { id: 'infection', side: 'right', at: [421, 393], icon: 'shield' },
  { id: 'diabetes', side: 'right', at: [370, 438], icon: 'pancreas' },
];

/* ── the figure ─────────────────────────────────────────────────────────── */

/** The silhouette's RIGHT half (viewer's right), top of the head to the
 *  crotch, as cubic segments; the left half is this mirrored. Poster
 *  proportions: a small head, a long neck, square shoulders, a straight
 *  torso that narrows a little at the waist, arms hanging close. */
type Seg = [c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number];
const HEAD_TOP: [number, number] = [300, 10];
const CROTCH: [number, number] = [300, 566];
const HALF: Seg[] = [
  [332, 10, 348, 36, 348, 66],       // crown to the widest point of the skull
  [348, 96, 334, 120, 318, 128],     // cheek down to the jaw
  [312, 140, 316, 156, 322, 170],    // the neck
  [352, 178, 410, 182, 446, 196],    // trapezius out to the shoulder
  [462, 204, 472, 222, 474, 244],    // the deltoid
  [478, 290, 480, 346, 482, 398],    // upper arm to the elbow
  [484, 446, 486, 500, 486, 548],    // forearm to the wrist
  [488, 572, 490, 600, 486, 626],    // the hand
  [482, 648, 466, 654, 454, 644],    // fingertips
  [446, 624, 446, 596, 448, 554],    // hand, inner edge, up to the wrist
  [446, 506, 444, 454, 442, 404],    // forearm, inner edge, to the elbow
  [438, 364, 430, 318, 420, 290],    // upper arm to the armpit
  [414, 280, 408, 278, 406, 290],    // the armpit
  [408, 340, 402, 390, 392, 430],    // chest side down to the waist
  [388, 466, 400, 500, 404, 532],    // waist out to the hip
  [408, 548, 410, 556, 410, 566],    // hip to the top of the thigh
  [406, 640, 394, 700, 388, 764],    // thigh to the knee
  [384, 826, 378, 886, 372, 944],    // calf to the ankle
  [372, 966, 384, 978, 400, 986],    // ankle to the toes
  [388, 994, 356, 996, 344, 988],    // the sole
  [338, 978, 338, 962, 340, 948],    // heel up to the inner ankle
  [338, 890, 334, 830, 332, 766],    // inner calf to the knee
  [330, 700, 318, 630, 300, 566],    // inner thigh to the crotch
];

function silhouette(): string {
  const parts: string[] = [`M${HEAD_TOP[0]} ${HEAD_TOP[1]}`];
  for (const [a, b, c, d, x, y] of HALF) parts.push(`C${a} ${b} ${c} ${d} ${x} ${y}`);
  // Back up the other side: each segment reversed and mirrored about x = 300.
  const m = (x: number) => 600 - x;
  for (let i = HALF.length - 1; i >= 0; i--) {
    const [a, b, c, d] = HALF[i];
    const start: [number, number] = i === 0 ? HEAD_TOP : [HALF[i - 1][4], HALF[i - 1][5]];
    parts.push(`C${m(c)} ${d} ${m(a)} ${b} ${m(start[0])} ${start[1]}`);
  }
  void CROTCH;
  return parts.join(' ') + ' Z';
}

const BODY_D = silhouette();

/** A soft white highlight that gives an organ its rounded look. */
function Sheen({ d }: { d: string }) {
  return <path d={d} fill="#fff" fillOpacity="0.28" stroke="none" />;
}

/** The organs, each painted for the system it stands for. */
function Organs({ by }: { by: Map<string, BodySystem> }) {
  const p = (id: string) => paint(id, by.get(id));
  const brain = p('hormones');
  const thyroid = p('thyroid');
  const heart = p('heart');
  const liver = p('liver');
  const pancreas = p('diabetes');
  const kidney = p('kidney');
  const spleen = p('infection');
  const bladder = p('urine');
  const bone = p('vitamins');
  const blood = p('blood');
  const lungs = paint('lungs');
  const trachea = paint('trachea');
  const stomach = paint('stomach');
  const bowel = paint('bowel');
  const small = paint('smallbowel');
  const adrenal = paint('adrenal');
  const veins = paint('veins');
  const sw = 1.4;
  return (
    <g strokeLinejoin="round" strokeLinecap="round">
      {/* ── brain: the pituitary sits here, so the hormone system points at it */}
      <g opacity={brain.opacity}>
        <path d="M258 66c0-24 18-40 42-40s42 16 42 40c0 16-10 30-26 34h-32c-16-4-26-18-26-34z" fill={brain.fill} stroke={brain.dark} strokeWidth={sw} />
        <path d="M292 100c4 8 14 10 22 6 4-2 4-6 2-8z" fill={brain.dark} stroke={brain.dark} strokeWidth={sw} />
        <path d="M300 28v70M266 60c8-10 18-8 16 4M282 82c10-8 16 0 10 8M274 44c6-8 14-6 14 2M318 42c10-6 16 4 8 12M322 70c10-6 16 4 8 12M312 88c10-4 14 4 8 8" fill="none" stroke={brain.dark} strokeWidth="1.5" strokeOpacity="0.8" />
        <Sheen d="M270 48c6-12 22-18 34-14-12 2-24 10-30 20z" />
      </g>

      {/* ── windpipe, under the thyroid */}
      <g opacity={trachea.opacity}>
        <path d="M294 150h12v88h-12z" fill={trachea.fill} stroke={trachea.dark} strokeWidth={sw} />
        <path d="M294 160h12M294 170h12M294 180h12M294 200h12M294 210h12M294 220h12M294 230h12" fill="none" stroke={trachea.dark} strokeWidth="1.2" strokeOpacity="0.8" />
      </g>

      {/* ── thyroid: a butterfly on the windpipe */}
      <g opacity={thyroid.opacity}>
        <path d="M298 180c-3-9-10-13-16-11-9 2-13 13-9 24 4 9 14 11 20 2 4-4 5-9 5-15z" fill={thyroid.fill} stroke={thyroid.dark} strokeWidth={sw} />
        <path d="M302 180c3-9 10-13 16-11 9 2 13 13 9 24-4 9-14 11-20 2-4-4-5-9-5-15z" fill={thyroid.fill} stroke={thyroid.dark} strokeWidth={sw} />
        <rect x="295" y="185" width="10" height="10" rx="4" fill={thyroid.fill} stroke={thyroid.dark} strokeWidth={sw} />
      </g>

      {/* The trunk's organs, enlarged about the mid-abdomen so they fill the
          ribcage and belly the way a poster draws them. The windpipe, the
          glands in the head and neck, the femur and the arm are not scaled. */}
      <g transform="translate(300 380) scale(1.16 1.08) translate(-300 -380)">
      {/* ── lungs, with the bronchial tree and the lobe fissures */}
      <g opacity={lungs.opacity}>
        <path d="M288 232c-14-14-46-8-62 16-22 32-28 84-16 122 8 16 44 20 66 8 10-40 12-96 12-146z" fill={lungs.fill} stroke={lungs.dark} strokeWidth={sw} />
        <path d="M312 232c14-14 46-8 62 16 22 32 28 84 16 122-8 16-40 20-60 8 12-24 20-56 12-84-6-20-20-38-30-62z" fill={lungs.fill} stroke={lungs.dark} strokeWidth={sw} />
        <path d="M222 306c24 4 44 14 62 30M214 350c22-4 44 0 66 6M378 304c-20 8-34 20-42 36" fill="none" stroke={lungs.dark} strokeWidth="1.3" strokeOpacity="0.7" />
        <Sheen d="M236 250c10-14 30-18 44-12-14 4-26 14-32 26-6 12-8 26-10 40-6-18-8-38-2-54z" />
        <Sheen d="M364 250c-10-14-30-18-44-12 14 4 26 14 32 26 6 12 8 26 10 40 6-18 8-38 2-54z" />
        {/* bronchi */}
        <path d="M300 246c0 8-16 12-30 18M300 246c0 8 16 12 30 18" fill="none" stroke={lungs.dark} strokeWidth="5" />
        <path d="M270 264c-10 6-16 18-18 30M270 264c-2 12 2 24 8 36M330 264c10 6 16 18 18 30M330 264c2 12-2 24-8 36" fill="none" stroke={lungs.dark} strokeWidth="3" />
        <path d="M252 294c-6 4-10 10-12 18M252 294c2 8 6 14 12 18M278 300c-4 8-4 16-2 24M278 300c4 6 8 12 8 20M348 294c6 4 10 10 12 18M348 294c-2 8-6 14-12 18M322 300c4 8 4 16 2 24M322 300c-4 6-8 12-8 20" fill="none" stroke={lungs.dark} strokeWidth="1.8" />
      </g>

      {/* ── the great vessels behind the heart */}
      <g opacity={heart.opacity}>
        <path d="M290 262c-2-14 0-24 6-30" fill="none" stroke={veins.fill} strokeWidth="9" />
        <path d="M312 264c0-18 8-28 22-30M334 234c-6-4-14-4-22 0" fill="none" stroke={heart.dark} strokeWidth="10" />
        <path d="M326 236v-12M334 236v-14M342 240v-12" fill="none" stroke={heart.dark} strokeWidth="4" />
        <path d="M304 268c6-10 10-16 22-18" fill="none" stroke={veins.dark} strokeWidth="7" />
      </g>

      {/* ── heart, tilted, apex to the patient's left */}
      <g opacity={heart.opacity}>
        <path d="M304 268c-8-16-26-20-38-10-14 12-12 34 4 54 14 18 34 32 46 42 18-14 36-36 38-58 2-22-14-38-30-32-10 2-16 6-20 4z" fill={heart.fill} stroke={heart.dark} strokeWidth={sw} />
        <path d="M312 280c10 8 18 20 22 34M308 296c-8 8-12 18-10 30" fill="none" stroke={heart.dark} strokeWidth="1.8" strokeOpacity="0.8" />
        <Sheen d="M278 270c6-8 18-10 26-6-10 2-18 10-20 22-4-4-8-10-6-16z" />
      </g>

      {/* ── liver, under the right lung, with the gall bladder tucked below */}
      <g opacity={liver.opacity}>
        <path d="M200 368c6-18 48-22 100-14l48 6c14 2 16 16 2 24l-50 22c-30 12-72 8-90-8-8-8-12-20-10-30z" fill={liver.fill} stroke={liver.dark} strokeWidth={sw} />
        <path d="M300 356c-8 18-12 32-8 48" fill="none" stroke={liver.dark} strokeWidth="1.4" strokeOpacity="0.7" />
        <Sheen d="M208 368c10-10 50-14 92-10-40 0-72 6-86 18-4-2-6-6-6-8z" />
        <path d="M258 404c-6 8-4 20 4 24 8 2 14-6 12-16-2-6-10-12-16-8z" fill={by.get('liver')?.alerts ? liver.fill : '#6f9d57'} stroke={by.get('liver')?.alerts ? liver.dark : '#4e7a3b'} strokeWidth="1.2" />
      </g>

      {/* ── stomach, under the left lung */}
      <g opacity={stomach.opacity}>
        <path d="M314 336c4 8 8 14 10 18" fill="none" stroke={stomach.fill} strokeWidth="8" />
        <path d="M322 350c18-8 48-2 62 16 14 18 8 44-12 52-18 8-40 0-48-16-8-14-12-36-2-52z" fill={stomach.fill} stroke={stomach.dark} strokeWidth={sw} />
        <path d="M334 366c12-4 26-2 36 6M330 382c12-4 28-2 40 6M334 398c10-2 22 0 30 4" fill="none" stroke={stomach.dark} strokeWidth="1.3" strokeOpacity="0.6" />
        <Sheen d="M328 356c14-6 30-4 40 2-14-2-26 0-36 8z" />
      </g>

      {/* ── spleen, behind the stomach on the patient's left: the immune system's marker */}
      <g opacity={spleen.opacity}>
        <path d="M394 372c12 0 18 18 14 34-4 12-14 14-18 4-4-12-4-30 4-38z" fill={spleen.fill} stroke={spleen.dark} strokeWidth={sw} />
        <Sheen d="M396 378c6 0 8 6 8 12-4-4-8-6-10-8z" />
      </g>

      {/* ── pancreas, lying across behind the stomach */}
      <g opacity={pancreas.opacity}>
        <path d="M296 428c26-10 62-10 94-4 8 4 6 12-2 14-32 2-66 4-88 2-8-2-10-8-4-12z" fill={pancreas.fill} stroke={pancreas.dark} strokeWidth={sw} />
        <path d="M308 432c20-4 44-4 70-2M312 438c22 0 44 0 66-2" fill="none" stroke={pancreas.dark} strokeWidth="1.2" strokeOpacity="0.6" />
      </g>

      {/* ── adrenal glands on the kidneys, kidneys, ureters down to the bladder */}
      <g opacity={kidney.opacity}>
        <path d="M244 404c-4-8 2-14 10-12 4 4 2 10-2 14z" fill={adrenal.fill} stroke={adrenal.dark} strokeWidth="1.1" />
        <path d="M356 398c4-8-2-14-10-12-4 4-2 10 2 14z" fill={adrenal.fill} stroke={adrenal.dark} strokeWidth="1.1" />
        <path d="M248 406c-22 0-30 24-28 46 2 20 16 28 32 24 10-6 6-18 2-28-4-10 0-28-6-42z" fill={kidney.fill} stroke={kidney.dark} strokeWidth={sw} />
        <path d="M352 400c22 0 30 24 28 46-2 20-16 28-32 24-10-6-6-18-2-28 4-10 0-28 6-42z" fill={kidney.fill} stroke={kidney.dark} strokeWidth={sw} />
        <path d="M250 430c-6 4-8 12-6 20M350 424c6 4 8 12 6 20" fill="none" stroke={bladder.fill} strokeWidth="3" strokeOpacity="0.9" />
        <path d="M252 474c8 26 26 42 40 58M348 468c-8 26-26 44-40 60" fill="none" stroke={bladder.fill} strokeWidth="3" />
        <Sheen d="M230 416c4-6 12-8 18-6-6 4-10 12-10 22-4-4-8-10-8-16z" />
        <Sheen d="M370 410c-4-6-12-8-18-6 6 4 10 12 10 22 4-4 8-10 8-16z" />
      </g>

      {/* ── intestines: the colon frames the small bowel, which snakes down
          inside it and ends at the rectum behind the bladder */}
      <g opacity={bowel.opacity}>
        <path d="M232 508v-60c0-12 10-18 22-16l92 4c14 0 22 8 22 20v50c0 14-10 22-24 20-14 0-22 8-24 22" fill="none" stroke={bowel.dark} strokeWidth="24" />
        <path d="M232 508v-60c0-12 10-18 22-16l92 4c14 0 22 8 22 20v50c0 14-10 22-24 20-14 0-22 8-24 22" fill="none" stroke={bowel.fill} strokeWidth="19" />
        {/* haustra */}
        <path d="M222 466h20M222 482h20M222 498h20M262 432l2 16M282 433l2 16M302 434l2 16M322 435l2 16M342 437l2 16M358 462h20M358 478h20M358 494h20" fill="none" stroke={bowel.dark} strokeWidth="1.3" strokeOpacity="0.7" />
      </g>
      <g opacity={small.opacity}>
        <path d="M256 452h84a11 11 0 0 1 0 22h-80a11 11 0 0 0 0 22h80a11 11 0 0 1 0 22h-80a11 11 0 0 0 0 22h74" fill="none" stroke={small.dark} strokeWidth="17" />
        <path d="M256 452h84a11 11 0 0 1 0 22h-80a11 11 0 0 0 0 22h80a11 11 0 0 1 0 22h-80a11 11 0 0 0 0 22h74" fill="none" stroke={small.fill} strokeWidth="13" />
        <path d="M262 448h74M262 470h74M262 492h74M262 514h64" fill="none" stroke="#fff" strokeOpacity="0.35" strokeWidth="2" />
      </g>

      {/* ── bladder */}
      <g opacity={bladder.opacity}>
        <path d="M276 520c0-14 48-14 48 0 0 16-11 26-24 26s-24-10-24-26z" fill={bladder.fill} stroke={bladder.dark} strokeWidth={sw} />
        <Sheen d="M282 520c6-6 18-8 26-4-10 0-18 4-24 12z" />
      </g>
      </g>

      {/* ── a femur, standing in for bones and minerals */}
      <g opacity={bone.opacity} transform="rotate(3 250 684)">
        <rect x="242" y="606" width="16" height="156" rx="8" fill={bone.fill} stroke={bone.dark} strokeWidth={sw} />
        <ellipse cx="252" cy="602" rx="16" ry="11" fill={bone.fill} stroke={bone.dark} strokeWidth={sw} />
        <ellipse cx="248" cy="766" rx="16" ry="11" fill={bone.fill} stroke={bone.dark} strokeWidth={sw} />
      </g>

      {/* ── blood: the vein on the inner arm, where the sample was drawn */}
      <g opacity={blood.opacity}>
        <path d="M448 300c6 40 8 80 6 96" fill="none" stroke={veins.fill} strokeWidth="2.5" strokeOpacity="0.8" />
        <path d="M452 394c10 14 14 22 14 30a14 14 0 0 1-28 0c0-8 4-16 14-30z" fill={blood.fill} stroke={blood.dark} strokeWidth={sw} />
        <Sheen d="M446 412c2-6 4-10 6-12-2 6-2 12 0 18-4-2-6-4-6-6z" />
      </g>
    </g>
  );
}

/* ── callouts ───────────────────────────────────────────────────────────── */

const VIEW = { x: -210, y: 0, w: 1020, h: 1010 };
const LEFT_CX = -128;
const RIGHT_CX = 728;
const R = 25;

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
        Organs drawn faintly were not part of this report.
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
          {/* ears */}
          <ellipse cx="250" cy="70" rx="7" ry="11" fill={SKIN} stroke={SKIN_EDGE} strokeWidth="1.2" />
          <ellipse cx="350" cy="70" rx="7" ry="11" fill={SKIN} stroke={SKIN_EDGE} strokeWidth="1.2" />
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
            ['#e9c4c8', 'Not part of this report'],
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
