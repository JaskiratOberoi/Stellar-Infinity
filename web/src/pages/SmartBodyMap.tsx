import type { ReactNode } from 'react';

/**
 * "Your body map" — the Smart Report's format-v2 page.
 *
 * One figure, front on, with the organs and systems this report LOOKED AT
 * drawn in and labelled, and the ones that need attention in red. The organs
 * a report did not cover stay on the figure as faint outlines so it still
 * reads as a body, but carry no label — the page is about what was tested.
 *
 * The systems are the booklet's own body-system categories (SmartMeta), so
 * the map is a picture of the same grouping the chapters use: "Heart &
 * Cholesterol" points at the heart, "Blood Sugar" at the pancreas, and so on.
 * A system is red when any result in it is flagged — the same rule as the
 * Attention badge, deliberately binary; the Low/Moderate/High meter belongs to
 * the chapter, not to a page a patient reads in two seconds.
 *
 * Asked for on 2026-09-16 as page 4 of format v2, modelled on a labelled
 * anatomy poster: callouts with the organ glyph on either side, a leader line
 * from each to its organ.
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

const HEALTHY = '#5b50c0';
const HEALTHY_SOFT = '#ece9f8';
const HEALTHY_TEXT = '#1b7a44';
const ATTN = '#c62b30';
const ATTN_SOFT = '#fceaea';
const UNTESTED = '#d9dce7';
const SKIN = '#eef0f7';
const INK = '#232838';
const MUTED = '#616779';
const FAINT = '#8a8fa0';
const HAIR = '#e6e8f0';
const LEADER = '#a3a8bd';

/**
 * Where each body system lives on the figure, and which side its callout
 * sits. `at` is the point the leader line ends on; the callout slots run down
 * each side in this order, so lines never cross however many are tested.
 */
const ORGAN_MAP: ReadonlyArray<{ id: string; side: 'left' | 'right'; at: [number, number]; icon: string }> = [
  { id: 'thyroid', side: 'left', at: [438, 126], icon: 'thyroid' },
  { id: 'liver', side: 'left', at: [412, 262], icon: 'liver' },
  { id: 'kidney', side: 'left', at: [408, 318], icon: 'kidney' },
  { id: 'urine', side: 'left', at: [450, 404], icon: 'flask' },
  { id: 'vitamins', side: 'left', at: [424, 476], icon: 'bone' },
  { id: 'hormones', side: 'right', at: [462, 56], icon: 'spark' },
  { id: 'heart', side: 'right', at: [466, 212], icon: 'heart' },
  { id: 'blood', side: 'right', at: [548, 244], icon: 'blood' },
  { id: 'infection', side: 'right', at: [506, 270], icon: 'shield' },
  { id: 'diabetes', side: 'right', at: [478, 298], icon: 'pancreas' },
];

/** The figure is drawn in a 900×624 space and scaled up a little about its
 *  own axis so it fills the page; the leader targets scale with it. */
const FIG_SCALE = 1.1;
const FIG_AXIS = 450;
const VIEW_H = 690;
const SLOT_Y = [92, 222, 352, 482, 612];
const LEFT_CX = 150;
const RIGHT_CX = 750;
const R = 25;

function scaled([x, y]: [number, number]): [number, number] {
  return [FIG_AXIS + (x - FIG_AXIS) * FIG_SCALE, y * FIG_SCALE];
}

/** A system's title on one line when it fits beside the disc, else broken at
 *  its natural join (" & ", ", ") nearest the middle, or the middle-most space. */
