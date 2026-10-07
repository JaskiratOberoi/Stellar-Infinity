import { intervalOf, type ReportRow } from './reportModel';

/**
 * The pattern a Complete Blood Count makes, read off its printed rows.
 *
 * A CBC is three stories told by three families of numbers, and a reader
 * takes each in turn: the RED cells (is there anaemia, and are the cells
 * small, normal or large), the WHITE cells (is the count raised or low, and
 * which kind predominates) and the PLATELETS (within range or not). Each is
 * a two-axis lookup like the thyroid square — haemoglobin against MCV,
 * total count against the differential — and the third is a single scale.
 * This reads every axis off the rows against the reference bands PRINTED
 * WITH THEM (the lab's own, already narrowed to the patient's age and sex),
 * never against textbook cut-offs: a child's haemoglobin band is not an
 * adult man's, and the figure must agree with the ▲▼ flags beside the
 * numbers. It needs the four core values with two-sided bands —
 * haemoglobin, MCV, total leucocyte count, platelets — and the neutrophil
 * and lymphocyte percentages; anything less and there is no figure,
 * because a cell lit by guesswork is worse than none.
 */

export type Level = 'low' | 'normal' | 'high';

export interface CbcAxis {
  label: string;
  name: string;
  value: number;
  text: string;
  unit: string | null;
  lo: number;
  hi: number;
  level: Level;
}

export interface CbcReading {
  title: string;
  meaning: string;
  ok: boolean;
}

export interface CbcPattern {
  hb: CbcAxis;
  mcv: CbcAxis;
  tlc: CbcAxis;
  neut: CbcAxis;
  lymph: CbcAxis;
  plt: CbcAxis;
  /** Optional refiners, when the CBC carries them and they can be read. */
  rdw: CbcAxis | null;
  mchc: CbcAxis | null;
  eos: CbcAxis | null;
  anc: CbcAxis | null;
  alc: CbcAxis | null;
  mpv: CbcAxis | null;
  /** Red-cell grid: column by MCV (0 low, 1 normal, 2 high), row by Hb (0 normal, 1 low, 2 high). */
  redCol: 0 | 1 | 2;
  redRow: 0 | 1 | 2;
  /** White-cell grid: column by predominance (0 neutrophils, 1 balanced, 2 lymphocytes), row by TLC (0 high, 1 normal, 2 low). */
  whiteCol: 0 | 1 | 2;
  whiteRow: 0 | 1 | 2;
  red: CbcReading;
  white: CbcReading;
  platelet: CbcReading;
  /** The one-line summary under the three panels. */
  summary: string;
  ok: boolean;
}

const HB = /\bH(A)?EMOGLOBIN\b|\bHB\b|\bHGB\b/i;
const MCV = /\bMCV\b|MEAN\s*CORP\w*\s*VOL/i;
const TLC = /TOTAL\s*(LEU[CK]OCYTE|WBC|WHITE)|\bTLC\b|\bWBC\s*COUNT|\bWBC\b/i;
const NEUT = /NEUTROPHIL/i;
const LYMPH = /LYMPHOCYTE/i;
const EOS = /EOSINOPHIL/i;
const PLT = /PLATELET\s*COUNT|\bPLT\b|\bPLATELETS?\b/i;
const RDW = /\bRDW/i;
const MCHC = /\bMCHC\b/i;
const MPV = /\bMPV\b|MEAN\s*PLATELET\s*VOL/i;
const ABSOLUTE = /ABSOLUTE|\bANC\b|\bALC\b|\bAEC\b|\bAMC\b|\bABC\b|#/i;
const NOT_CBC = /ELECTROPHORESIS|VARIANT|\bA2\b|\bHBA1C\b|GLYCATED|GLYCOSYLATED|\bHBF\b|\bHBS\b|\bHBA0\b|PLASMA|URINE|FLUID|CSF|RETIC|CORRECTED|\bPCT\b|CRIT|FREE/i;

function num(s: string | null): number | null {
  if (!s) return null;
  const m = s.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  return m && /^\s*[<>≤≥]?\s*-?\d/.test(s) ? Number(m[0]) : null;
}

