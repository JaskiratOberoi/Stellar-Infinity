import type { AnalyteTrend, TrendPoint } from '../api/client';
import { intervalOf } from './reportModel';

/**
 * The Trending report's model: each analyte as named bands down the side
 * and one column per visit, the value sitting in the band it falls in.
 *
 * Modelled on the "Risk Level" matrix some labs print — severe deficiency,
 * mild deficiency, optimal, increased, toxic, one column per sample date —
 * but built from what this lab already prints: the reference text on the
 * result row. Where that text names bands with limits (Vitamin D's
 * deficiency / insufficiency / sufficiency / toxicity, a lipid's desirable /
 * borderline / high) they are the rows. Where it is a plain interval the
 * rows are below, within and above. Age-banded text ("0.35–5.50 : 18 Yrs –
 * 55 Yrs") is an interval by age, not by value, and falls back to the
 * interval reading directionOf already uses. No catalogue is consulted, so
 * the legacy LIS is untouched.
 */

export interface Band {
  label: string;
  /** Lower bound inclusive; null is open. */
  lo: number | null;
  /** Upper bound exclusive; null is open. */
  hi: number | null;
  /** The band a healthy value sits in, for the reader's eye. */
  healthy: boolean;
}

export interface TrendColumn { date: string | null; sid: string | null; isCurrent: boolean }

export interface TrendCell { value: number; label: string; bandIndex: number; abnormal: boolean }

export interface TrendAnalyte {
  key: string;
  name: string;
  unit: string | null;
  bands: Band[];
  columns: TrendColumn[];
  /** One entry per column; null where the visit had no result for this analyte. */
  cells: (TrendCell | null)[];
  /** Latest minus previous, when both exist. */
  delta: number | null;
  /** The reference text the bands were read from. */
  rangeText: string | null;
}

const AGE_WORDS = /\b(yr|yrs|year|years|month|months|mon|day|days|week|weeks|newborn|p(a)?ediatric|adult|adults|child|children|infant|trimester|pregnan\w*|male|female|men|women|boys|girls)\b/i;
const HEALTHY = /normal|desirable|optimal|sufficien|adequate|healthy|non[- ]?diabetic|negative|target/i;
const UPPER_WORDS = /high|toxic|increas|elevat|excess|risk|very|severe|hyper|overload|raised/i;
/*
 * One band of a reference text: a label, an optional operator, a number,
 * an optional second number. Scanned globally, so the LIS's one-line texts
 * ("Optimal <100 Near Optimal 100-129 Borderline High 130-159 High 160-189
 * Very High >190") yield one band per segment; multi-line texts yield the
 * same, one per line.
 */
