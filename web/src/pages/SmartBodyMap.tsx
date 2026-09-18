import { useEffect, useRef, type ReactNode } from 'react';
import { BODY_OUTLINE_D, BODY_OUTLINE_TRANSFORM } from './bodyOutline';

/**
 * "Your body map" — the Smart Report's format-v2 page.
 *
 * A real anatomical illustration, not a drawing of our own: the organs are
 * the medical renderings from "Man shadow anatomy.svg" (Mikael Häggström,
 * Wikimedia Commons, CC0 1.0 public domain), each one its own image in
 * public/branding/anatomy, placed exactly where the artist placed it inside
 * the same drawing's body outline. Callouts on either side carry the organ's
 * own picture and a leader line to it, the way an anatomy poster does.
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
const SKIN = '#f4dccf';
const SKIN_EDGE = '#e6c3b0';

type State = 'rest' | 'ok' | 'attn';

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
  m: [number, number, number, number, number, number];
  system?: string;
  follows?: string;
  /** For a layer shared by two systems: the part of the image (a clip in its own frame) this entry paints. */
  clip?: { y0: number; y1: number };
}

const ID: [number, number, number, number, number, number] = [1, 0, 0, 1, 0, 0];

/** In drawing order, back to front, as the source file draws them. */
const LAYERS: Layer[] = [
  // the bones of the upper arm only: the whole limb in red swamped the figure
  { key: 'arm-bones', file: 'arm-bones.gif', x: 172.08743, y: 593.96173, w: 286, h: 843, m: ID, system: 'vitamins', clip: { y0: 0, y1: 0.46 } },
  { key: 'brain', file: 'brain.gif', x: 544.06586, y: 97.417419, w: 195.72717, h: 172.23991, m: ID, system: 'hormones' },
  { key: 'lymph', file: 'lymph.gif', x: 558.14343, y: 367.61545, w: 181, h: 150, m: ID, system: 'infection' },
  { key: 'trachea', file: 'trachea.gif', x: 613.5813, y: 289.86914, w: 56, h: 201, m: ID },
  { key: 'larynx', file: 'larynx.gif', x: 602.685, y: 405.01453, w: 78, h: 96, m: ID },
  { key: 'veins', file: 'veins.gif', x: -827.09784, y: 669.3103, w: 141, h: 588, m: [-0.9875, 0.1577, 0.1577, 0.9875, 0, 0], system: 'blood' },
  { key: 'thyroid', file: 'thyroid.gif', x: 596.8125, y: 416.89005, w: 102, h: 89, m: ID, system: 'thyroid' },
  { key: 'kidneys', file: 'urinary.png', x: 506.0394, y: 797.99493, w: 284, h: 425.68628, m: ID, system: 'kidney', clip: { y0: 0, y1: 0.62 } },
  { key: 'bladder', file: 'urinary.png', x: 506.0394, y: 797.99493, w: 284, h: 425.68628, m: ID, system: 'urine', clip: { y0: 0.62, y1: 1 } },
  { key: 'spleen', file: 'spleen.gif', x: 560.62506, y: 846.58533, w: 95.372612, h: 110.49987, m: [0.9875, -0.1574, 0.1574, 0.9875, 0, 0], follows: 'infection' },
  { key: 'pancreas', file: 'pancreas.png', x: 440.41748, y: 881.45551, w: 224.59381, h: 135.50154, m: [0.9904, -0.1381, 0.1381, 0.9904, 0, 0], system: 'diabetes' },
  { key: 'stomach', file: 'stomach.png', x: 414.48322, y: 816.49908, w: 230.74571, h: 196.66655, m: [0.9891, -0.1476, 0.1711, 0.9853, 0, 0] },
  { key: 'intestines', file: 'intestines.gif', x: 437.50711, y: 816.84589, w: 430.75607, h: 409.41751, m: ID },
  { key: 'lungs', file: 'lungs.png', x: 488.62833, y: 480.78677, w: 312.85785, h: 314.35516, m: ID },
  { key: 'liver', file: 'liver.png', x: 497.94052, y: 715.14966, w: 262.51471, h: 192.5744, m: ID, system: 'liver' },
  { key: 'heart', file: 'heart.png', x: 575.42419, y: 478.55069, w: 153.08029, h: 274.67694, m: ID, system: 'heart' },
  { key: 'gallbladder', file: 'gallbladder.png', x: 619.59967, y: 474.05014, w: 71, h: 60.06398, m: [0.9963, -0.0862, 0.0862, 0.9963, -108.4392, 423.1945], follows: 'liver' },
];

/**
 * Where each system's callout points and which side it sits, in the
 * drawing's canvas. `at` is on the organ; `pic` is the layer whose picture
 * the callout disc shows and the window (in the drawing) it shows of it.
 */