function axisOf(row: ReportRow, label: string): CbcAxis | null {
  const value = num(row.value);
  const iv = intervalOf(row.range);
  if (value == null || !iv || iv.lo == null || iv.hi == null || iv.hi <= iv.lo) return null;
  const level: Level = value < iv.lo ? 'low' : value > iv.hi ? 'high' : 'normal';
  return {
    label, name: (row.name ?? label).trim(), value, text: (row.value ?? '').trim(), unit: row.unit,
    lo: iv.lo, hi: iv.hi, level,
  };
}

/* Red cells, keyed [hb level][mcv level]. */
const RED: Record<Level, Record<Level, CbcReading>> = {
  normal: {
    low: {
      title: 'Microcytosis without anaemia',
      meaning: 'Haemoglobin is within the reference interval but the red cells are smaller than usual. This is often thalassaemia trait or early iron deficiency; a haemoglobin HPLC and iron studies tell the two apart.',
      ok: false,
    },
    normal: {
      title: 'Normal red-cell profile',
      meaning: 'Haemoglobin and red-cell size are both within their reference intervals.',
      ok: true,
    },
    high: {
      title: 'Macrocytosis without anaemia',
      meaning: 'Haemoglobin is within the reference interval but the red cells are larger than usual. Seen with vitamin B12 or folate deficiency, alcohol use, liver disease, an underactive thyroid and some medicines; B12 and folate levels may be considered.',
      ok: false,
    },
  },
  low: {
    low: {
      title: 'Microcytic anaemia',
      meaning: 'Haemoglobin is below the reference interval with small red cells. This pattern is most often iron deficiency, although thalassaemia trait and anaemia of chronic disease can also produce microcytosis. Iron studies (ferritin, iron profile) may be considered.',
      ok: false,
    },
    normal: {
      title: 'Normocytic anaemia',
      meaning: 'Haemoglobin is below the reference interval with red cells of normal size. Seen with recent blood loss, chronic disease, kidney disease and early iron deficiency, among other causes; a reticulocyte count and iron studies help narrow it down.',
      ok: false,
    },
    high: {
      title: 'Macrocytic anaemia',
      meaning: 'Haemoglobin is below the reference interval with large red cells. Commonly vitamin B12 or folate deficiency, and also liver disease, an underactive thyroid, alcohol use and some medicines. B12 and folate levels may be considered.',
      ok: false,
    },
  },
  high: {
    low: {
      title: 'Raised haemoglobin with small cells',
      meaning: 'Haemoglobin is above the reference interval while the red cells are small — a combination that can point to thalassaemia trait with a raised cell count, or to dehydration on top of small cells. Worth repeating and reviewing.',
      ok: false,
    },
    normal: {
      title: 'Raised haemoglobin (erythrocytosis)',
      meaning: 'Haemoglobin is above the reference interval. Commonly dehydration, smoking, lung or heart conditions or living at altitude; a persistently raised level needs review.',
      ok: false,
    },
    high: {
      title: 'Raised haemoglobin with large cells',
      meaning: 'Haemoglobin is above the reference interval and the red cells are large — a combination seen with dehydration alongside B12 or folate deficiency, alcohol use or liver disease. Worth repeating and reviewing.',
      ok: false,
    },
  },
};