const SEG_RE = /([A-Za-z][A-Za-z /&()',.-]*?)\s*:?\s*(<=|≤|<|>=|≥|>|=)?\s*(-?\d+(?:\.\d+)?)(?:\s*(?:-|–|to)\s*(-?\d+(?:\.\d+)?))?/g;
/* The same, value first: "< 5.7 Non-Diabetic 5.7 - 6.5 Pre-Diabetic > 6.5 Diabetic". */
const VSEG_RE = /(<=|≤|<|>=|≥|>|=)?\s*(-?\d+(?:\.\d+)?)(?:\s*(?:-|–|to)\s*(-?\d+(?:\.\d+)?))?\s*:?\s*([A-Za-z][A-Za-z /&()',.-]*?)(?=\s*(?:<=|≤|<|>=|≥|>|=|-?\d|;|$))/g;
const NOT_HEALTHY = /border|near|above|insufficien|deficien|undesirable|non-?optimal|sub-?optimal|pre-?diab|abnormal/i;
const UNIT_RE = /\b(?:mg|ng|pg|ug|µg|mcg|iu|u|miu|uiu|mmol|umol|µmol|nmol|pmol|g|gm|ml|dl|l|cells|x10\^?\d*|fl|pg)\b(?:\s*\/\s*[a-zµ]{1,3}\b)?/gi;

function firstNumber(s: string | null | undefined): number | null {
  if (!s) return null;
  if (!/^\s*[<>≤≥]?\s*-?\d/.test(s)) return null;
  const m = s.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

function tidyLabel(raw: string): string {
  return raw
    .replace(UNIT_RE, ' ')
    .replace(/\b(?:level|levels|value|values|range)\b/gi, ' ')
    .replace(/[:=|]+/g, ' ')
    .replace(/[\s,.-]+$/g, '')
    .replace(/^[\s,.-]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** The labelled bands a reference text names, in the order written; empty when it names none. */
function namedBands(range: string): Band[] {
  const text = range.replace(/\r?\n|\|/g, ' ; ').replace(/\s+/g, ' ').trim();
  const valueFirst = /^[<>≤≥=\d]/.test(text);
  const out: Band[] = [];
  const push = (rawLabel: string, op: string, a: number, b: number | null): boolean => {
    const label = tidyLabel(rawLabel.replace(/;/g, ' '));
    if (!label || label.length < 3 || /^\d/.test(label)) return true;
    // A label naming an age or a sex marks an age-banded interval, not a value band.
    if (AGE_WORDS.test(label)) return false;
    let lo: number | null = null, hi: number | null = null;
    if (b != null) { lo = a; hi = b; }
    else if (op === '<' || op === '<=' || op === '≤') hi = a;
    else if (op === '>' || op === '>=' || op === '≥') lo = a;
    // A bare "= 240" after "High": the LIS's way of writing ≥ where the
    // font lost the glyph. Read by the label's direction.
    else if (op === '=') { if (UPPER_WORDS.test(label)) lo = a; else hi = a; }
    else return true;
    out.push({ label, lo, hi, healthy: HEALTHY.test(label) && !NOT_HEALTHY.test(label) });
    return true;
  };
  if (valueFirst) {
    for (const m of text.matchAll(VSEG_RE)) {
      if (!push(m[4], m[1] ?? '', Number(m[2]), m[3] != null ? Number(m[3]) : null)) return [];
    }
  } else {
    for (const m of text.matchAll(SEG_RE)) {
      if (!push(m[1], m[2] ?? '', Number(m[3]), m[4] != null ? Number(m[4]) : null)) return [];
    }
  }
  return out;
}

/** Bands from a reference text: named bands when it has two or more, else below / within / above its interval. */
export function bandsOf(range: string | null | undefined): Band[] | null {
  if (!range) return null;
  const named = namedBands(range);
  if (named.length >= 2) {
    // Highest band first; an upper-open band sorts to the top.
    return [...named].sort((a, b) => (b.lo ?? (b.hi != null ? b.hi - 1e-9 : -Infinity)) - (a.lo ?? (a.hi != null ? a.hi - 1e-9 : -Infinity)));
  }
  const iv = intervalOf(range);
  if (!iv) return null;
  const bands: Band[] = [];
  if (iv.hi != null) bands.push({ label: 'Above range', lo: iv.hi, hi: null, healthy: false });
  bands.push({ label: 'Within range', lo: iv.lo, hi: iv.hi, healthy: true });
  if (iv.lo != null) bands.push({ label: 'Below range', lo: null, hi: iv.lo, healthy: false });
  return bands;
}

function bandIndexOf(bands: Band[], v: number): number {
  // Bands are highest first: the first whose floor the value reaches wins;
  // an inclusive top on the healthy band, so a value exactly on the limit
  // stays "within" as the report's own chevron logic keeps it.
  for (let i = 0; i < bands.length; i++) {
    const b = bands[i];
    const aboveLo = b.lo == null || v >= b.lo || (b.healthy && v === b.lo);
    const belowHi = b.hi == null || v < b.hi || (b.healthy && v === b.hi);
    if (aboveLo && belowHi) return i;
  }
  // Outside every named band (a value in the gap the LIS leaves between
  // "200 – 239" and "≥ 240", or beyond the top one): the nearest band.
  let best = bands.length - 1, bestDist = Infinity;
  bands.forEach((b, i) => {
    const d = b.lo != null && v < b.lo ? b.lo - v : b.hi != null && v >= b.hi ? v - b.hi : 0;
    if (d < bestDist) { bestDist = d; best = i; }
  });
  return best;
}

const dayKey = (iso: string | null) => (iso ? iso.slice(0, 10) : '');

/** The matrix for every analyte with two or more numeric points. */
export function buildTrend(analytes: AnalyteTrend[]): TrendAnalyte[] {
  const out: TrendAnalyte[] = [];
  for (const a of analytes) {
    const pts = a.points
      .map((p) => ({ p, n: firstNumber(p.value) }))
      .filter((x): x is { p: TrendPoint; n: number } => x.n !== null)
      .sort((x, y) => (x.p.drawnAt ?? '').localeCompare(y.p.drawnAt ?? ''));
    if (pts.length < 2) continue;
    const latest = pts[pts.length - 1].p;
    const rangeText = latest.range ?? [...pts].reverse().map((x) => x.p.range).find(Boolean) ?? null;
    const bands = bandsOf(rangeText);
    if (!bands) continue;
    // One column per visit day; the same analyte twice on one day keeps the later.
    const cols = new Map<string, { col: TrendColumn; cell: TrendCell }>();
    for (const { p, n } of pts) {
      cols.set(dayKey(p.drawnAt), {
        col: { date: p.drawnAt, sid: p.sid, isCurrent: p.isCurrent },
        cell: { value: n, label: (p.value ?? '').trim(), bandIndex: bandIndexOf(bands, n), abnormal: !!p.abnormal },
      });
    }
    const ordered = [...cols.values()];
    const vals = ordered.map((c) => c.cell.value);
    out.push({
      key: a.testKey,
      name: (a.testName ?? a.testCode ?? a.testKey).trim(),
      unit: a.unit,
      bands,
      columns: ordered.map((c) => c.col),
      cells: ordered.map((c) => c.cell),
      delta: vals.length >= 2 ? vals[vals.length - 1] - vals[vals.length - 2] : null,
      rangeText,
    });
  }
  return out;
}