const ORGAN_MAP: ReadonlyArray<{
  id: string; side: 'left' | 'right'; at: [number, number]; pic: string; win: [number, number, number, number];
}> = [
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

/* ── the page's frame ───────────────────────────────────────────────────── */

/** The drawing cropped at mid-thigh, with a column each side for callouts. */
const VIEW = { x: -120, y: 70, w: 1520, h: 1250 };
const LEFT_CX = 30;
const RIGHT_CX = 1250;
const R = 58;

function slotY(n: number, i: number): number {
  const top = 200;
  const bottom = 1090;
  if (n <= 1) return 520;
  const span = Math.min(bottom - top, (n - 1) * 230);
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
  const clipId = layer.clip ? `bm-clip-${layer.key}` : undefined;
  return (
    <g opacity={st.opacity} filter={st.filter} clipPath={clipId ? `url(#${clipId})` : undefined}>
      {layer.clip && (
        <clipPath id={clipId}>
          <rect
            x={layer.x} y={layer.y + layer.h * layer.clip.y0} width={layer.w} height={layer.h * (layer.clip.y1 - layer.clip.y0)}
            transform={`matrix(${layer.m.join(' ')})`}
          />
        </clipPath>
      )}
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

function Callout({ sys, side, y, at, pic, win, renderPic }: {
  sys: BodySystem;
  side: 'left' | 'right';
  y: number;
  at: [number, number];
  pic: string;
  win: [number, number, number, number];
  renderPic: (layerKey: string, win: [number, number, number, number], size: number) => ReactNode;
}) {
  const cx = side === 'left' ? LEFT_CX : RIGHT_CX;
  const attn = sys.alerts > 0;
  const c = attn ? ATTN : GREEN;
  const edgeX = side === 'left' ? cx + R : cx - R;
  const kneeX = side === 'left' ? edgeX + 50 : edgeX - 50;
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
        strokeWidth={attn ? 3.2 : 2.4}
        strokeLinejoin="round"
      />
      <circle cx={at[0]} cy={at[1]} r="8" fill="#fff" stroke={c} strokeWidth="3.5" />
      {attn && <circle cx={at[0]} cy={at[1]} r="18" fill="none" stroke={ATTN} strokeOpacity="0.35" strokeWidth="4" />}

      {attn && <circle cx={cx} cy={y} r={R + 10} fill={ATTN} fillOpacity="0.1" />}
      <circle cx={cx} cy={y} r={R} fill="#fff" stroke={c} strokeWidth="4" />
      <clipPath id={`bm-disc-${sys.id}`}><circle cx={cx} cy={y} r={R - 5} /></clipPath>
      <g clipPath={`url(#bm-disc-${sys.id})`}>
        <svg x={cx - R + 5} y={y - R + 5} width={2 * R - 10} height={2 * R - 10} viewBox={`${win[0]} ${win[1]} ${win[2]} ${win[3]}`} preserveAspectRatio="xMidYMid meet">
          {renderPic(pic, win, 2 * R - 10)}
        </svg>
      </g>

      {lines.map((l, i) => (
        <text key={i} x={cx} y={y + R + 30 + i * 24} textAnchor="middle" fontSize="21" fontWeight="800" fill={INK}>
          {l}
        </text>
      ))}
      <text x={cx} y={y + R + 30 + lines.length * 24} textAnchor="middle" fontSize="16.5" fontWeight="700" fill={c}>
        {status}
      </text>
    </g>
  );
}

export function BodyMapPage({ systems, name, title, onReady }: {
  systems: BodySystem[];
  name: string;
  title: (children: ReactNode) => ReactNode;
  /** Called once every organ image has loaded (or failed) — the print route waits for it. */
  onReady?: () => void;
}) {
  const by = new Map(systems.map((s) => [s.id, s]));
  const placed = ORGAN_MAP.filter((o) => by.has(o.id));
  const left = placed.filter((o) => o.side === 'left');
  const right = placed.filter((o) => o.side === 'right');
  const unmapped = systems.filter((s) => !ORGAN_MAP.some((o) => o.id === s.id));
  const attention = systems.filter((s) => s.alerts > 0 && by.has(s.id));
  const tested = placed.length;

  // Readiness: the figure's layers plus one picture per callout disc.
  const expected = LAYERS.length + placed.length;
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

  const byKey = new Map(LAYERS.map((l) => [l.key, l]));
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
        <svg viewBox={`${VIEW.x} ${VIEW.y} ${VIEW.w} ${VIEW.h}`} width="100%" style={{ display: 'block' }} role="img" aria-label="Body map of the systems tested">
          <defs>
            {/* at rest: nearly grey, so the tested organs carry the colour */}
            <filter id="bm-rest" colorInterpolationFilters="sRGB">
              <feColorMatrix type="saturate" values="0.12" />
            </filter>
            {/* attention: the rendering pushed to red, over a soft red glow */}
            <filter id="bm-attn" x="-15%" y="-15%" width="130%" height="130%" colorInterpolationFilters="sRGB">
              {/* a red cast that keeps the rendering's own shading, not a flat fill */}
              <feColorMatrix
                in="SourceGraphic"
                type="matrix"
                values="0.85 0.20 0.20 0 0.06   0.12 0.42 0.10 0 0   0.12 0.10 0.42 0 0   0 0 0 1 0"
                result="tinted"
              />
              <feFlood floodColor="#d0262d" floodOpacity="0.55" result="red" />
              <feComposite in="red" in2="SourceAlpha" operator="in" result="redShape" />
              <feGaussianBlur in="redShape" stdDeviation="9" result="glow" />
              <feMerge>
                <feMergeNode in="glow" />
                <feMergeNode in="tinted" />
              </feMerge>
            </filter>
            <clipPath id="bm-crop"><rect x={VIEW.x} y={VIEW.y} width={VIEW.w} height={VIEW.h} /></clipPath>
          </defs>

          <g clipPath="url(#bm-crop)">
            <path d={BODY_OUTLINE_D} transform={BODY_OUTLINE_TRANSFORM} fill={SKIN} stroke={SKIN_EDGE} strokeWidth="2" strokeLinejoin="round" />
            {LAYERS.map((l) => (
              <OrganImage key={l.key} layer={l} state={stateOf(l, by)} onLoad={tick} />
            ))}
          </g>

          {left.map((o, i) => (
            <Callout key={o.id} sys={by.get(o.id)!} side="left" y={slotY(left.length, i)} at={o.at} pic={o.pic} win={o.win} renderPic={renderPic} />
          ))}
          {right.map((o, i) => (
            <Callout key={o.id} sys={by.get(o.id)!} side="right" y={slotY(right.length, i)} at={o.at} pic={o.pic} win={o.win} renderPic={renderPic} />
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
