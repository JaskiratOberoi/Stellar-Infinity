import type { ReportSigner, ProcessingUnit } from './ReportViewer';
import {
  caloriesForSex,
  calorieBandForAge,
  screeningsFor,
  CALORIE_DEFINITIONS,
  WELLNESS_PILLARS,
  WELLNESS_TIPS,
} from '../lib/wellnessData';

/**
 * The Smart Report booklet.
 *
 * A PORT of Telo's components/reporting/smart-report.tsx, kept structurally
 * identical — cover, welcome letter, snapshot, health areas at a glance, a
 * chapter per body system, the wellness plan and the doctor's summary. Noble
 * hands this to patients from both products and they have to be the same
 * document, so the layout below is Telo's and the numbers in it are Telo's.
 *
 * WHAT DIFFERS, AND ONLY THIS: where the knowledge comes from. Telo resolves
 * friendly names, explanations and advice in the browser from smartMeta.ts and
 * builds its gauges from the raw range text. Infinity's API has already done
 * all of that (SmartReportService + SmartMeta + SmartRange, themselves ported
 * from the same source), so this file consumes a finished SmartSection[]
 * instead of flattening a department tree. The rendering is unchanged.
 */

/* ── the shape the API sends (see SmartReportService.cs) ─────────────────── */

export interface Gauge {
  /** both | max | min — whether the range is two-sided or one-sided. */
  kind: string;
  low: number | null;
  high: number | null;
  value: number;
  /** 0..1 position along the track. */
  pos: number;
  zone: string;
}

export interface ApiAnalyte {
  testCode: string | null;
  lisName: string;
  friendlyName: string | null;
  value: string | null;
  unit: string | null;
  rangeText: string | null;
  abnormal: boolean;
  zone: string;
  gauge: Gauge | null;
  what: string | null;
  /** What an out-of-range reading can mean. Null when the reading is normal. */
  meaning: string | null;
  /** For an abnormal reading, what to do; for a healthy one, the "keep it up" note. */
  advice: string | null;
  comments: string | null;
}

export interface ApiSection {
  categoryId: string;
  title: string;
  tagline: string;
  about: string | null;
  analytes: ApiAnalyte[];
  abnormalCount: number;
}

export interface SmartBookletData {
  sid: string;
  patientName: string | null;
  sex: string | null;
  age: number | null;
  ageUnit: string | null;
  clientCode: string | null;
  refDoctor: string | null;
  sampleDrawn: string | null;
  reportedAt: string | null;
  totalAnalytes: number;
  abnormalCount: number;
  withheldCount: number;
  fullyAuthorised: boolean;
  sections: ApiSection[];
  signers: ReportSigner[];
  processedAt: ProcessingUnit | null;
  qr: string | null;
  printedAt: string | null;
}

/** The gauge model the layout below was written against — the API's Gauge. */
type GaugeModel = Gauge;

/** How far outside its range a value sits — drives the advice engine's urgency
 *  nudge. 'mild' ≤15% beyond the bound, 'moderate' ≤50%, 'marked' beyond that. */
function severityOf(g: GaugeModel | null): 'mild' | 'moderate' | 'marked' | null {
  if (!g || g.zone === 'normal') return null;
  const { value, low, high, kind } = g;
  let over = 0;
  if (kind === 'both' && low != null && high != null) {
    const band = high - low || 1;
    over = g.zone === 'high' ? (value - high) / band : (low - value) / band;
  } else if (kind === 'max' && high != null) {
    over = (value - high) / (Math.abs(high) || 1);
  } else if (kind === 'min' && low != null) {
    over = (low - value) / (Math.abs(low) || 1);
  }
  if (over <= 0.15) return 'mild';
  if (over <= 0.5) return 'moderate';
  return 'marked';
}

/**
 * "Smart Report" — a warm, patient-first wellness booklet, modelled on Quest
 * Diagnostics' "Blueprint for Wellness". A SEPARATE format from the default
 * clinical report (components/reporting/tsh-report.tsx): same data
 * (LabReportData), a very different read.
 *
 * Structure mirrors the Quest booklet: a full-bleed COVER, an elegant WELCOME
 * letter ("Dear …" + what this report is), then the RESULTS — a snapshot, the
 * body-system areas at a glance, and each result with a big Healthy / Attention
 * badge, a friendly name, a plain "what this is", and a large Alert↔Normal GAUGE
 * as the hero; out-of-range results add "what this can mean" and "what you can
 * do". Knowledge comes from lib/report/smartMeta.ts.
 *
 * Prints WITHOUT the Noble letterhead (the smart PDF route merges headless, no
 * page numbers); the print fragment makes page 1 full-bleed via `@page :first`.
 */

// ── Brand palette (inline hex, print-safe) ──
const BRAND = '#2B246A'; // Noble indigo
const BRAND2 = '#4b3fb0';
const BRAND_SOFT = '#EEEDF6';
const INK = '#232838';
const MUTED = '#616779';
const FAINT = '#8a8fa0';
const HAIR = '#e6e8f0';
const GREEN = '#1b7a44';
const GREEN_SOFT = '#e8f5ee';
const TRACK_GREEN = '#2ba45f';
const RED = '#c62b30';
const RED_SOFT = '#fceaea';
const TRACK_RED = '#e14b50';
const AMBER_SOFT = '#fff6e6';
const AMBER_LINE = '#e0a534';

/**
 * One printed result.
 *
 * `row` keeps the shape Telo's components read (name/value/unit/range/
 * comments) so the layout is untouched; `what`, `meaning` and `advice` are the
 * text the API already resolved, replacing Telo's in-browser smartMeta lookups.
 */
interface Analyte {
  categoryId: string;
  friendlyName: string;
  row: {
    name: string | null;
    value: string | null;
    unit: string | null;
    range: string | null;
    comments: string | null;
  };
  gauge: GaugeModel | null;
  alert: boolean;
  what: string | null;
  meaning: string | null;
  advice: string | null;
}

/** A body system, as the API grouped it. Stands in for Telo's SMART_CATEGORIES. */
interface Category {
  id: string;
  title: string;
  tagline: string;
  about: string | null;
}

type RiskLevel = 'low' | 'moderate' | 'high';

/** Per-body-system visual identity: an organ icon + an accent colour, used on
 *  the chapter intro cards and the "health areas at a glance" grid. */
const CATEGORY_VIS: Record<string, { icon: string; ink: string; soft: string }> = {
  heart: { icon: 'heart', ink: '#c1466a', soft: '#fdeef0' },
  diabetes: { icon: 'pancreas', ink: '#b7791f', soft: '#fff3e0' },
  kidney: { icon: 'kidney', ink: '#0f766e', soft: '#e2f4f1' },
  liver: { icon: 'liver', ink: '#a15c2b', soft: '#f6ede3' },
  thyroid: { icon: 'thyroid', ink: '#4b3fb0', soft: '#ece9f8' },
  blood: { icon: 'blood', ink: '#c62b30', soft: '#fceaea' },
  vitamins: { icon: 'bone', ink: '#7c6f1f', soft: '#f6f3df' },
  hormones: { icon: 'spark', ink: '#9333a8', soft: '#f6e9fa' },
  infection: { icon: 'shield', ink: '#1b6fb0', soft: '#e6f1fa' },
  urine: { icon: 'flask', ink: '#b7791f', soft: '#fdf4dc' },
  other: { icon: 'flask', ink: '#4b5563', soft: '#eef0f3' },
};

function categoryVis(id: string) {
  return CATEGORY_VIS[id] ?? CATEGORY_VIS.other;
}

/** Risk-level palette + copy (mirrors Quest's Low / Moderate / High meter). */
const RISK_META: Record<RiskLevel, { idx: number; label: string; verdict: string; color: string; track: string; soft: string }> = {
  low: { idx: 0, label: 'Low', verdict: 'Looking healthy', color: GREEN, track: TRACK_GREEN, soft: GREEN_SOFT },
  moderate: { idx: 1, label: 'Moderate', verdict: 'Worth a look', color: '#9a6a10', track: '#e0a534', soft: AMBER_SOFT },
  high: { idx: 2, label: 'High', verdict: 'Needs attention', color: RED, track: TRACK_RED, soft: RED_SOFT },
};

/** Roll a body system's individual results up into one Low/Moderate/High risk:
 *  no flags → Low; a flag within ~50% of the bound → Moderate; a marked
 *  deviation → High. Deliberately mirrors the per-result severity engine. */
function categoryRisk(list: Analyte[]): { level: RiskLevel; alerts: number } {
  let level: RiskLevel = 'low';
  let alerts = 0;
  for (const a of list) {
    if (!a.alert) continue;
    alerts++;
    const sev = severityOf(a.gauge);
    if (sev === 'marked') level = 'high';
    else if (level !== 'high') level = 'moderate';
  }
  return { level, alerts };
}

function firstName(full: string | null): string {
  const n = (full ?? '').trim();
  if (!n) return 'there';
  const parts = n.split(/\s+/).filter((p) => !/^(mr|mrs|ms|dr|master|miss)\.?$/i.test(p));
  return (parts[0] ?? n.split(/\s+/)[0]) || 'there';
}

