import { intervalOf, type ReportRow } from './reportModel';

/**
 * The thyroid function pattern a profile's TSH and T4 make together.
 *
 * The classic teaching diagram — the square with TSH along the bottom, T4
 * up the side and nine wedges named Hyperthyroidism, Subclinical
 * hypothyroidism and so on — is a two-axis lookup: the pituitary's signal
 * (TSH) against the gland's output (T4). Where the pair lands names the
 * pattern, and T3 refines one corner (T3 toxicosis). This reads the same
 * two axes off the printed rows, against the reference bands printed with
 * them (already narrowed to the patient's age by the API), and hands the
 * figure the cell, the position inside it and plain words for what the
 * pattern usually means. It needs a numeric TSH and T4 with two-sided
 * bands; anything less and there is no figure, because a dot placed by
 * guesswork is worse than none.
 */

export type Level = 'low' | 'normal' | 'high';

export interface ThyroidAxis {
  /** The row's printed name, shortened. */
  label: string;
  name: string;
  value: number;
  text: string;
  unit: string | null;
  lo: number;
  hi: number;
  level: Level;
}

export interface ThyroidPattern {
  tsh: ThyroidAxis;
  t4: ThyroidAxis;
  /** T3, when the profile carries it and it can be read. */
  t3: ThyroidAxis | null;
  /** Grid column for TSH (0 low, 1 normal, 2 high) and row for T4 (0 high, 1 normal, 2 low). */
  col: 0 | 1 | 2;
  row: 0 | 1 | 2;
  title: string;
  meaning: string;
  /** Whether the pattern is the healthy one. */
  ok: boolean;
}

const TSH = /\bTSH\b|THYROID\s*STIMULATING/i;
const T4 = /\bF?T4\b|THYROXINE/i;
const T3 = /\bF?T3\b|IODOTHYRONINE/i;
const NOT_AXIS = /REVERSE|\bRT3\b|ANTIBOD|\bTPO\b|THYROGLOBULIN|UPTAKE|INDEX|RATIO/i;

function num(s: string | null): number | null {
  if (!s) return null;
  const m = s.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  return m && /^\s*[<>≤≥]?\s*-?\d/.test(s) ? Number(m[0]) : null;
}

function axisOf(row: ReportRow, label: string): ThyroidAxis | null {
  const value = num(row.value);
  const iv = intervalOf(row.range);
  if (value == null || !iv || iv.lo == null || iv.hi == null || iv.hi <= iv.lo) return null;
  const level: Level = value < iv.lo ? 'low' : value > iv.hi ? 'high' : 'normal';
  return {
    label, name: (row.name ?? label).trim(), value, text: (row.value ?? '').trim(), unit: row.unit,
    lo: iv.lo, hi: iv.hi, level,
  };
}

/* Rows: T4 high / normal / low; columns: TSH low / normal / high. */
const PATTERNS: Record<Level, Record<Level, { title: string; meaning: string; ok?: boolean }>> = {
  // keyed [t4][tsh]
  high: {
    low: {
      title: 'Overactive thyroid (hyperthyroidism)',
      meaning: 'The thyroid is making too much hormone and the pituitary has switched its signal off. This needs treatment; common causes are Graves’ disease and overactive nodules.',
    },
    normal: {
      title: 'High T4 with a normal TSH',
      meaning: 'Often a binding-protein effect — pregnancy, the contraceptive pill, some medicines — or early overactivity. A free T4 tells the two apart.',
    },
    high: {
      title: 'High TSH with high T4 — unusual',
      meaning: 'Seen with interference in the test, a TSH-producing pituitary growth or resistance to thyroid hormone. This needs specialist review rather than a simple reading.',
    },
  },
  normal: {
    low: {
      title: 'Mildly overactive (subclinical hyperthyroidism)',
      meaning: 'The pituitary’s signal is suppressed while T4 is still within range. Usually repeated in a few weeks; treated if it persists or symptoms are present.',
    },
    normal: {
      title: 'Normal thyroid function',
      meaning: 'TSH and T4 both sit within their reference bands: the thyroid and the pituitary are in balance.',
      ok: true,
    },
    high: {
      title: 'Mildly underactive (subclinical hypothyroidism)',
      meaning: 'T4 is still within range but the pituitary is pushing the thyroid harder than usual. Often watched and repeated; treated if it persists, in pregnancy, or with symptoms.',
    },
  },
  low: {
    low: {
      title: 'Low TSH with low T4',
      meaning: 'Points to the pituitary rather than the thyroid (secondary hypothyroidism), a recent severe illness, or thyroid treatment being adjusted. This needs review.',
    },
    normal: {
      title: 'Low T4 with a normal TSH',
      meaning: 'Can follow a pituitary problem, a recent serious illness or some medicines. Worth repeating and reviewing with the clinical picture.',
    },
    high: {
      title: 'Underactive thyroid (primary hypothyroidism)',
      meaning: 'The thyroid is making too little hormone and the pituitary is pushing it harder. Usually treated with a daily thyroxine tablet, with the dose set by repeat tests.',
    },
  },
};

const COL: Record<Level, 0 | 1 | 2> = { low: 0, normal: 1, high: 2 };
const ROW: Record<Level, 0 | 1 | 2> = { high: 0, normal: 1, low: 2 };

export function thyroidPatternOf(rows: ReportRow[]): ThyroidPattern | null {
  const pick = (re: RegExp) => rows.find((r) => r.name && re.test(r.name) && !NOT_AXIS.test(r.name)) ?? null;
  const tshRow = pick(TSH);
  const t4Row = pick(T4);
  const t3Row = pick(T3);
  if (!tshRow || !t4Row) return null;

  const tsh = axisOf(tshRow, 'TSH');
  const t4 = axisOf(t4Row, /FREE|\bFT4\b/i.test(t4Row.name ?? '') ? 'Free T4' : 'T4');
  if (!tsh || !t4) return null;
  const t3 = t3Row ? axisOf(t3Row, /FREE|\bFT3\b/i.test(t3Row.name ?? '') ? 'Free T3' : 'T3') : null;

  const p = PATTERNS[t4.level][tsh.level];
  let meaning = p.meaning;
  if (t3) {
    if (t4.level === 'normal' && tsh.level === 'low' && t3.level === 'high')
      meaning = 'The pituitary’s signal is suppressed and T3 is raised while T4 is still within range — the T3-toxicosis form of an overactive thyroid. This needs treatment and review.';
    else meaning += t3.level === 'normal'
      ? ` ${t3.label} is within range.`
      : ` ${t3.label} is ${t3.level === 'high' ? 'raised' : 'low'} as well.`;
  }

  return {
    tsh, t4, t3, col: COL[tsh.level], row: ROW[t4.level],
    title: p.title, meaning, ok: !!p.ok && (t3 == null || t3.level === 'normal'),
  };
}