/* White cells, keyed [tlc level][predominance]. */
type Predominance = 'neutrophils' | 'balanced' | 'lymphocytes';
const WHITE: Record<Level, Record<Predominance, CbcReading>> = {
  high: {
    neutrophils: {
      title: 'Neutrophil-predominant leukocytosis',
      meaning: 'Total white-cell count is raised with neutrophils predominating. This pattern can be seen with bacterial infection, inflammation, physiological stress, after steroids and several other conditions. Clinical correlation with symptoms and other investigations is required.',
      ok: false,
    },
    balanced: {
      title: 'Mixed leukocytosis',
      meaning: 'Total white-cell count is raised with a balanced differential. Seen with infection, inflammation, physiological stress, smoking and some medicines. Clinical correlation is required.',
      ok: false,
    },
    lymphocytes: {
      title: 'Lymphocytosis',
      meaning: 'Total white-cell count is raised with lymphocytes predominating. Most often a viral infection; a lymphocytosis that persists on repeat testing needs review.',
      ok: false,
    },
  },
  normal: {
    neutrophils: {
      title: 'Relative neutrophilia',
      meaning: 'Total white-cell count is within range but neutrophils form a larger share than usual. Often physiological stress, smoking, early infection or steroids; of limited significance on its own when the total count is normal.',
      ok: false,
    },
    balanced: {
      title: 'Normal white-cell profile',
      meaning: 'Total white-cell count and the differential are within their reference intervals.',
      ok: true,
    },
    lymphocytes: {
      title: 'Relative lymphocytosis',
      meaning: 'Total white-cell count is within range but lymphocytes form a larger share than usual. Often follows a viral illness; of limited significance on its own when the total count is normal.',
      ok: false,
    },
  },
  low: {
    neutrophils: {
      title: 'Leukopenia with lymphopenia',
      meaning: 'Total white-cell count is below the reference interval and the shortfall is mainly in lymphocytes. Seen with viral infections, steroids, physiological stress and some immune conditions; a repeat count and clinical review are advised.',
      ok: false,
    },
    balanced: {
      title: 'Leukopenia',
      meaning: 'Total white-cell count is below the reference interval. Seen with viral infections, some medicines, vitamin B12 or folate deficiency and bone-marrow conditions; a repeat count and clinical review are advised.',
      ok: false,
    },
    lymphocytes: {
      title: 'Leukopenia with neutropenia',
      meaning: 'Total white-cell count is below the reference interval and the shortfall is mainly in neutrophils. Seen with viral infections, some medicines and bone-marrow conditions; a low neutrophil count lowers resistance to bacterial infection and needs prompt review.',
      ok: false,
    },
  },
};

const PLATELET: Record<Level, CbcReading> = {
  normal: {
    title: 'Platelet count within reference range',
    meaning: 'The platelet count is within the expected range.',
    ok: true,
  },
  low: {
    title: 'Low platelet count (thrombocytopenia)',
    meaning: 'The platelet count is below the reference interval. Seen with viral infections such as dengue, some medicines, immune causes, liver disease and bone-marrow conditions; a peripheral smear excludes clumping, and a very low count needs prompt review.',
    ok: false,
  },
  high: {
    title: 'Raised platelet count (thrombocytosis)',
    meaning: 'The platelet count is above the reference interval. Most often reactive — to infection, inflammation, iron deficiency or recent surgery; a persistently raised count needs review.',
    ok: false,
  },
};

const RED_COL: Record<Level, 0 | 1 | 2> = { low: 0, normal: 1, high: 2 };
const RED_ROW: Record<Level, 0 | 1 | 2> = { normal: 0, low: 1, high: 2 };
const WHITE_COL: Record<Predominance, 0 | 1 | 2> = { neutrophils: 0, balanced: 1, lymphocytes: 2 };
const WHITE_ROW: Record<Level, 0 | 1 | 2> = { high: 0, normal: 1, low: 2 };

const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