function titleCaseName(full: string | null): string {
  const n = (full ?? '').trim();
  if (!n) return '—';
  return n
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function genderLabel(sex: string | null): string {
  if (!sex) return '—';
  const s = sex.trim();
  if (/^m/i.test(s)) return 'Male';
  if (/^f/i.test(s)) return 'Female';
  return s;
}

/** Salutations that may already sit in front of a patient's name. */
const NAME_TITLE = /^(mr|mrs|ms|miss|master|dr|smt|shri|sri|kum|km|baby|b\/o|c\/o|w\/o|s\/o|d\/o)\.?\s/i;

/** "Prepared for" display name with a courtesy title. The LIS patient master
 *  stores only name + gender, so we derive Mr./Ms. from sex — unless the name
 *  already carries a title (then it's kept as-is). Marital titles (Mrs.) can't
 *  be told apart from Ms. by gender alone, so female defaults to Ms. */
function preparedForName(patientName: string | null, sex: string | null): string {
  const raw = (patientName ?? '').trim();
  const nm = titleCaseName(patientName);
  if (!raw || nm === '—') return nm;
  if (NAME_TITLE.test(raw)) return nm; // already titled
  const s = (sex ?? '').trim();
  const sal = /^m/i.test(s) ? 'Mr. ' : /^f/i.test(s) ? 'Ms. ' : '';
  return `${sal}${nm}`;
}

function ageLabel(age: number | null, unit: string | null): string {
  if (age == null) return '—';
  return `${age} ${(unit ?? 'yrs').replace(/year\(s\)/i, 'yrs').trim()}`;
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

/** Cell types of the differential white-cell count, reported both as a
 *  percentage and as an absolute count. */
const DLC_CELLS = /^(Neutrophils|Lymphocytes|Monocytes|Eosinophils|Basophils)$/;

/** The card title for a row: the knowledge base's friendly name, falling back
 *  to the lab test name. For a differential count we distinguish the absolute
 *  from the percentage — "Neutrophils" (a %) vs "Absolute Neutrophils" (a count)
 *  — so the two never share a heading. */
function friendlyNameFor(a: ApiAnalyte): string {
  const infoName = a.friendlyName ?? undefined;
  const base = infoName ?? a.lisName ?? '—';
  if (infoName && DLC_CELLS.test(infoName)) {
    const isPercent = /%/.test(a.unit ?? '') || /%/.test(a.lisName ?? '');
    return isPercent ? infoName : `Absolute ${infoName}`;
  }
  return base;
}

/** The reference range to print beside a result that has no gauge, or null when
 *  the LIS carries no real range. Some derived results (e.g. the SGOT/SGPT
 *  ratio) store a placeholder like "." or "-" — printing that as
 *  "Healthy range: ." reads like a broken field, so it's dropped. A range must
 *  contain at least one digit or letter to count. */
function displayRange(raw: string | null | undefined): string | null {
  const r = (raw ?? '').replace(/\s*\n\s*/g, ' · ').trim();
  if (!r || !/[0-9a-z]/i.test(r)) return null;
  return r;
}

/**
 * The API's sections, flattened into the analyte list the layout renders.
 *
 * Telo walks a department → panel → group tree and resolves each row's meaning
 * here; Infinity's API has already grouped by body system and resolved the
 * text, so this only reshapes. Rows with no reading are dropped there, not
 * here — see SmartReportService.
 */
function readSections(sections: ApiSection[]): { analytes: Analyte[]; categories: Category[] } {
  const analytes: Analyte[] = [];
  const categories: Category[] = [];

  for (const sec of sections) {
    categories.push({
      id: sec.categoryId,
      title: sec.title,
      tagline: sec.tagline,
      about: sec.about,
    });
    for (const a of sec.analytes) {
      analytes.push({
        categoryId: sec.categoryId,
        // NOT simply the API's friendly name: a differential count reports the
        // same analyte twice, once as a percentage and once as an absolute, and
        // both carry the same catalogue name. Telo separates them here and so
        // must this, or a CBC prints two cards headed "Neutrophils".
        friendlyName: friendlyNameFor(a),
        row: {
          // The lab's own name, shown under the friendly one when they differ.
          name: a.lisName,
          value: a.value,
          unit: a.unit,
          range: a.rangeText,
          comments: a.comments,
        },
        gauge: a.gauge,
        alert: a.abnormal,
        what: a.what,
        meaning: a.meaning,
        advice: a.advice,
      });
    }
  }
  return { analytes, categories };
}

// ── Building blocks ───────────────────────────────────────────────────────

function Badge({ alert }: { alert: boolean }) {
  const color = alert ? RED : GREEN;
  return (
    <div style={{ textAlign: 'center', width: '60px' }}>
      <div
        style={{
          width: '46px',
          height: '46px',
          borderRadius: '999px',
          background: color,
          color: '#fff',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          margin: '0 auto',
          fontSize: '23px',
          fontWeight: 900,
          lineHeight: 1,
        }}
      >
        {alert ? '!' : '✓'}
      </div>
      <div style={{ fontSize: '9.5px', fontWeight: 800, color, marginTop: '4px' }}>
        {alert ? 'Attention' : 'Healthy'}
      </div>
    </div>
  );
}

/** Hero gauge: wide dashed Alert↔Normal track, value large above the marker. */
function Gauge({ gauge }: { gauge: GaugeModel }) {
  const { pos, zone, kind, low, high } = gauge;
  const pct = Math.min(98, Math.max(2, Math.round(pos * 1000) / 10));
  const inAlert = zone !== 'normal';

  let segments: { flex: number; alert: boolean; label: string }[];
  if (kind === 'both') {
    segments = [
      { flex: 25, alert: true, label: 'Low' },
      { flex: 50, alert: false, label: 'Normal' },
      { flex: 25, alert: true, label: 'High' },
    ];
  } else if (kind === 'max') {
    segments = [
      { flex: 60, alert: false, label: 'Normal' },
      { flex: 40, alert: true, label: 'High' },
    ];
  } else {
    segments = [
      { flex: 40, alert: true, label: 'Low' },
      { flex: 60, alert: false, label: 'Normal' },
    ];
  }
  return (
    <div style={{ width: '100%', maxWidth: '440px' }}>
      <div style={{ position: 'relative', height: '20px' }}>
        <div
          style={{
            position: 'absolute',
            left: `${pct}%`,
            transform: 'translateX(-50%)',
            fontSize: '15px',
            fontWeight: 800,
            color: inAlert ? RED : GREEN,
            whiteSpace: 'nowrap',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {gauge.value}
        </div>
      </div>
      {/* Dashed track drawn with a dashed BORDER (not a gradient background) —
          Chromium's print rasterizer reliably paints borders but drops
          repeating-gradient backgrounds on wide flex children. */}
      <div style={{ position: 'relative', height: '12px', display: 'flex', alignItems: 'center' }}>
        <div style={{ display: 'flex', gap: '4px', width: '100%' }}>
          {segments.map((s, i) => (
            <div
              key={i}
              style={{
                flex: s.flex,
                height: 0,
                borderTop: `5px dashed ${s.alert ? TRACK_RED : TRACK_GREEN}`,
              }}
            />
          ))}
        </div>
        <div
          style={{
            position: 'absolute',
            top: '50%',
            left: `${pct}%`,
            transform: 'translate(-50%, -50%)',
            width: '12px',
            height: '12px',
            borderRadius: '3px',
            background: inAlert ? RED : BRAND,
            border: '2px solid #fff',
            boxShadow: '0 0 0 1px rgba(0,0,0,0.12)',
          }}
        />
      </div>
      <div style={{ display: 'flex', marginTop: '3px' }}>
        {segments.map((s, i) => (
          <div
            key={i}
            style={{
              flex: s.flex,
              textAlign: 'center',
              fontSize: '9.5px',
              fontWeight: 700,
              color: s.alert ? RED : GREEN,
            }}
          >
            {s.label}
          </div>
        ))}
      </div>
      {(low != null || high != null) && (
        <div style={{ fontSize: '9px', color: FAINT, marginTop: '4px', textAlign: 'center' }}>
          Healthy range{' '}
          {kind === 'both'
            ? `${low} to ${high}`
            : kind === 'max'
              ? `up to ${high}`
              : `${low} and above`}
        </div>
      )}
    </div>
  );
}

/** Simplified, recognisable organ/body-system glyphs (inline SVG, self-contained).
 *  Filled silhouettes so they read at small sizes on the chapter intro cards. */
function OrganIcon({ name, color, size = 26 }: { name: string; color: string; size?: number }) {
  const box = { width: size, height: size, viewBox: '0 0 24 24' } as const;
  switch (name) {
    case 'heart':
      return (
        <svg {...box} fill={color}>
          <path d="M12 20.7S3.4 15.4 3.4 9.4A4.7 4.7 0 0 1 12 6.6a4.7 4.7 0 0 1 8.6 2.8c0 6-8.6 11.3-8.6 11.3z" />
        </svg>
      );
    case 'kidney':
      return (
        <svg {...box} fill={color}>
          <path d="M9.4 3.2C6 3.2 3.6 6 3.6 10.2c0 4.8 3 8.6 6.2 8.6 2 0 2.8-1.3 2.8-3.2 0-1.6-.9-2.6-.9-4.4 0-2 1.2-3 1.2-5C12.9 4.4 11.6 3.2 9.4 3.2z" />
          <path d="M14.6 3.2c3.4 0 5.8 2.8 5.8 7 0 4.8-3 8.6-6.2 8.6-.7 0-1.2-.2-1.6-.5.6-.9.9-2 .9-3.3 0-1.6-.9-2.6-.9-4.4 0-2 1.2-3 1.2-5 0-.8-.2-1.5-.5-2 .4-.05.8-.05 1.3.05z" opacity="0.55" />
        </svg>
      );
    case 'liver':
      return (
        <svg {...box} fill={color}>
          <path d="M3.4 7.2C7 6.3 15 5.5 20.3 7.2c.8.3 1 1.2.5 2.6-.9 2.6-2.6 6-5.8 6.7-1.7.4-2.2-.6-3.8-1.6-1.3-.8-2.4-.7-3.8-1.4C2.9 12.4 2 10 2.2 8.6c.1-.8.5-1.2 1.2-1.4z" />
          <path d="M9.6 9.4c1.4-.5 3-.7 4.4-.5" fill="none" stroke="#fff" strokeWidth="1.1" strokeLinecap="round" opacity="0.6" />
        </svg>
      );
    case 'thyroid': // butterfly-shaped gland
      return (
        <svg {...box} fill={color}>
          <path d="M12 8.4c-1-2-2.7-3.4-4.8-3.4C4.7 5 3 6.9 3 9.6c0 3 2.2 5.4 4.8 5.4 2 0 3.5-1.4 4.2-3.2.7 1.8 2.2 3.2 4.2 3.2 2.6 0 4.8-2.4 4.8-5.4C21 6.9 19.3 5 16.8 5 14.7 5 13 6.4 12 8.4z" />
          <rect x="11" y="10.4" width="2" height="7" rx="1" opacity="0.7" />
        </svg>
      );
    case 'blood': // droplet
      return (
        <svg {...box} fill={color}>
          <path d="M12 2.6c4.1 5.2 6.4 8.4 6.4 11.6a6.4 6.4 0 0 1-12.8 0c0-3.2 2.3-6.4 6.4-11.6z" />
        </svg>
      );
    case 'pancreas':
      return (
        <svg {...box} fill={color}>
          <path d="M3.2 8.4C6 6.6 10 6.2 13.8 7c2.8.6 5 1.4 6.6 2.6 1 .8.7 2.3-.6 2.5-1.4.2-2.3-.7-3.6-.7-1.2 0-1.9 1-3.1 1-1.1 0-1.7-.9-2.9-.9-1.6 0-2.6 1.5-4.4 1.3-2-.2-3.4-1.6-3.6-3-.1-.9.3-1.7 1-2.4z" />
          <circle cx="18" cy="10.6" r="1" fill="#fff" opacity="0.7" />
        </svg>
      );
    case 'bone':
      return (
        <svg {...box} fill={color}>
          <path d="M7.6 6.1a2.1 2.1 0 1 0-2.9 2.9l6.3 6.3a2.1 2.1 0 1 0 2.9 2.9 2.1 2.1 0 1 0 2.9-2.9L10.5 9a2.1 2.1 0 1 0-2.9-2.9z" transform="rotate(0 12 12)" />
        </svg>
      );
    case 'spark': // hormone messenger
      return (
        <svg {...box} fill={color}>
          <path d="M12 2.4l2 6 6-.6-4.7 4 2.4 5.6L12 18.2 6.3 21.4 8.7 15.8 4 11.8l6 .6z" />
        </svg>
      );
    case 'shield':
      return (
        <svg {...box} fill={color}>
          <path d="M12 2.6l7 2.6v5c0 4.6-3 8.4-7 11.2-4-2.8-7-6.6-7-11.2v-5z" />
          <path d="M8.6 11.8l2.3 2.3 4-4.4" fill="none" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case 'flask':
      return (
        <svg {...box} fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 3h6M10 3v6l-4.8 8.2A2 2 0 0 0 7 20.2h10a2 2 0 0 0 1.8-3L14 9V3" />
          <path d="M7.4 15h9.2" />
        </svg>
      );
    default:
      return null;
  }
}

/** Quest-style three-step risk meter: solid Low / Moderate / High segments with
 *  a marker over the level this body system sits at. Solid backgrounds (not
 *  repeating gradients) so Chromium's print rasterizer keeps them. */
function RiskMeter({ level }: { level: RiskLevel }) {
  const segs: { label: string; track: string }[] = [
    { label: 'Low', track: TRACK_GREEN },
    { label: 'Moderate', track: '#e0a534' },
    { label: 'High', track: TRACK_RED },
  ];
  const active = RISK_META[level].idx;
  return (
    <div style={{ width: '100%' }}>
      {/* marker row — a downward triangle over the active step */}
      <div style={{ display: 'flex', height: '9px', marginBottom: '3px' }}>
        {segs.map((s, i) => (
          <div key={i} style={{ flex: 1, display: 'flex', justifyContent: 'center' }}>
            {i === active && (
              <span
                style={{
                  width: 0,
                  height: 0,
                  borderLeft: '5px solid transparent',
                  borderRight: '5px solid transparent',
                  borderTop: `7px solid ${s.track}`,
                }}
              />
            )}
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: '4px' }}>
        {segs.map((s, i) => (
          <div
            key={i}
            style={{
              flex: 1,
              height: i === active ? '11px' : '8px',
              alignSelf: 'center',
              borderRadius: '3px',
              background: s.track,
              opacity: i === active ? 1 : 0.32,
            }}
          />
        ))}
      </div>
      <div style={{ display: 'flex', marginTop: '4px' }}>
        {segs.map((s, i) => (
          <div
            key={i}
            style={{
              flex: 1,
              textAlign: 'center',
              fontSize: '8.5px',
              fontWeight: i === active ? 800 : 600,
              color: i === active ? s.track : FAINT,
            }}
          >
            {s.label}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Chapter opener modelled on Quest's organ pages: an organ glyph + the body
 *  system's title, a warm "what this does" description, and a Low→High risk
 *  meter with a verdict — a richer lead-in before the individual results. */
function CategoryIntro({ cat, list }: { cat: Category; list: Analyte[] }) {
  const vis = categoryVis(cat.id);
  const { level, alerts } = categoryRisk(list);
  const rm = RISK_META[level];
  const tests = list.length;
  return (
    <div style={{ border: `1px solid ${HAIR}`, borderRadius: '13px', overflow: 'hidden', breakInside: 'avoid', pageBreakInside: 'avoid' }}>
      {/* Gradient header: organ glyph · title/tagline · status pill */}
      <div
        style={{
          background: `linear-gradient(120deg, ${BRAND} 0%, ${BRAND2} 100%)`,
          padding: '13px 16px',
          display: 'flex',
          alignItems: 'center',
          gap: '13px',
        }}
      >
        <div
          style={{
            width: '44px',
            height: '44px',
            borderRadius: '12px',
            background: 'rgba(255,255,255,0.16)',
            border: '1px solid rgba(255,255,255,0.28)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flex: '0 0 auto',
          }}
        >
          <OrganIcon name={vis.icon} color="#fff" size={26} />
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: '15px', fontWeight: 800, color: '#fff' }}>{cat.title}</div>
          <div style={{ fontSize: '10px', color: '#d7d3f0', marginTop: '2px', lineHeight: 1.4, maxWidth: '520px' }}>
            {cat.tagline}
          </div>
        </div>
        <div style={{ flex: '0 0 auto', fontSize: '9.5px', fontWeight: 800, color: '#fff', background: 'rgba(255,255,255,0.18)', borderRadius: '999px', padding: '4px 11px', whiteSpace: 'nowrap' }}>
          {alerts ? `${alerts} to look at` : 'All good'}
        </div>
      </div>

      {/* Body: what this system does + the risk meter */}
      <div style={{ padding: '13px 16px 15px', display: 'flex', gap: '18px', alignItems: 'center', flexWrap: 'wrap' }}>
        {cat.about && (
          <div style={{ flex: '1 1 300px', minWidth: '260px', fontSize: '10.5px', color: MUTED, lineHeight: 1.6 }}>
            {cat.about}
          </div>
        )}
        <div style={{ flex: '0 0 auto', width: '196px' }}>
          <div style={{ fontSize: '8.5px', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: FAINT, marginBottom: '7px', textAlign: 'center' }}>
            Your risk picture
          </div>
          <RiskMeter level={level} />
          <div
            style={{
              marginTop: '10px',
              background: rm.soft,
              border: `1px solid ${rm.track}55`,
              borderRadius: '9px',
              padding: '7px 10px',
              textAlign: 'center',
            }}
          >
            <div style={{ fontSize: '9px', color: MUTED }}>
              Across {tests} {tests === 1 ? 'result' : 'results'}, this looks
            </div>
            <div style={{ fontSize: '12.5px', fontWeight: 800, color: rm.track, marginTop: '1px' }}>
              {rm.verdict}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ResultBlock({ a }: { a: Analyte }) {
  const lisName = a.row.name && a.row.name !== a.friendlyName ? a.row.name : null;
  // Resolved by the API rather than looked up here — see the note at the top.
  // The advice field carries the action for a flagged result and the
  // keep-it-up note for a healthy one, so which it is depends on the flag.
  const meaning = a.alert ? a.meaning : null;
  const advice = a.alert ? a.advice : null;
  const okNote = !a.alert ? a.advice : null;

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '72px 1fr',
        gap: '14px',
        padding: '15px 4px 15px 2px',
        borderTop: `1px solid ${HAIR}`,
        breakInside: 'avoid',
        pageBreakInside: 'avoid',
      }}
    >
      <div style={{ paddingTop: '2px' }}>
        <Badge alert={a.alert} />
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: '14px', fontWeight: 800, color: BRAND }}>{a.friendlyName}</div>
        {lisName && (
          <div style={{ fontSize: '9.5px', color: FAINT, marginTop: '1px' }}>Lab test: {lisName}</div>
        )}
        {a.what && (
          <div style={{ fontSize: '11px', color: MUTED, marginTop: '5px', lineHeight: 1.55, maxWidth: '520px' }}>
            {a.what}
          </div>
        )}

        <div style={{ display: 'flex', gap: '20px', alignItems: 'flex-start', flexWrap: 'wrap', marginTop: '11px' }}>
          <div style={{ flex: '0 0 auto' }}>
            <div style={{ fontSize: '9px', color: FAINT, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase' }}>
              Your reading
            </div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: '5px', marginTop: '2px' }}>
              <span style={{ fontSize: '22px', fontWeight: 800, color: a.alert ? RED : INK, fontVariantNumeric: 'tabular-nums' }}>
                {a.row.value ?? '—'}
              </span>
              {a.row.unit && <span style={{ fontSize: '10px', color: MUTED }}>{a.row.unit}</span>}
            </div>
          </div>
          <div style={{ flex: '1 1 300px', minWidth: '260px' }}>
            {a.gauge ? (
              <Gauge gauge={a.gauge} />
            ) : (
              displayRange(a.row.range) && (
                <div style={{ fontSize: '10px', color: MUTED, paddingTop: '6px' }}>
                  Healthy range: {displayRange(a.row.range)}
                </div>
              )
            )}
          </div>
        </div>

        {a.row.comments && (
          <div style={{ fontSize: '9.5px', color: FAINT, marginTop: '7px', fontStyle: 'italic' }}>
            {a.row.comments}
          </div>
        )}

        {(meaning || advice) && (
          <div style={{ marginTop: '11px', borderRadius: '9px', overflow: 'hidden', border: `1px solid ${HAIR}` }}>
            {meaning && (
              <div style={{ background: RED_SOFT, padding: '8px 12px', fontSize: '10.5px', color: '#7c1e21', lineHeight: 1.5 }}>
                <span style={{ fontWeight: 800, color: RED }}>What this can mean · </span>
                {meaning}
              </div>
            )}
            {advice && (
              <div style={{ background: AMBER_SOFT, padding: '8px 12px', fontSize: '10.5px', color: '#7a5a15', lineHeight: 1.5, borderTop: meaning ? '1px solid #f2e2c0' : 'none' }}>
                <span style={{ fontWeight: 800, color: '#9a6a10' }}>What you can do · </span>
                {advice}
              </div>
            )}
          </div>
        )}

        {/* Healthy result: a short, affirming "keep it up" note. */}
        {okNote && (
          <div
            style={{
              marginTop: '11px',
              borderRadius: '9px',
              border: `1px solid ${'#cfe6d8'}`,
              background: GREEN_SOFT,
              padding: '8px 12px',
              fontSize: '10.5px',
              color: '#1e5c37',
              lineHeight: 1.5,
            }}
          >
            <span style={{ fontWeight: 800, color: GREEN }}>Keeping it up · </span>
            {okNote}
          </div>
        )}
      </div>
    </div>
  );
}

/** Full-width indigo chapter band (used for "Your Wellness"). */
function ChapterBand({ title, tagline }: { title: string; tagline: string }) {
  return (
    <div
      style={{
        background: `linear-gradient(120deg, ${BRAND} 0%, ${BRAND2} 100%)`,
        borderRadius: '10px',
        padding: '13px 18px',
      }}
    >
      <div style={{ fontSize: '17px', fontWeight: 800, color: '#fff' }}>{title}</div>
      <div style={{ fontSize: '10.5px', color: '#d7d3f0', marginTop: '3px', lineHeight: 1.45, maxWidth: '600px' }}>
        {tagline}
      </div>
    </div>
  );
}

// ── Your Wellness (lifestyle action plan) ─────────────────────────────────

/** Small hand-crafted SVG icons for the wellness cards (self-contained, no
 *  external images). Some are stroked line icons, some filled. */
function WIcon({ name, color, size = 24 }: { name: string; color: string; size?: number }) {
  const box = { width: size, height: size, viewBox: '0 0 24 24' } as const;
  const stroke = { fill: 'none', stroke: color, strokeWidth: 1.9, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  switch (name) {
    case 'leaf':
      return (
        <svg {...box} {...stroke}>
          <path d="M4 20c0-9 7-15 16-15 0 9-7 15-16 15z" />
          <path d="M5 19C9 14 13 11 17 9" />
        </svg>
      );
    case 'pulse':
      return (
        <svg {...box} {...stroke}>
          <path d="M2 12h4l2.5-6 4 12L15 12h7" />
        </svg>
      );
    case 'moon':
      return (
        <svg {...box} fill={color}>
          <path d="M20.5 15.6A8.5 8.5 0 1 1 10 4.1a6.7 6.7 0 0 0 10.5 11.5z" />
        </svg>
      );
    case 'heart':
      return (
        <svg {...box} fill={color}>
          <path d="M12 20.6S4 15.7 4 10a4.4 4.4 0 0 1 8-2.6A4.4 4.4 0 0 1 20 10c0 5.7-8 10.6-8 10.6z" />
        </svg>
      );
    case 'drop':
      return (
        <svg {...box} fill={color}>
          <path d="M12 3.2c3.9 4.9 6 7.9 6 10.9a6 6 0 0 1-12 0c0-3 2.1-6 6-10.9z" />
        </svg>
      );
    case 'sun':
      return (
        <svg {...box} {...stroke}>
          <circle cx="12" cy="12" r="4" fill={color} stroke="none" />
          <path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5 5l1.6 1.6M17.4 17.4 19 19M19 5l-1.6 1.6M6.6 17.4 5 19" />
        </svg>
      );
    case 'check':
      return (
        <svg {...box} {...stroke} strokeWidth={2.4}>
          <path d="M5 12.5l4.5 4.5L19 7" />
        </svg>
      );
    case 'book':
      return (
        <svg {...box} {...stroke}>
          <path d="M12 6.5C10.5 5 8 4.5 4 4.8v13c4-.3 6.5.2 8 1.7 1.5-1.5 4-2 8-1.7v-13c-4-.3-6.5.2-8 1.7z" />
          <path d="M12 6.5v13" />
        </svg>
      );
    case 'gauge':
      return (
        <svg {...box} {...stroke}>
          <path d="M4 15a8 8 0 0 1 16 0" />
          <path d="M12 15l4.5-3.2" />
          <circle cx="12" cy="15" r="1.3" fill={color} stroke="none" />
        </svg>
      );
    case 'target':
      return (
        <svg {...box} {...stroke}>
          <circle cx="12" cy="12" r="8" />
          <circle cx="12" cy="12" r="4" />
          <circle cx="12" cy="12" r="1.2" fill={color} stroke="none" />
        </svg>
      );
    default:
      return null;
  }
}

/** A donut showing how many results are in a healthy range. The progress is an
 *  explicit ARC PATH at the track's exact radius — no transform / pathLength /
 *  dasharray, which Chromium renders at a drifted radius — so the green always
 *  sits precisely on the grey track. */
function WellnessDonut({ healthy, total }: { healthy: number; total: number }) {
  const SIZE = 96;
  const SW = 9;
  const R = 38; // outer edge = R + SW/2 = 42.5, inside the 48 half-box
  const C = 48;
  const pct = total > 0 ? Math.max(0, Math.min(1, healthy / total)) : 1;
  const full = pct >= 0.999;
  const rad = (d: number) => (d * Math.PI) / 180;
  const endDeg = -90 + pct * 360;
  const ex = C + R * Math.cos(rad(endDeg));
  const ey = C + R * Math.sin(rad(endDeg));
  const largeArc = pct > 0.5 ? 1 : 0;
  const arc = `M ${C} ${C - R} A ${R} ${R} 0 ${largeArc} 1 ${ex.toFixed(3)} ${ey.toFixed(3)}`;
  return (
    <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} style={{ flex: '0 0 auto', display: 'block' }}>
      <circle cx={C} cy={C} r={R} fill="none" stroke="#e7e4f1" strokeWidth={SW} />
      {full ? (
        <circle cx={C} cy={C} r={R} fill="none" stroke={TRACK_GREEN} strokeWidth={SW} />
      ) : pct > 0 ? (
        <path d={arc} fill="none" stroke={TRACK_GREEN} strokeWidth={SW} strokeLinecap="round" />
      ) : null}
      <text x={C} y={C - 1} textAnchor="middle" fontSize="21" fontWeight="800" fill={BRAND}>
        {healthy}
      </text>
      <text x={C} y={C + 13} textAnchor="middle" fontSize="8.5" fontWeight="700" fill={MUTED}>
        of {total} healthy
      </text>
    </svg>
  );
}

const PILLAR_STYLE = [
  { icon: 'leaf', ic: '#1b7a44', bg: '#e8f5ee' },
  { icon: 'pulse', ic: '#b7791f', bg: '#fff3e0' },
  { icon: 'moon', ic: '#4b3fb0', bg: '#ece9f8' },
  { icon: 'heart', ic: '#c1466a', bg: '#fdeef0' },
];
const TIP_STYLE = [
  { icon: 'leaf', ic: '#1b7a44', bg: '#e8f5ee' },
  { icon: 'pulse', ic: '#b7791f', bg: '#fff3e0' },
  { icon: 'sun', ic: '#c08a12', bg: '#fdf4dc' },
  { icon: 'drop', ic: '#0f766e', bg: '#e2f4f1' },
];

function Wellness({ data, alerts, total }: { data: SmartBookletData; alerts: Analyte[]; total: number }) {
  const calRows = caloriesForSex(data.sex);
  const myBand = calorieBandForAge(data.age);
  const myRow = calRows.find((r) => r.age === myBand) ?? calRows[0];
  const screenings = screeningsFor(data.age, data.sex);
  const name = firstName(data.patientName);
  const healthy = Math.max(0, total - alerts.length);
  const isMale = /^m/i.test((data.sex ?? '').trim());

  const bars = [
    { label: 'Sedentary', v: myRow.sedentary, color: '#b7b1e0' },
    { label: 'Moderately active', v: myRow.moderate, color: '#7c74c9' },
    { label: 'Active', v: myRow.active, color: TRACK_GREEN },
  ];
  const barMax = 3200;

  return (
    <div style={{ breakBefore: 'page', pageBreakBefore: 'always', paddingTop: '2px' }}>
      <ChapterBand
        title="Your Wellness"
        tagline="Your results are one part of the picture. These simple, everyday habits — and the checks worth keeping up — help you build on them."
      />

      {/* Snapshot: donut + encouragement */}
      <div
        style={{
          marginTop: '14px',
          display: 'flex',
          alignItems: 'center',
          gap: '18px',
          background: `linear-gradient(120deg, ${BRAND_SOFT} 0%, #f4f3fb 100%)`,
          border: `1px solid ${HAIR}`,
          borderRadius: '12px',
          padding: '14px 18px',
          breakInside: 'avoid',
        }}
      >
        <WellnessDonut healthy={healthy} total={total} />
        <div>
          <div style={{ fontSize: '15px', fontWeight: 800, color: BRAND }}>
            {alerts.length === 0 ? `Beautifully balanced, ${name}.` : `You're on a good track, ${name}.`}
          </div>
          <div style={{ fontSize: '11.5px', color: MUTED, marginTop: '4px', lineHeight: 1.55, maxWidth: '460px' }}>
            {healthy} of your {total} results are in a healthy range. Here’s how to protect what’s
            working and lift the rest — small, steady habits go a long way.
          </div>
        </div>
      </div>

      {/* Four pillars — icon cards */}
      <div style={{ marginTop: '16px', breakInside: 'avoid' }}>
        <SectionTitle>Small habits, big difference</SectionTitle>
        <div style={{ marginTop: '11px', display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '10px' }}>
          {WELLNESS_PILLARS.map((p, i) => {
            const s = PILLAR_STYLE[i % PILLAR_STYLE.length];
            return (
              <div key={p.title} style={{ display: 'flex', gap: '11px', alignItems: 'flex-start', border: `1px solid ${HAIR}`, borderRadius: '11px', padding: '12px 14px' }}>
                <div style={{ width: '38px', height: '38px', borderRadius: '10px', background: s.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', flex: '0 0 auto' }}>
                  <WIcon name={s.icon} color={s.ic} size={22} />
                </div>
                <div>
                  <div style={{ fontSize: '12px', fontWeight: 800, color: INK }}>{p.title}</div>
                  <div style={{ fontSize: '10px', color: MUTED, marginTop: '3px', lineHeight: 1.5 }}>{p.note}</div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Action plan — derived from the flagged results */}
      <div style={{ marginTop: '20px', breakInside: 'avoid' }}>
        <SectionTitle>Your action plan</SectionTitle>
        {alerts.length === 0 ? (
          <div style={{ marginTop: '11px', background: GREEN_SOFT, border: '1px solid #cfe6d8', borderRadius: '10px', padding: '13px 16px', fontSize: '11.5px', color: '#1e5c37', lineHeight: 1.55 }}>
            <strong style={{ color: GREEN }}>Nicely done, {name}. </strong>
            Every result is in a healthy range, so there’s nothing that needs action right now. Keep
            up the habits above, and stay in touch with your doctor for your routine checks.
          </div>
        ) : (
          <>
            <div style={{ fontSize: '11px', color: MUTED, marginTop: '9px', lineHeight: 1.55, maxWidth: '600px' }}>
              {name}, these are the results worth focusing on. They aren’t a diagnosis — they’re the
              areas where a small change, and a chat with your doctor, can make the most difference.
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '9px', marginTop: '11px' }}>
              {alerts.slice(0, 6).map((a, i) => {
                const advice = a.advice;
                return (
                  <div key={i} style={{ display: 'flex', gap: '11px', border: `1px solid ${HAIR}`, borderLeft: `4px solid ${RED}`, borderRadius: '9px', padding: '10px 13px', breakInside: 'avoid' }}>
                    <div style={{ width: '24px', height: '24px', borderRadius: '999px', background: RED_SOFT, color: RED, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '13px', fontWeight: 900, flex: '0 0 auto', marginTop: '1px' }}>
                      {i + 1}
                    </div>
                    <div>
                      <div style={{ fontSize: '12px', fontWeight: 800, color: INK }}>
                        {a.friendlyName.replace(/ —.*$/, '')}{' '}
                        <span style={{ fontWeight: 700, color: RED, fontSize: '11px' }}>
                          · {a.row.value} {a.row.unit ?? ''}
                        </span>
                      </div>
                      {advice && (
                        <div style={{ fontSize: '10.5px', color: '#7a5a15', marginTop: '4px', lineHeight: 1.5 }}>{advice}</div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>

      {/* Everyday tips — icon cards */}
      <div style={{ marginTop: '20px', breakInside: 'avoid' }}>
        <SectionTitle>Everyday wellness tips</SectionTitle>
        <div style={{ marginTop: '11px', display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '10px' }}>
          {WELLNESS_TIPS.map((t, i) => {
            const s = TIP_STYLE[i % TIP_STYLE.length];
            return (
              <div key={t.title} style={{ border: `1px solid ${HAIR}`, borderRadius: '11px', padding: '12px 14px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '9px' }}>
                  <div style={{ width: '30px', height: '30px', borderRadius: '8px', background: s.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', flex: '0 0 auto' }}>
                    <WIcon name={s.icon} color={s.ic} size={18} />
                  </div>
                  <div style={{ fontSize: '12px', fontWeight: 800, color: INK }}>{t.title}</div>
                </div>
                <div style={{ fontSize: '10px', color: MUTED, marginTop: '6px', lineHeight: 1.5 }}>{t.body}</div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Daily calories — bar chart for the patient's age band */}
      <div style={{ marginTop: '20px', breakInside: 'avoid' }}>
        <SectionTitle>A rough guide to daily calories</SectionTitle>
        <div style={{ fontSize: '10.5px', color: MUTED, marginTop: '8px', lineHeight: 1.55, maxWidth: '600px' }}>
          Roughly how many calories a {isMale ? 'man' : 'woman'} your age ({myBand}) needs each day,
          depending on how active you are. Your own needs vary — treat it as a starting point.
        </div>
        <div style={{ marginTop: '12px', display: 'flex', gap: '22px', alignItems: 'flex-end', border: `1px solid ${HAIR}`, borderRadius: '12px', padding: '16px 22px 12px', background: '#fff' }}>
          {bars.map((b) => {
            const h = Math.round((b.v / barMax) * 120);
            return (
              <div key={b.label} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                <div style={{ fontSize: '13px', fontWeight: 800, color: b.color === TRACK_GREEN ? GREEN : BRAND, fontVariantNumeric: 'tabular-nums' }}>
                  {b.v}
                </div>
                <div style={{ fontSize: '7.5px', color: FAINT, marginTop: '1px', marginBottom: '5px' }}>kcal/day</div>
                <div style={{ width: '100%', maxWidth: '90px', height: `${h}px`, background: `linear-gradient(180deg, ${b.color} 0%, ${b.color}cc 100%)`, borderRadius: '7px 7px 3px 3px' }} />
                <div style={{ fontSize: '9.5px', fontWeight: 700, color: INK, marginTop: '7px', textAlign: 'center' }}>{b.label}</div>
              </div>
            );
          })}
        </div>
        <div style={{ fontSize: '8.5px', color: FAINT, marginTop: '7px', lineHeight: 1.5 }}>
          Sedentary: {CALORIE_DEFINITIONS.sedentary} Moderately active: {CALORIE_DEFINITIONS.moderate}{' '}
          Active: {CALORIE_DEFINITIONS.active} Source: USDA Dietary Guidelines 2020–2025.
        </div>
      </div>

      {/* Preventive screenings — checklist with icons */}
      <div style={{ marginTop: '20px', breakInside: 'avoid' }}>
        <SectionTitle>Checks worth keeping up</SectionTitle>
        <div style={{ fontSize: '10.5px', color: MUTED, marginTop: '8px', lineHeight: 1.55, maxWidth: '600px' }}>
          General screenings suggested around your age. Your doctor tailors these to your history —
          use it as a checklist for your next visit.
        </div>
        <div style={{ marginTop: '11px', display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '8px' }}>
          {screenings.map((s) => (
            <div key={s.area} style={{ display: 'flex', gap: '10px', border: `1px solid ${HAIR}`, borderRadius: '10px', padding: '9px 12px', breakInside: 'avoid' }}>
              <div style={{ width: '22px', height: '22px', borderRadius: '999px', background: GREEN_SOFT, display: 'flex', alignItems: 'center', justifyContent: 'center', flex: '0 0 auto', marginTop: '1px' }}>
                <WIcon name="check" color={GREEN} size={14} />
              </div>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: '11px', fontWeight: 800, color: INK }}>{s.area}</div>
                <div style={{ fontSize: '9.5px', color: MUTED, marginTop: '1px', lineHeight: 1.4 }}>{s.recommendation}</div>
              </div>
            </div>
          ))}
        </div>
        <div style={{ fontSize: '8.5px', color: FAINT, marginTop: '7px' }}>
          General guidance (USPSTF / CDC). Not a substitute for your doctor’s advice.
        </div>
      </div>
    </div>
  );
}

// ── Report summary for the doctor ─────────────────────────────────────────

function ReportSummary({
  categories,
}: {
  categories: { title: string; analytes: Analyte[] }[];
}) {
  return (
    <div style={{ breakBefore: 'page', pageBreakBefore: 'always', paddingTop: '2px' }}>
      <ChapterBand
        title="Summary for your doctor"
        tagline="A compact list of every result on this report, with its reference range. Print or share this page at your next appointment."
      />
      <div style={{ marginTop: '14px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 26px' }}>
        {categories.map((cat) => (
          <div key={cat.title} style={{ breakInside: 'avoid', marginBottom: '12px' }}>
            <div style={{ fontSize: '11px', fontWeight: 800, color: BRAND, borderBottom: `2px solid ${BRAND_SOFT}`, paddingBottom: '3px', marginBottom: '2px' }}>
              {cat.title}
            </div>
            {cat.analytes.map((a, i) => (
              <div
                key={i}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr auto',
                  gap: '8px',
                  alignItems: 'baseline',
                  padding: '4px 0',
                  borderTop: i === 0 ? 'none' : `1px solid ${HAIR}`,
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <span style={{ fontSize: '10px', fontWeight: 700, color: a.alert ? RED : INK }}>
                    {a.alert && (
                      <span style={{ display: 'inline-block', width: '6px', height: '6px', borderRadius: '999px', background: RED, marginRight: '5px', verticalAlign: 'middle' }} />
                    )}
                    {a.row.name ?? a.friendlyName}
                  </span>
                  {a.row.range && (
                    <span style={{ fontSize: '8.5px', color: FAINT }}> · Ref {a.row.range.replace(/\s*\n\s*/g, ', ')}</span>
                  )}
                </div>
                <div style={{ fontSize: '10px', fontWeight: 800, color: a.alert ? RED : INK, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                  {a.row.value ?? '—'}
                  {a.row.unit ? <span style={{ fontWeight: 500, color: MUTED }}> {a.row.unit}</span> : null}
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '9px' }}>
      <span style={{ width: '5px', height: '17px', background: BRAND, borderRadius: '999px' }} />
      <span style={{ fontSize: '15px', fontWeight: 800, color: BRAND, letterSpacing: '-0.01em' }}>
        {children}
      </span>
    </div>
  );
}

// ── Cover (full-bleed page 1) ─────────────────────────────────────────────

const COVER_STARS = [
  { l: '12%', t: '10%', sz: 2, o: 0.55 }, { l: '22%', t: '18%', sz: 1.5, o: 0.4 },
  { l: '33%', t: '8%', sz: 2.5, o: 0.6 }, { l: '44%', t: '14%', sz: 1.5, o: 0.45 },
  { l: '54%', t: '9%', sz: 2, o: 0.5 }, { l: '63%', t: '20%', sz: 1.5, o: 0.4 },
  { l: '72%', t: '11%', sz: 2.5, o: 0.6 }, { l: '82%', t: '17%', sz: 2, o: 0.5 },
  { l: '90%', t: '9%', sz: 1.5, o: 0.4 }, { l: '18%', t: '30%', sz: 1.5, o: 0.35 },
  { l: '48%', t: '27%', sz: 2, o: 0.4 }, { l: '68%', t: '32%', sz: 1.5, o: 0.35 },
  { l: '86%', t: '29%', sz: 2, o: 0.45 }, { l: '8%', t: '22%', sz: 1.5, o: 0.4 },
  { l: '38%', t: '37%', sz: 1.5, o: 0.3 }, { l: '78%', t: '25%', sz: 2.5, o: 0.5 },
];

/**
 * Photographic cover backgrounds — one per patient gender, both LICENSED under
 * the Pexels License (Ketut Subiyanto; commercial use, no attribution required)
 * and pre-cropped to the A4 portrait ratio in public/branding/.
 *
 * Each is framed so the figure MATCHING the patient sits on the RIGHT, clear of
 * the headline and tagline on the left — so unlike the earlier single-asset
 * cover, neither is mirrored (mirroring would flip any text/logos in frame).
 * Set to null to fall back to the crafted sunrise illustration.
 */
const COVER_PHOTO_MALE: string | null = '/branding/cover-male.jpg';
const COVER_PHOTO_FEMALE: string | null = '/branding/cover-female.jpg';

/** Male patients get the jogging shot (man on the right); everyone else the
 *  stretching shot (woman on the right). Both frame a couple, so the fallback
 *  for an unknown or unspecified sex still reads naturally. */
function coverPhotoFor(sex: string | null): string | null {
  return /^m/i.test((sex ?? '').trim()) ? COVER_PHOTO_MALE : COVER_PHOTO_FEMALE;
}

function Cover({ data }: { data: SmartBookletData }) {
  const name = titleCaseName(data.patientName);
  const coverPhoto = coverPhotoFor(data.sex);
  return (
    <div
      style={{
        position: 'relative',
        minHeight: '100vh',
        breakAfter: 'page',
        pageBreakAfter: 'always',
        // Warm dawn sky: indigo up top, softening to a warm glow at the horizon.
        background:
          'linear-gradient(180deg, #1b1548 0%, #2c2570 34%, #47409a 58%, #7d76bd 76%, #c6a8c0 90%, #e7b98f 100%)',
        color: '#fff',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        padding: '44px 52px 40px',
        overflow: 'hidden',
        WebkitPrintColorAdjust: 'exact',
        printColorAdjust: 'exact',
      }}
    >
      {/* Faint stars for depth in the upper sky */}
      <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }} aria-hidden>
        {COVER_STARS.map((s, i) => (
          <span
            key={i}
            style={{
              position: 'absolute',
              left: s.l,
              top: s.t,
              width: `${s.sz}px`,
              height: `${s.sz}px`,
              borderRadius: '999px',
              background: '#fff',
              opacity: s.o,
              boxShadow: '0 0 4px rgba(255,255,255,0.55)',
            }}
          />
        ))}
      </div>

      {/* Sunrise-wellness illustration: a woman at dawn checking her smartwatch,
          her activity rings glowing as a halo around the rising sun — a "tracking
          your health" motif. All inline SVG (self-contained, no photos). */}
      <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: '52%', pointerEvents: 'none' }} aria-hidden>
        <svg width="100%" height="100%" viewBox="0 0 1200 560" preserveAspectRatio="xMidYMax slice">
          <defs>
            <radialGradient id="nbSun" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#fff4dc" />
              <stop offset="52%" stopColor="#ffd79a" />
              <stop offset="100%" stopColor="#ffb877" />
            </radialGradient>
            <radialGradient id="nbGlow" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#ffdca6" stopOpacity="0.5" />
              <stop offset="100%" stopColor="#ffdca6" stopOpacity="0" />
            </radialGradient>
            <radialGradient id="nbGlow2" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#ffe6bd" stopOpacity="0.3" />
              <stop offset="100%" stopColor="#ffe6bd" stopOpacity="0" />
            </radialGradient>
          </defs>

          {/* Sun glow → sun (rising behind her) */}
          <circle cx="880" cy="345" r="380" fill="url(#nbGlow2)" />
          <circle cx="880" cy="345" r="215" fill="url(#nbGlow)" />
          <circle cx="880" cy="345" r="68" fill="url(#nbSun)" />

          {/* Smartwatch activity-ring halo around the sun */}
          <g fill="none" strokeLinecap="round">
            <circle cx="880" cy="345" r="140" stroke="#ff6f91" strokeOpacity="0.6" strokeWidth="9" pathLength={100} strokeDasharray="78 100" transform="rotate(-115 880 345)" />
            <circle cx="880" cy="345" r="120" stroke="#38d39f" strokeOpacity="0.6" strokeWidth="9" pathLength={100} strokeDasharray="70 100" transform="rotate(-115 880 345)" />
            <circle cx="880" cy="345" r="100" stroke="#59b8f5" strokeOpacity="0.6" strokeWidth="9" pathLength={100} strokeDasharray="84 100" transform="rotate(-115 880 345)" />
          </g>

          {/* Elegant birds */}
          <g stroke="#ffffff" strokeOpacity="0.4" strokeWidth="2.4" fill="none" strokeLinecap="round">
            <path d="M250 130 q14 -12 28 0 q14 -12 28 0" />
            <path d="M330 168 q11 -9 22 0 q11 -9 22 0" />
          </g>

          {/* Hazy back hills */}
          <path d="M0 372 C220 334 420 396 640 368 C840 342 1020 390 1200 358 L1200 560 L0 560 Z" fill="#8f97cf" fillOpacity="0.5" />
          <path d="M0 430 C240 396 470 448 720 424 C930 404 1070 436 1200 420 L1200 560 L0 560 Z" fill="#4f9b8b" />

          {/* Woman checking her smartwatch (silhouette), standing on the hill */}
          <g transform="translate(735 500) scale(1.22)" fill="#1d1846">
            {/* legs */}
            <path d="M-14 -116 C-16 -80 -13 -30 -12 -4 L-3 -4 C-3 -30 -4 -80 -3 -116 Z" />
            <path d="M3 -116 C4 -80 3 -30 3 -4 L12 -4 C13 -30 16 -80 14 -116 Z" />
            <ellipse cx="-9" cy="-3" rx="9" ry="3.5" />
            <ellipse cx="9" cy="-3" rx="9" ry="3.5" />
            {/* hips + torso (hourglass) */}
            <ellipse cx="0" cy="-116" rx="16" ry="12" />
            <path d="M-15 -116 C-12 -126 -10 -140 -10 -150 C-10 -166 -15 -178 -18 -186 L18 -186 C15 -178 10 -166 10 -150 C10 -140 12 -126 15 -116 Z" />
            {/* far arm relaxed down */}
            <path d="M-17 -182 C-21 -160 -22 -138 -21 -124 L-13 -124 C-14 -138 -13 -160 -12 -180 Z" />
            {/* neck + head */}
            <rect x="-5" y="-200" width="10" height="16" rx="3" />
            <circle cx="0" cy="-214" r="15" />
            {/* hair: cap + ponytail down the back */}
            <path d="M-15 -214 C-15 -231 15 -231 15 -214 C10 -224 -10 -224 -15 -214 Z" />
            <path d="M-12 -218 C-29 -207 -34 -181 -27 -158 C-25 -180 -17 -200 -8 -210 Z" />
            {/* near arm raised, forearm across the chest checking the watch */}
            <rect x="13" y="-190" width="10" height="28" rx="5" transform="rotate(34 18 -186)" />
            <rect x="0" y="-181" width="28" height="10" rx="5" />
            {/* smartwatch on the wrist */}
            <rect x="0" y="-182" width="13" height="12" rx="3.5" fill="#4b3fb0" />
            <circle cx="6.5" cy="-176" r="3.4" fill="none" stroke="#a9e8c4" strokeWidth="1.6" />
          </g>

          {/* Front hill (deep indigo the footer sits on) — covers her feet */}
          <path d="M0 486 C300 464 520 506 820 486 C1010 474 1110 496 1200 486 L1200 560 L0 560 Z" fill="#2b2668" />
        </svg>
      </div>

      {/* Photographic background (when a licensed image is provided) — painted
          over the illustration, behind the content, with a scrim for legibility. */}
      {coverPhoto && (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={coverPhoto}
            alt=""
            style={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              objectFit: 'cover',
            }}
          />
          <div
            aria-hidden
            style={{
              position: 'absolute',
              inset: 0,
              // Dark on the left (where the tagline sits) fading to reveal the
              // subject on the right, plus a strong bottom band for the footer
              // and a soft top wash for the logo. The horizontal ramp holds ~0.86
              // across the whole text column (to ~44%) before falling away: the
              // cover photos are bright daylight shots, and a lighter scrim left
              // the headline sitting on sunlit grass/decking.
              background:
                'linear-gradient(100deg, rgba(15,11,42,0.95) 0%, rgba(15,11,42,0.86) 24%, rgba(15,11,42,0.60) 44%, rgba(15,11,42,0.20) 62%, rgba(15,11,42,0) 80%), linear-gradient(180deg, rgba(15,11,42,0.5) 0%, rgba(15,11,42,0) 15%, rgba(15,11,42,0) 66%, rgba(12,9,36,0.96) 100%)',
            }}
          />
        </>
      )}

      {/* Header: bigger logo + confidentiality mark */}
      <div style={{ position: 'relative', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/branding/noble-logo-ondark.png" alt="Noble Diagnostics" style={{ height: '52px', width: 'auto' }} />
        <div style={{ fontSize: '8.5px', fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: '#cdc9ea', border: '1px solid rgba(255,255,255,0.28)', borderRadius: '999px', padding: '5px 13px' }}>
          Personal &amp; Confidential
        </div>
      </div>

      {/* Middle: eyebrow + tagline + greeting */}
      <div style={{ position: 'relative', maxWidth: '560px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '11px' }}>
          <span style={{ width: '28px', height: '3px', background: 'linear-gradient(90deg, #a9e8c4, #7fd3ff)', borderRadius: '3px' }} />
          <span style={{ fontSize: '12px', fontWeight: 700, letterSpacing: '0.24em', textTransform: 'uppercase', color: '#d3cff0' }}>
            Smart Health Report
          </span>
        </div>
        <div style={{ fontSize: '42px', fontWeight: 800, lineHeight: 1.1, letterSpacing: '-0.02em', marginTop: '15px', textWrap: 'balance', textShadow: '0 1px 14px rgba(16,12,50,0.32)' }}>
          Here’s to better
          <br />
          health, {name.split(' ')[0]}.
        </div>
        <div style={{ fontSize: '15px', lineHeight: 1.65, color: '#efeafa', marginTop: '20px', maxWidth: '470px', textShadow: '0 1px 10px rgba(16,12,50,0.28)' }}>
          This is your Smart Health Report — a warm, patient-friendly look at what your latest
          results say about your health, and practical steps to keep feeling your best.
        </div>
      </div>

      {/* Footer: a full-bleed solid dark band so the meta text always reads
          clearly, regardless of the hills/sun behind it. Negative margins break
          out of the cover's padding to reach the page edges. */}
      <div
        style={{
          position: 'relative',
          margin: '0 -52px -40px',
          padding: '18px 52px 34px',
          background: 'linear-gradient(180deg, rgba(26,21,72,0) 0%, #221b56 44%, #191340 100%)',
        }}
      >
        <div style={{ height: '1px', background: 'rgba(255,255,255,0.22)', marginBottom: '15px' }} />
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: '20px', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex' }}>
            {[
              ['Prepared for', preparedForName(data.patientName, data.sex)],
              ['Sample', data.sid],
              ['Reported', fmtDate(data.reportedAt)],
            ].map(([k, v], i) => (
              <div
                key={k}
                style={{
                  padding: i === 0 ? '0 20px 0 0' : '0 20px',
                  borderLeft: i === 0 ? 'none' : '1px solid rgba(255,255,255,0.2)',
                }}
              >
                <div style={{ fontSize: '8.5px', letterSpacing: '0.12em', textTransform: 'uppercase', color: '#cdc9ea' }}>{k}</div>
                <div style={{ fontSize: '13px', fontWeight: 700, color: '#fff', marginTop: '3px' }}>{v}</div>
              </div>
            ))}
          </div>
          <div style={{ textAlign: 'right', fontSize: '10px', color: '#d6d2ee', lineHeight: 1.55 }}>
            <div style={{ fontWeight: 800, color: '#fff', fontSize: '12.5px', letterSpacing: '0.01em' }}>Noble Diagnostics</div>
            {data.processedAt?.phone && <div>{data.processedAt.phone}</div>}
            {data.processedAt?.city && <div>{data.processedAt.city}</div>}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Welcome letter (page 2) ───────────────────────────────────────────────

function Welcome({ data }: { data: SmartBookletData }) {
  const greetName = titleCaseName(firstName(data.patientName));
  const referredBy =
    data.refDoctor && !/^self$/i.test(data.refDoctor.trim())
      ? `Dr. ${titleCaseName(data.refDoctor)}`
      : 'Self';

  const features = [
    { icon: 'book', ic: '#4b3fb0', bg: '#ece9f8', t: 'Patient-friendly', d: 'Every result explained in clear, everyday words — no medical jargon.' },
    { icon: 'gauge', ic: '#1b7a44', bg: '#e8f5ee', t: 'Clear visual guides', d: 'A clear picture for each test shows exactly where you stand.' },
    { icon: 'target', ic: '#b7791f', bg: '#fff3e0', t: 'Clear next steps', d: 'Practical suggestions and what’s worth raising with your doctor.' },
  ];

  const toc = [
    { n: '01', c: BRAND, t: 'Your snapshot', d: 'How your results look at a glance.' },
    { n: '02', c: TRACK_GREEN, t: 'Your health areas at a glance', d: 'A quick read on each body system.' },
    { n: '03', c: AMBER_LINE, t: 'Your results, explained', d: 'Every test in clear, everyday words, with a visual guide and what it means.' },
    { n: '04', c: '#0f766e', t: 'Your Wellness plan', d: 'Personalised habits, tips and the checks worth keeping up.' },
    { n: '05', c: BRAND2, t: 'Summary for your doctor', d: 'A compact list of every result to share at your next visit.' },
  ];

  return (
    <div style={{ breakAfter: 'page', pageBreakAfter: 'always', paddingTop: '2px' }}>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/branding/noble-logo.png" alt="Noble" style={{ height: '30px', width: 'auto' }} />
      </div>

      {/* "Dear …" hero band with a soft emblem */}
      <div
        style={{
          position: 'relative',
          overflow: 'hidden',
          background: `linear-gradient(120deg, ${BRAND} 0%, ${BRAND2} 100%)`,
          borderRadius: '14px',
          padding: '24px 28px',
          marginTop: '12px',
          color: '#fff',
        }}
      >
        <div style={{ position: 'absolute', right: '-40px', top: '-46px', width: '190px', height: '190px', pointerEvents: 'none' }} aria-hidden>
          <svg width="190" height="190" viewBox="0 0 190 190" fill="none">
            {[92, 72, 52, 32].map((r, i) => (
              <circle key={i} cx="95" cy="95" r={r} stroke="#ffffff" strokeOpacity={0.09 + i * 0.02} strokeWidth="1.4" />
            ))}
            <circle cx="95" cy="95" r="14" fill="#ffffff" fillOpacity="0.1" />
          </svg>
        </div>
        <div style={{ position: 'relative' }}>
          <div style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '0.18em', textTransform: 'uppercase', color: '#c9c4ec' }}>
            A note for you
          </div>
          <div style={{ fontSize: '31px', fontWeight: 800, letterSpacing: '-0.015em', marginTop: '5px' }}>
            Dear {greetName},
          </div>
          <div style={{ fontSize: '12.5px', color: '#e7e4f6', marginTop: '6px' }}>
            Welcome to a clearer, calmer view of your health.
          </div>
        </div>
      </div>

      {/* Letter body — lead paragraph emphasised */}
      <div style={{ maxWidth: '640px', margin: '20px 0 0', fontSize: '13px', color: INK, lineHeight: 1.72 }}>
        <p style={{ margin: '0 0 12px', fontSize: '14px', color: '#33384a' }}>
          Thank you for choosing Noble Diagnostics — and for taking a moment to understand your
          health. This Smart Report turns your lab results into patient-friendly explanations and
          clear visuals, so they’re easy to follow.
        </p>
        <p style={{ margin: '0 0 12px' }}>
          It’s a friendly guide, not a diagnosis. It highlights what’s worth a closer look, but your
          doctor is the best person to interpret it alongside your history and how you’re feeling —
          so do talk through anything flagged here at your next visit.
        </p>
        <p style={{ margin: '0' }}>Here’s to understanding your health a little better.</p>
        <p style={{ margin: '12px 0 0', fontWeight: 700, color: BRAND }}>— The team at Noble Diagnostics</p>
      </div>

      {/* How this report helps you */}
      <div style={{ marginTop: '16px', breakInside: 'avoid' }}>
        <SectionTitle>How this report helps you</SectionTitle>
        <div style={{ marginTop: '11px', display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '10px' }}>
          {features.map((f) => (
            <div key={f.t} style={{ border: `1px solid ${HAIR}`, borderRadius: '11px', padding: '13px 14px' }}>
              <div style={{ width: '34px', height: '34px', borderRadius: '9px', background: f.bg, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <WIcon name={f.icon} color={f.ic} size={20} />
              </div>
              <div style={{ fontSize: '12px', fontWeight: 800, color: INK, marginTop: '9px' }}>{f.t}</div>
              <div style={{ fontSize: '10px', color: MUTED, marginTop: '3px', lineHeight: 1.5 }}>{f.d}</div>
            </div>
          ))}
        </div>
      </div>

      {/* What's inside — numbered contents */}
      <div style={{ marginTop: '16px', breakInside: 'avoid' }}>
        <SectionTitle>What’s inside</SectionTitle>
        <div style={{ marginTop: '11px', border: `1px solid ${HAIR}`, borderRadius: '12px', overflow: 'hidden' }}>
          {toc.map((s, i) => (
            <div
              key={s.n}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '14px',
                padding: '11px 16px',
                borderTop: i === 0 ? 'none' : `1px solid ${HAIR}`,
              }}
            >
              <div style={{ fontSize: '13px', fontWeight: 800, color: s.c, fontVariantNumeric: 'tabular-nums', width: '22px', flex: '0 0 auto' }}>{s.n}</div>
              <div style={{ width: '3px', alignSelf: 'stretch', background: s.c, borderRadius: '2px', flex: '0 0 auto' }} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: '12.5px', fontWeight: 800, color: INK }}>{s.t}</div>
                <div style={{ fontSize: '10px', color: MUTED, marginTop: '1px' }}>{s.d}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* This report — compact info strip (no break-inside:avoid so it settles
          into the remaining space rather than orphaning to a new page) */}
      <div
        style={{
          marginTop: '16px',
          background: BRAND_SOFT,
          borderRadius: '10px',
          padding: '11px 16px',
          display: 'flex',
          flexWrap: 'wrap',
          gap: '6px 26px',
        }}
      >
        {[
          ['Prepared for', preparedForName(data.patientName, data.sex)],
          ['Age / Sex', `${ageLabel(data.age, data.ageUnit)} · ${genderLabel(data.sex)}`],
          ['Sample', data.sid],
          ['Collected', fmtDate(data.sampleDrawn)],
          ['Reported', fmtDate(data.reportedAt)],
          ['Referred by', referredBy],
        ].map(([k, v]) => (
          <span key={k} style={{ fontSize: '11px' }}>
            <span style={{ color: MUTED }}>{k}: </span>
            <span style={{ color: INK, fontWeight: 700 }}>{v}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────

export function SmartBooklet({ data }: { data: SmartBookletData }) {
  const { analytes, categories } = readSections(data.sections);
  const total = analytes.length;
  const alerts = analytes.filter((a) => a.alert);
  const alertCount = alerts.length;
  const normalCount = total - alertCount;
  const pctHealthy = total > 0 ? Math.round((normalCount / total) * 100) : 100;

  const byCategory = new Map<string, Analyte[]>();
  for (const a of analytes) {
    if (!byCategory.has(a.categoryId)) byCategory.set(a.categoryId, []);
    byCategory.get(a.categoryId)!.push(a);
  }
  // Already in the API's order, which follows the LIS's own.
  const orderedCategories = categories.filter((c) => byCategory.has(c.id));

  const name = firstName(data.patientName);
  const summaryLine =
    alertCount === 0
      ? `Good news — every one of your ${total} results is sitting in a healthy range.`
      : `Most of your results look good. ${normalCount} of ${total} are in a healthy range, and ${alertCount} ${alertCount === 1 ? 'is worth a closer look' : 'are worth a closer look'} with your doctor.`;

  return (
    <div
      style={{
        fontFamily: 'Inter, "Segoe UI", Arial, Helvetica, sans-serif',
        color: INK,
        background: '#fff',
        WebkitPrintColorAdjust: 'exact',
        printColorAdjust: 'exact',
      }}
    >
      <Cover data={data} />

      {/* Everything from here sits on the margined content pages (2+). */}
      <div style={{ maxWidth: '820px', margin: '0 auto', padding: '2px 2px 8px' }}>
        <Welcome data={data} />

        {/* ── Snapshot ── */}
        <div style={{ breakBefore: 'page', pageBreakBefore: 'always' }}>
          <SectionTitle>Your snapshot</SectionTitle>
          <div
            style={{
              marginTop: '11px',
              position: 'relative',
              overflow: 'hidden',
              borderRadius: '16px',
              border: `1px solid ${HAIR}`,
              background: `linear-gradient(120deg, ${BRAND_SOFT} 0%, #f5f4fc 55%, #ffffff 100%)`,
              padding: '18px 22px',
            }}
          >
            {/* soft emblem in the corner for depth */}
            <div style={{ position: 'absolute', right: '-30px', top: '-34px', width: '150px', height: '150px', pointerEvents: 'none' }} aria-hidden>
              <svg width="150" height="150" viewBox="0 0 150 150" fill="none">
                {[70, 54, 38].map((r, i) => (
                  <circle key={i} cx="75" cy="75" r={r} stroke={BRAND} strokeOpacity={0.05 + i * 0.015} strokeWidth="1.2" />
                ))}
              </svg>
            </div>

            <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: '22px', flexWrap: 'wrap' }}>
              <WellnessDonut healthy={normalCount} total={total} />

              <div style={{ flex: '1 1 280px', minWidth: '270px' }}>
                <div style={{ fontSize: '16px', fontWeight: 800, color: BRAND, letterSpacing: '-0.01em' }}>
                  {alertCount === 0 ? 'Everything looks great.' : alertCount === 1 ? 'A mostly healthy picture.' : 'A largely healthy picture.'}
                </div>
                <div style={{ fontSize: '12px', color: MUTED, lineHeight: 1.55, marginTop: '4px', maxWidth: '470px' }}>
                  <span style={{ fontWeight: 800, color: INK }}>{name}, </span>
                  {summaryLine}
                </div>
                {/* proportion bar: healthy vs to-look-at */}
                <div style={{ marginTop: '13px' }}>
                  <div style={{ display: 'flex', height: '10px', borderRadius: '999px', overflow: 'hidden', background: '#e7e4f1' }}>
                    <div style={{ width: `${pctHealthy}%`, background: TRACK_GREEN }} />
                    {alertCount > 0 && <div style={{ width: `${100 - pctHealthy}%`, background: TRACK_RED }} />}
                  </div>
                  <div style={{ display: 'flex', gap: '16px', marginTop: '6px' }}>
                    <span style={{ fontSize: '9px', fontWeight: 700, color: GREEN, display: 'flex', alignItems: 'center', gap: '4px' }}>
                      <span style={{ width: '7px', height: '7px', borderRadius: '999px', background: TRACK_GREEN }} /> {pctHealthy}% in a healthy range
                    </span>
                    {alertCount > 0 && (
                      <span style={{ fontSize: '9px', fontWeight: 700, color: RED, display: 'flex', alignItems: 'center', gap: '4px' }}>
                        <span style={{ width: '7px', height: '7px', borderRadius: '999px', background: TRACK_RED }} /> {alertCount} to review
                      </span>
                    )}
                  </div>
                </div>
              </div>

              {/* stat chips */}
              <div style={{ display: 'flex', gap: '10px', flex: '0 0 auto' }}>
                <StatChip n={total} label="tests done" color={BRAND} />
                <StatChip n={normalCount} label="healthy" color={GREEN} />
                <StatChip n={alertCount} label="to look at" color={alertCount ? RED : GREEN} />
              </div>
            </div>
          </div>
        </div>

        {/* ── Health areas at a glance ── */}
        <div style={{ marginTop: '20px' }}>
          <SectionTitle>Your health areas at a glance</SectionTitle>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '9px', marginTop: '11px' }}>
            {orderedCategories.map((cat) => {
              const list = byCategory.get(cat.id)!;
              const vis = categoryVis(cat.id);
              const { level } = categoryRisk(list);
              const rm = RISK_META[level];
              return (
                <div
                  key={cat.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '11px',
                    padding: '11px 13px',
                    borderRadius: '12px',
                    border: `1px solid ${HAIR}`,
                    background: '#fff',
                    boxShadow: '0 1px 2px rgba(20,16,60,0.04)',
                  }}
                >
                  <div
                    style={{
                      width: '36px',
                      height: '36px',
                      borderRadius: '10px',
                      background: vis.soft,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flex: '0 0 auto',
                    }}
                  >
                    <OrganIcon name={vis.icon} color={vis.ink} size={21} />
                  </div>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: '11.5px', fontWeight: 800, color: INK, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{cat.title}</div>
                    <div style={{ fontSize: '9px', color: FAINT, marginTop: '1px', fontWeight: 600 }}>
                      {list.length} {list.length === 1 ? 'result' : 'results'}
                    </div>
                  </div>
                  <div
                    style={{
                      flex: '0 0 auto',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '5px',
                      background: rm.soft,
                      border: `1px solid ${rm.track}55`,
                      borderRadius: '999px',
                      padding: '4px 9px',
                    }}
                  >
                    <span style={{ width: '6px', height: '6px', borderRadius: '999px', background: rm.track }} />
                    <span style={{ fontSize: '9px', fontWeight: 800, color: rm.track, whiteSpace: 'nowrap' }}>{rm.verdict}</span>
                  </div>
                </div>
              );
            })}
          </div>

          {alertCount > 0 && (
            <div style={{ marginTop: '11px', background: AMBER_SOFT, border: `1px solid ${AMBER_LINE}`, borderRadius: '10px', padding: '12px 15px' }}>
              <div style={{ fontSize: '11.5px', fontWeight: 800, color: '#8a5e10' }}>
                A few things to talk to your doctor about
              </div>
              <div style={{ fontSize: '10.5px', color: '#6f5415', marginTop: '5px', lineHeight: 1.55 }}>
                These results fell outside the usual range. That’s not a diagnosis on its own — it’s
                a prompt to review them together with your doctor:
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '9px' }}>
                {alerts.map((a, i) => (
                  <span
                    key={i}
                    style={{
                      fontSize: '10px',
                      fontWeight: 700,
                      color: '#8a3a1a',
                      background: '#fff',
                      border: `1px solid ${AMBER_LINE}`,
                      borderRadius: '999px',
                      padding: '4px 11px',
                    }}
                  >
                    {a.friendlyName.replace(/ —.*$/, '')} · {a.row.value} {a.row.unit ?? ''}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* ── Chapters ── */}
        <div style={{ marginTop: '22px' }}>
          {/* Keep the section heading glued to the first chapter so it never
              strands at the bottom of a page with a blank gap below it. */}
          <div style={{ breakAfter: 'avoid', pageBreakAfter: 'avoid' }}>
            <SectionTitle>Your results, explained</SectionTitle>
          </div>
          {orderedCategories.map((cat) => {
            const list = byCategory.get(cat.id)!;
            return (
              // No break-inside:avoid on the whole chapter — a long chapter must
              // be allowed to flow across pages (else it jumps wholesale to the
              // next page and leaves a blank gap behind). The intro card keeps
              // itself together; the results flow after it.
              <div key={cat.id} style={{ marginTop: '16px' }}>
                {/* Keep the rich system intro glued to its first result so the
                    opener never strands at the very bottom of a page. */}
                <div style={{ breakAfter: 'avoid', pageBreakAfter: 'avoid' }}>
                  <CategoryIntro cat={cat} list={list} />
                </div>
                {list.map((a, i) => (
                  <ResultBlock key={i} a={a} />
                ))}
              </div>
            );
          })}
        </div>

        {/* ── Your Wellness ── */}
        <Wellness data={data} alerts={alerts} total={total} />

        {/* ── Report summary for the doctor ── */}
        <ReportSummary
          categories={orderedCategories.map((c) => ({
            title: c.title,
            analytes: byCategory.get(c.id)!,
          }))}
        />

        {/* ── Signatures ── */}
        {data.signers && data.signers.length > 0 && (
          <div style={{ marginTop: '26px', display: 'flex', gap: '32px', flexWrap: 'wrap', alignItems: 'flex-end', breakInside: 'avoid' }}>
            {data.signers.map((s) => (
              <div key={s.id} style={{ textAlign: 'center', minWidth: '150px' }}>
                {s.signatureDataUrl && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={s.signatureDataUrl} alt="" style={{ height: '34px', width: 'auto', margin: '0 auto 3px' }} />
                )}
                <div style={{ borderTop: `1px solid ${INK}`, paddingTop: '3px', fontSize: '10.5px', fontWeight: 700, color: INK }}>
                  {s.doctorName ? `Dr. ${s.doctorName.replace(/^dr\.?\s*/i, '')}` : '—'}
                </div>
                {s.designation && <div style={{ fontSize: '8.5px', color: MUTED }}>{s.designation}</div>}
              </div>
            ))}
            {data.qr && (
              <div style={{ marginLeft: 'auto', textAlign: 'center' }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={data.qr} alt="Verify online" style={{ height: '56px', width: '56px' }} />
                <div style={{ fontSize: '7.5px', color: MUTED, marginTop: '2px' }}>Scan to verify</div>
              </div>
            )}
          </div>
        )}

        {/* ── Footer / disclaimer ── */}
        <div style={{ marginTop: '20px', borderTop: `2px solid ${BRAND_SOFT}`, paddingTop: '11px', fontSize: '9px', color: FAINT, lineHeight: 1.6 }}>
          <p style={{ margin: '0 0 5px' }}>
            <strong style={{ color: INK }}>A note on this report.</strong> This is a patient-friendly
            summary made to help you understand your results — it doesn’t replace your doctor’s
            advice or the full clinical report. A green “Healthy” badge means a result is within the
            expected range; a red “Attention” badge means it’s outside the usual range and worth
            discussing. Healthy ranges can vary with age, sex, physiology and lab method.
          </p>
          {data.processedAt && (
            <p style={{ margin: '0' }}>
              Processed at {data.processedAt.name}
              {data.processedAt.address ? `, ${data.processedAt.address}` : ''}
              {data.processedAt.city ? `, ${data.processedAt.city}` : ''}
              {data.processedAt.phone ? ` · ${data.processedAt.phone}` : ''}. Generated{' '}
              {fmtDate(data.printedAt)}.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

/** A compact stat card with a top accent bar (used in the snapshot). */
function StatChip({ n, label, color }: { n: number; label: string; color: string }) {
  return (
    <div
      style={{
        minWidth: '74px',
        textAlign: 'center',
        background: '#fff',
        border: `1px solid ${HAIR}`,
        borderRadius: '11px',
        padding: '11px 12px 9px',
        boxShadow: '0 1px 3px rgba(20,16,60,0.05)',
      }}
    >
      <div style={{ height: '3px', width: '22px', borderRadius: '999px', background: color, margin: '0 auto 7px' }} />
      <div style={{ fontSize: '24px', fontWeight: 800, color, fontVariantNumeric: 'tabular-nums', lineHeight: 1 }}>{n}</div>
      <div style={{ fontSize: '9px', color: MUTED, marginTop: '4px', fontWeight: 700, letterSpacing: '0.02em' }}>{label}</div>
    </div>
  );
}