function splitTitle(title: string): string[] {
  if (title.length <= 15) return [title];
  const mid = title.length / 2;
  const joins = [' & ', ', '];
  let best = -1;
  let bestDist = Infinity;
  for (const j of joins) {
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

function tone(sys: BodySystem | undefined): { fill: string; edge: string } {
  if (!sys) return { fill: UNTESTED, edge: UNTESTED };
  return sys.alerts > 0 ? { fill: ATTN, edge: ATTN } : { fill: HEALTHY, edge: HEALTHY };
}

/** The organs. Each is drawn in the tone of the system it stands for; a
 *  system this report never touched leaves its organ faint. */
function Organs({ by }: { by: Map<string, BodySystem> }) {
  const t = (id: string) => tone(by.get(id)).fill;
  return (
    <g>
      {/* brain — the pituitary sits here, so the hormone system points at it */}
      <g fill={t('hormones')}>
        <path d="M424 58c0-16 14-28 32-28 6 0 11 1 15 4 4-3 9-4 15-4 16 0 28 12 28 28 0 14-11 26-27 27h-36c-15-1-27-13-27-27z" />
        <path d="M436 50c8-2 14-4 20-2M446 66c8 2 16 2 24 0M470 44c6-2 12-2 18 0" fill="none" stroke="#fff" strokeOpacity="0.55" strokeWidth="1.6" strokeLinecap="round" />
      </g>
      {/* thyroid — butterfly on the windpipe */}
      <g fill={t('thyroid')}>
        <path d="M450 122c-2-6-7-10-13-10-8 0-13 6-13 14 0 9 6 16 13 16 6 0 10-4 13-9 3 5 7 9 13 9 7 0 13-7 13-16 0-8-5-14-13-14-6 0-11 4-13 10z" />
        <rect x="447" y="128" width="6" height="16" rx="3" fill="#fff" fillOpacity="0.5" />
      </g>
      {/* lungs — never a category; stay faint */}
      <g fill={UNTESTED}>
        <path d="M436 176c-16-3-32 18-32 50 0 26 12 40 28 38 6-1 8-6 8-12v-70c0-3-1-5-4-6z" />
        <path d="M464 176c16-3 32 18 32 50 0 26-12 40-28 38-6-1-8-6-8-12v-70c0-3 1-5 4-6z" />
      </g>
      {/* heart — patient's left, so the viewer's right of centre */}
      <path
        d="M462 240c-20-14-28-26-25-38 2-10 12-15 21-11 3 1 5 3 7 6 3-4 7-6 11-6 9 0 17 7 16 18-1 12-12 22-30 31z"
        fill={t('heart')}
      />
      {/* liver — under the right lung, viewer's left */}
      <path
        d="M394 254c2-10 14-15 30-13l40 7c8 1 9 8 3 12l-30 18c-12 7-30 5-38-4-5-6-6-13-5-20z"
        fill={t('liver')}
      />
      {/* stomach — never a category; faint, tucked under the left lung */}
      <path d="M470 262c10-8 24-6 30 2 6 8 2 20-8 24-8 3-16 0-20-6-3-5-5-13-2-20z" fill={UNTESTED} />
      {/* spleen — behind the stomach; the immune system's marker */}
      <path d="M505 260c6-2 12 3 13 10 1 8-3 16-9 17-6 1-11-4-12-11-1-7 2-14 8-16z" fill={t('infection')} />
      {/* pancreas — behind the stomach, across the midline */}
      <path d="M430 296c14-8 36-8 52-2 6 2 6 8 0 10-10 3-20 1-30 0-8 0-16 2-22-2-3-2-3-4 0-6z" fill={t('diabetes')} />
      {/* kidneys */}
      <g fill={t('kidney')}>
        <path d="M412 300c8 0 13 8 13 20s-5 22-13 22c-6 0-9-4-10-10 2-2 4-5 4-9 0-4-2-7-4-9 1-8 4-14 10-14z" />
        <path d="M488 300c-8 0-13 8-13 20s5 22 13 22c6 0 9-4 10-10-2-2-4-5-4-9 0-4 2-7 4-9-1-8-4-14-10-14z" />
      </g>
      {/* intestines — never a category; faint coil */}
      <g fill="none" stroke={UNTESTED} strokeWidth="9" strokeLinecap="round">
        <path d="M418 342c20-6 44-6 64 0M418 358c20 6 44 6 64 0M420 374c20-6 40-6 60 0" />
      </g>
      {/* bladder */}
      <ellipse cx="450" cy="404" rx="16" ry="12" fill={t('urine')} />
      {/* femur — stands in for bones and minerals */}
      <g fill={t('vitamins')}>
        <path d="M424 452c-5-4-11-3-14 2-3 4-2 9 2 12l-2 60c-4 2-6 7-4 12 3 5 9 6 14 3 5 3 11 2 14-3 2-5 0-10-4-12l2-60c4-3 5-8 2-12-3-5-9-6-14-2z" />
      </g>
      {/* blood — the vein on the inner arm, where the sample was drawn */}
      <g fill={t('blood')}>
        <path d="M548 226c8 10 12 16 12 22a12 12 0 0 1-24 0c0-6 4-12 12-22z" />
      </g>
    </g>
  );
}

function Figure() {
  return (
    <g fill={SKIN}>
      <ellipse cx="450" cy="62" rx="34" ry="40" />
      <rect x="434" y="96" width="32" height="28" />
      {/* torso: shoulders to hips */}
      <path d="M396 132c30-14 78-14 108 0 6 3 8 8 8 14l6 100c2 40-2 80-10 118-2 10-8 14-18 14h-80c-10 0-16-4-18-14-8-38-12-78-10-118l6-100c0-6 2-11 8-14z" />
      {/* arms */}
      <rect x="352" y="140" width="38" height="220" rx="19" transform="rotate(9 371 150)" />
      <rect x="510" y="140" width="38" height="220" rx="19" transform="rotate(-9 529 150)" />
      {/* legs */}
      <rect x="402" y="372" width="44" height="240" rx="22" />
      <rect x="454" y="372" width="44" height="240" rx="22" />
    </g>
  );
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
  const c = attn ? ATTN : HEALTHY;
  const edgeX = side === 'left' ? cx + R : cx - R;
  const labelX = side === 'left' ? cx - R - 10 : cx + R + 10;
  const anchor = side === 'left' ? 'end' : 'start';
  const status = attn
    ? `${sys.alerts} of ${sys.tests} to look at`
    : `${sys.tests} ${sys.tests === 1 ? 'result' : 'results'} · healthy`;
  const lines = splitTitle(sys.title);
  const [tx, ty] = scaled(at);
  return (
    <g>
      {/* leader: a gentle elbow so it reads as a pointer, not a graph */}
      <path
        d={`M${edgeX} ${y} L${side === 'left' ? edgeX + 30 : edgeX - 30} ${y} L${tx} ${ty}`}
        fill="none"
        stroke={attn ? ATTN : LEADER}
        strokeWidth={attn ? 1.8 : 1.4}
        strokeLinejoin="round"
      />
      <circle cx={tx} cy={ty} r="4.5" fill="#fff" stroke={c} strokeWidth="2" />
      {attn && <circle cx={tx} cy={ty} r="9" fill="none" stroke={ATTN} strokeOpacity="0.35" strokeWidth="2" />}

      {/* the callout disc */}
      {attn && <circle cx={cx} cy={y} r={R + 5} fill={ATTN} fillOpacity="0.1" />}
      <circle cx={cx} cy={y} r={R} fill="#fff" stroke={c} strokeWidth="2.2" />
      <foreignObject x={cx - 13} y={y - 13} width="26" height="26">
        <div style={{ width: '26px', height: '26px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {renderIcon(icon, c, 24)}
        </div>
      </foreignObject>

      {/* label, on the outer side; a long title breaks onto two lines */}
      {lines.map((l, i) => (
        <text
          key={i}
          x={labelX}
          y={lines.length === 1 ? y - 3 : y - 10 + i * 14}
          textAnchor={anchor}
          fontSize="12"
          fontWeight="800"
          fill={INK}
        >
          {l}
        </text>
      ))}
      <text x={labelX} y={lines.length === 1 ? y + 12 : y + 19} textAnchor={anchor} fontSize="9.5" fontWeight="700" fill={attn ? ATTN : HEALTHY_TEXT}>
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
      <div style={{ fontSize: '12px', color: MUTED, lineHeight: 1.6, marginTop: '8px', maxWidth: '640px' }}>
        {name}, this report looked at{' '}
        <strong style={{ color: INK }}>{tested} {tested === 1 ? 'organ or body system' : 'organs and body systems'}</strong>
        {unmapped.length > 0 && (
          <> (plus {unmapped.map((u) => u.title.toLowerCase()).join(', ')})</>
        )}
        . Each one is marked on the figure below —{' '}
        <strong style={{ color: HEALTHY }}>indigo</strong> where everything sits in a healthy range,{' '}
        <strong style={{ color: ATTN }}>red</strong> where something is worth a closer look with your doctor.
      </div>

      <div
        style={{
          marginTop: '12px',
          border: `1px solid ${HAIR}`,
          borderRadius: '16px',
          background: 'linear-gradient(180deg, #fbfbfe 0%, #ffffff 100%)',
          padding: '10px 6px 4px',
          breakInside: 'avoid',
          pageBreakInside: 'avoid',
        }}
      >
        <svg viewBox={`0 0 900 ${VIEW_H}`} width="100%" style={{ display: 'block' }} role="img" aria-label="Body map of the systems tested">
          <g transform={`translate(${FIG_AXIS} 0) scale(${FIG_SCALE}) translate(${-FIG_AXIS} 0)`}>
            <Figure />
            <Organs by={by} />
          </g>
          {left.map((o, i) => (
            <Callout key={o.id} sys={by.get(o.id)!} side="left" y={SLOT_Y[i]} icon={o.icon} at={o.at} renderIcon={renderIcon} />
          ))}
          {right.map((o, i) => (
            <Callout key={o.id} sys={by.get(o.id)!} side="right" y={SLOT_Y[i]} icon={o.icon} at={o.at} renderIcon={renderIcon} />
          ))}
        </svg>

        {/* legend */}
        <div style={{ display: 'flex', gap: '18px', justifyContent: 'center', flexWrap: 'wrap', padding: '4px 0 6px', fontSize: '9.5px', fontWeight: 700, color: MUTED }}>
          {[
            [HEALTHY, 'Tested · healthy'],
            [ATTN, 'Tested · needs attention'],
            [UNTESTED, 'Not part of this report'],
          ].map(([c, l]) => (
            <span key={l} style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
              <span style={{ width: '10px', height: '10px', borderRadius: '999px', background: c, display: 'inline-block' }} />
              {l}
            </span>
          ))}
        </div>
      </div>

      {attention.length > 0 ? (
        <div style={{ marginTop: '12px', background: ATTN_SOFT, border: `1px solid ${ATTN}44`, borderRadius: '12px', padding: '11px 15px', breakInside: 'avoid' }}>
          <div style={{ fontSize: '11.5px', fontWeight: 800, color: ATTN }}>
            Marked in red — worth discussing with your doctor
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '5px 18px', marginTop: '7px' }}>
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
        <div style={{ marginTop: '12px', background: HEALTHY_SOFT, border: `1px solid ${HEALTHY}44`, borderRadius: '12px', padding: '11px 15px', fontSize: '11px', color: INK, breakInside: 'avoid' }}>
          <span style={{ fontWeight: 800, color: HEALTHY }}>Nothing in red. </span>
          <span style={{ color: MUTED }}>Every organ and system this report looked at came back in a healthy range.</span>
        </div>
      )}
      <div style={{ fontSize: '8.5px', color: FAINT, marginTop: '8px', lineHeight: 1.5 }}>
        The figure is a guide to where each set of tests points, not a scan of your body. A red mark means a result
        in that area fell outside its usual range — see the chapter for that system for what it can mean.
      </div>
    </div>
  );
}