export function cbcPatternOf(rows: ReportRow[]): CbcPattern | null {
  const usable = rows.filter((r) => r.name && !NOT_CBC.test(r.name));
  const pick = (re: RegExp, extra?: (name: string) => boolean) =>
    usable.find((r) => re.test(r.name!) && (!extra || extra(r.name!))) ?? null;
  const pct = (name: string) => !ABSOLUTE.test(name);
  const abs = (name: string) => ABSOLUTE.test(name);

  const hbRow = pick(HB, (n) => !/MCH|MEAN|CORP/i.test(n));
  const mcvRow = pick(MCV);
  const tlcRow = pick(TLC);
  const neutRow = pick(NEUT, pct);
  const lymphRow = pick(LYMPH, pct);
  const pltRow = pick(PLT, (n) => !MPV.test(n));
  if (!hbRow || !mcvRow || !tlcRow || !neutRow || !lymphRow || !pltRow) return null;

  const hb = axisOf(hbRow, 'Haemoglobin');
  const mcv = axisOf(mcvRow, 'MCV');
  const tlc = axisOf(tlcRow, 'Total leucocyte count');
  const neut = axisOf(neutRow, 'Neutrophils');
  const lymph = axisOf(lymphRow, 'Lymphocytes');
  const plt = axisOf(pltRow, 'Platelet count');
  if (!hb || !mcv || !tlc || !neut || !lymph || !plt) return null;

  const opt = (row: ReportRow | null, label: string) => (row ? axisOf(row, label) : null);
  const rdw = opt(pick(RDW), 'RDW');
  const mchc = opt(pick(MCHC), 'MCHC');
  const eos = opt(pick(EOS, pct), 'Eosinophils');
  const anc = opt(pick(NEUT, abs), 'Absolute neutrophil count');
  const alc = opt(pick(LYMPH, abs), 'Absolute lymphocyte count');
  const mpv = opt(pick(MPV), 'MPV');

  // Which kind predominates: the percentage that sits above its band, and
  // when both do, the one further above it as a share of the band's width.
  const over = (a: CbcAxis) => (a.level === 'high' ? (a.value - a.hi) / Math.max(1, a.hi - a.lo) : 0);
  let predominance: Predominance = 'balanced';
  if (neut.level === 'high' || lymph.level === 'high') {
    predominance = over(neut) >= over(lymph) ? 'neutrophils' : 'lymphocytes';
  } else if (tlc.level === 'low') {
    // With a low total, the share that FELL names the pattern: a low
    // lymphocyte share means neutrophils predominate, and vice versa.
    if (lymph.level === 'low' && neut.level !== 'low') predominance = 'neutrophils';
    else if (neut.level === 'low' && lymph.level !== 'low') predominance = 'lymphocytes';
  }

  const red = { ...RED[hb.level][mcv.level] };
  if (hb.level === 'low' || mcv.level !== 'normal') {
    const extras: string[] = [];
    if (mchc && mchc.level === 'low') extras.push('the cells are also paler than usual (low MCHC)');
    if (rdw && rdw.level === 'high') extras.push('red-cell size varies more than usual (raised RDW)');
    if (extras.length) red.meaning += ` In this result ${extras.join(', and ')}.`;
  }

  const white = { ...WHITE[tlc.level][predominance] };
  if (eos && eos.level === 'high') {
    white.meaning += ' Eosinophils are also raised, which can accompany allergy, asthma or a parasitic infection.';
    white.ok = false;
  }

  const platelet = { ...PLATELET[plt.level] };
  if (mpv) {
    platelet.meaning += mpv.level === 'normal'
      ? ' Mean platelet volume is within range.'
      : ` Mean platelet volume is ${mpv.level === 'high' ? 'raised, which can mean younger, larger platelets are being made' : 'low'}.`;
  }

  // One line for the three together: the abnormal readings joined, the
  // normal ones stated plainly after them.
  const abnormal = [red, white].filter((r) => !r.ok).map((r) => r.title);
  const parts: string[] = [];
  if (abnormal.length === 2) parts.push(`${abnormal[0]} with ${lower(abnormal[1])}.`);
  else if (abnormal.length === 1) parts.push(`${abnormal[0]}.`);
  if (red.ok && white.ok) parts.push('Red-cell and white-cell profiles are within their reference intervals.');
  else if (red.ok) parts.push('Red-cell profile is within the reference interval.');
  else if (white.ok) parts.push('White-cell profile is within the reference interval.');
  parts.push(platelet.ok ? 'Platelet count is within the reference interval.' : `${platelet.title}.`);

  return {
    hb, mcv, tlc, neut, lymph, plt, rdw, mchc, eos, anc, alc, mpv,
    redCol: RED_COL[mcv.level], redRow: RED_ROW[hb.level],
    whiteCol: WHITE_COL[predominance], whiteRow: WHITE_ROW[tlc.level],
    red, white, platelet,
    summary: parts.join(' '),
    ok: red.ok && white.ok && platelet.ok,
  };
}
