/**
 * How a printed report words and spaces the things it prints.
 *
 * Ported from Telo's components/reporting/tsh-report.tsx. These are not
 * cosmetics: a reference range printed as one run-on line instead of one band
 * per line is harder to read against a value, and the two products' reports are
 * compared side by side.
 */

/** The stamp exactly as Telo prints it: 17/08/2026, 02:43:37 pm.
 *
 *  Pinned to IST, not the runtime's zone: the PDF is rendered by headless
 *  Chromium in a container running UTC, and a report handed to a patient
 *  stamped 5h30m early is a wrong document, not a cosmetic slip. */
const stampFmt = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: true,
});

export function fmtStamp(input: string | Date | null | undefined): string {
  if (input == null || input === '') return '—';
  const d = typeof input === 'string' ? new Date(input) : input;
  if (Number.isNaN(d.getTime())) return '—';
  return stampFmt.format(d);
}

/**
 * A stored birth date (ISO 'YYYY-MM-DD') as DD/MM/YYYY — the day-first form the
 * rest of the report already prints its stamps in. Not run through a timezone:
 * a date of birth is a plain calendar date, and reinterpreting it in IST could
 * shift it by a day.
 */
export function fmtDob(iso: string | null | undefined): string | null {
  const t = (iso ?? '').trim();
  if (!t) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : null;
}

export function genderLabel(sex: string | null | undefined): string {
  if (!sex) return '—';
  const s = sex.trim();
  if (/^m/i.test(s)) return 'Male';
  if (/^f/i.test(s)) return 'Female';
  return s;
}

export function ageLabel(age: number | null | undefined, unit: string | null | undefined): string {
  if (age == null) return '—';
  return `${age} ${(unit ?? 'Year(s)').trim()}`;
}

/**
 * A leading label on interpretation text — "CLINICAL SIGNIFICANCE :", "Note:",
 * "Interpretation:-" — becomes the block's heading instead of being repeated
 * inside it.
 */
export function splitInterp(s: string): { heading: string; body: string } {
  const m = /^\s*(clinical significance|clinical use|interpretation|note)\s*:?-?\s*/i.exec(s);
  const heading = m ? m[1].replace(/\b\w/g, (c) => c.toUpperCase()) : 'Interpretation';
  const body = (m ? s.slice(m[0].length) : s).trim();
  return { heading, body };
}

/**
 * Comparator shorthand, as the LIS prints it: ">=" and "<=" become ≥ and ≤,
 * and a bare "=" before a number — an open upper band like "High = 240" —
 * becomes ≥. A plain band ("13.5 - 17.5") is untouched.
 */
function normalizeComparators(line: string): string {
  const out = line
    .replace(/>\s*=/g, '≥')
    .replace(/<\s*=/g, '≤')
    .replace(/(^|[\s(])=(?=\s*-?\d)/g, '$1≥');

  // A top band stored with no comparator at all ("Very High 190", following
  // "High 160-189") means "≥ 190". Fired only on a severity-banded label that
  // ends in a bare number, so plain, gendered and age-banded single values
  // stay as they are.
  if (
    /\b(very high|high|low|borderline|critical|severe|undesirable)\b/i.test(out) &&
    !/[<>≥≤=]/.test(out) &&
    !/\d\s*[-–]\s*\d/.test(out)
  ) {
    return out.replace(/^(.*[A-Za-z])\s+(\d+(?:\.\d+)?)\s*$/, '$1 ≥ $2');
  }
  return out;
}

/** Split a colon-labelled run-on ("Desirable: > 60 Optimal: 40-59 …") into one
 *  "Label: value" per segment. Unchanged when the line is not labelled. */
function splitColonSegments(line: string): string[] {
  if ((line.match(/:/g) ?? []).length < 2) return [line];
  const re = /([A-Za-z][A-Za-z /]*?)\s*:\s*(.*?)(?=\s+[A-Za-z][A-Za-z /]*?\s*:|$)/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    const v = m[2].trim();
    out.push(v ? `${m[1].trim()}: ${v}` : m[1].trim());
  }
  return out.length >= 2 ? out : [line];
}

/**
 * A reference range, one band per line.
 *
 * The LIS already stores most banded ranges with their line breaks
 * ("Desirable < 200\nBorderline High 200 - 239\nHigh = 240"); those are kept.
 * A run-on band — a new Title-case label straight after a number — is split,
 * as are colon-labelled run-ons, and comparators are normalised. A plain value
 * comes back as it went in.
 */
export function formatRange(s: string | null | undefined): string {
  if (!s) return '—';
  const lines = s
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .flatMap(splitColonSegments)
    // "…200 - 239 High 240" breaks before the Title-case label — but not
    // before a unit word: "0-1 Day: 1.4-8.7" is one band, not "0-1" and "Day".
    .flatMap((l) => l.replace(/(\d)\s+(?=[A-Z][a-z])(?!(?:Days?|Weeks?|Months?|Years?|Yrs?|Hours?|Hrs?)\b)/g, '$1\n').split('\n'))
    .map((l) => normalizeComparators(l.trim()))
    .filter(Boolean);
  return lines.length ? lines.join('\n') : s.trim();
}

/* ---------------------------------------------------------------------------
 * The reference interval for THIS patient.
 *
 * The LIS stores a banded range as one free-text block — "Adults: / Male:
 * 22-322 / Female: 10-291 / Children: / 6 months to 15 years: 7-140 /
 * Infants: …" — and prints the whole of it on every report, so a 36-year-old
 * woman's Ferritin carries eight lines of which one is hers. The ask
 * (03/10/2026) was to show the band that applies to the patient.
 *
 * The rule is SUBTRACTIVE and deliberately timid, because the wrong band on a
 * medical report is worse than every band. A line is dropped only when it is
 * positively ruled out — its sex is not the patient's, or its age band does
 * not contain the patient's age. A line that cannot be classified (a
 * menstrual phase, a trimester, "on contraceptives") is kept, since age and
 * sex cannot settle it; so is anything the parser does not understand. A
 * heading goes when nothing is left under it. And if the pruning would leave
 * no value at all — a 40-year-old against "<40" and ">40", a 16-year-old
 * against "Adult" alone — the full text prints, exactly as before.
 * ------------------------------------------------------------------------- */

export interface RangePatient {
  age: number | null | undefined;
  /** The LIS's unit word: "Year(s)", "Month(s)", "Day(s)" (any spelling that starts the same). */
  ageUnit: string | null | undefined;
  sex: string | null | undefined;
}

const DAY = 1;
const MONTH = 30.4375;
const YEAR = 365.25;

function unitDays(word: string | null | undefined): number | null {
  const w = (word ?? '').trim().toLowerCase();
  if (/^(y|yr)/.test(w)) return YEAR;
  if (/^(m|mo)/.test(w)) return MONTH;
  if (/^(d|day)/.test(w)) return DAY;
  if (/^(w|wk)/.test(w)) return 7;
  return null;
}

/** A band's age limits in days, inclusive, or null when the label carries none. */
interface AgeBand { lo: number; hi: number }

const WORD_BANDS: ReadonlyArray<[RegExp, AgeBand]> = [
  [/\b(new\s*-?\s*borns?|neonates?|neonatal|umbilical cord)\b/i, { lo: 0, hi: 28 }],
  [/\binfants?\b/i, { lo: 0, hi: YEAR - 1 }],
  [/\b(children|child|p(a)?ediatric|peadiatric|kids?)\b/i, { lo: 0, hi: 18 * YEAR - 1 }],
  [/\b(adults?|adulthood)\b/i, { lo: 18 * YEAR, hi: Infinity }],
  [/\b(elderly|seniors?|geriatric)\b/i, { lo: 60 * YEAR, hi: Infinity }],
];

const UNIT = '(years?|yrs?|y|months?|mos?|m|weeks?|wks?|days?|d)';
// "7-12 years", "1 to 6 yrs", "2weeks-4 months", "6 months to 15 years", "0-1 Day"
const SPAN = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*${UNIT}?\\s*(?:-|–|—|to)\\s*(\\d+(?:\\.\\d+)?)\\s*${UNIT}\\b`, 'i');
// "<12 months", "< 40 years", "upto 5 days", "below 1 year"
const BELOW = new RegExp(`(?:<|≤|<=|up\\s*to|upto|below|under)\\s*(\\d+(?:\\.\\d+)?)\\s*${UNIT}\\b`, 'i');
// ">40years", "above 6 months", "over 19 months"
const ABOVE = new RegExp(`(?:>|≥|>=|above|over|after)\\s*(\\d+(?:\\.\\d+)?)\\s*${UNIT}\\b`, 'i');

function ageBandOf(label: string): AgeBand | null {
  let m = SPAN.exec(label);
  if (m) {
    const hiUnit = unitDays(m[4]) ?? YEAR;
    const loUnit = unitDays(m[2]) ?? hiUnit;
    // "7-12 years" means up to the end of the twelfth year: a child of 12
    // years 8 months is "12 years" on the sheet and belongs here, not in
    // the band that starts at 13.
    return { lo: Number(m[1]) * loUnit, hi: (Number(m[3]) + 1) * hiUnit - 1 };
  }
  m = BELOW.exec(label);
  if (m) return { lo: 0, hi: Number(m[1]) * (unitDays(m[2]) ?? YEAR) - 1 };
  m = ABOVE.exec(label);
  if (m) return { lo: (Number(m[1]) + 1) * (unitDays(m[2]) ?? YEAR), hi: Infinity };
  for (const [re, band] of WORD_BANDS) if (re.test(label)) return band;
  return null;
}

type Sex = 'M' | 'F';
function sexOf(label: string): Sex | null {
  if (/\b(fe\s*-?\s*males?|women|woman|girls?|menstruat\w*|menopaus\w*|pregnan\w*|trimester|follicular|luteal|ovulat\w*|mid[\s-]*cycle|contracept\w*)\b/i.test(label)) return 'F';
  if (/\b(males?|men|man|boys?)\b/i.test(label)) return 'M';
  return null;
}

/** A condition age and sex cannot settle — the line stays whatever the patient. */
const UNDECIDABLE = /\b(trimester|pregnan\w*|follicular|luteal|mid[\s-]*cycle|ovulat\w*|menopaus\w*|menstruat\w*|contracept\w*|lmp|fasting|post[\s-]*prandial|smokers?|non[\s-]*smokers?|vegetarian|supplement\w*|therapeutic|toxic)\b/i;

function patientSex(sex: string | null | undefined): Sex | null {
  const s = (sex ?? '').trim();
  if (/^m/i.test(s)) return 'M';
  if (/^f/i.test(s)) return 'F';
  return null;
}

/**
 * The bands of a formatted range that apply to the patient, one per line, or
 * the full text when nothing can be ruled out safely. Takes what formatRange
 * returns — one "Label: value" or heading per line — never the raw string.
 */
export function rangeForPatient(formatted: string, patient: RangePatient): string {
  if (!formatted || formatted === '—' || !formatted.includes('\n')) return formatted;
  const ageDays = patient.age != null && patient.age >= 0 && unitDays(patient.ageUnit ?? 'Year(s)') != null
    ? patient.age * (unitDays(patient.ageUnit ?? 'Year(s)') as number)
    : null;
  const sex = patientSex(patient.sex);
  if (ageDays == null && sex == null) return formatted;

  type Line = {
    text: string; label: string; heading: boolean; keep: boolean; headingIdx: number | null;
    /** Positively the patient's: an age band or sex on it (or its heading) that fits. */
    fits: boolean;
  };
  const lines: Line[] = formatted.split('\n').map((text) => {
    const m = /^([^:]*?)\s*:\s*(.*)$/.exec(text);
    const label = m ? m[1] : text;
    const value = m ? m[2] : '';
    // A "label: value" whose value carries no number is a heading too
    // ("Pregnancy:", "Paediatric :"); so is a bare word line.
    const heading = !/\d/.test(value) && !/\d/.test(label) || (!m && !/\d/.test(text));
    return { text, label, heading, keep: true, headingIdx: null, fits: false };
  });

  // "Male: 25-200 / Female: 25-170 / Children: …" — a sex-only line beside
  // a paediatric band is the ADULT band, as the lab means it.
  const hasPaediatric = lines.some((l) => {
    const b = ageBandOf(l.label);
    return b != null && b.hi < 18 * YEAR;
  });
  const ADULT: AgeBand = { lo: 18 * YEAR, hi: Infinity };
  // A menstrual phase, a trimester, "on contraceptives": not for a child.
  const REPRODUCTIVE = /\b(trimester|pregnan\w*|follicular|luteal|mid[\s-]*cycle|ovulat\w*|menopaus\w*|menstruat\w*|contracept\w*|lmp)\b/i;
  const REPRODUCTIVE_AGE: AgeBand = { lo: 10 * YEAR, hi: Infinity };

  const ruledOut = (band: AgeBand | null, s: Sex | null): boolean =>
    (s != null && sex != null && s !== sex)
    || (band != null && ageDays != null && (ageDays < band.lo || ageDays > band.hi));
  const fits = (band: AgeBand | null, s: Sex | null): boolean =>
    !ruledOut(band, s) && ((band != null && ageDays != null) || (s != null && sex != null));

  // Decide each line from its own label AND the heading it sits under —
  // "Male: 22-322" under "Adults:" is adult males.
  let heading: { idx: number; band: AgeBand | null; sex: Sex | null } | null = null;
  let dropped = 0;
  lines.forEach((line, i) => {
    if (line.heading) {
      heading = { idx: i, band: ageBandOf(line.label), sex: sexOf(line.label) };
      line.headingIdx = i;
      return;
    }
    line.headingIdx = heading?.idx ?? null;
    const ownSex = sexOf(line.label);
    let own = ageBandOf(line.label);
    if (own == null && REPRODUCTIVE.test(line.label)) own = REPRODUCTIVE_AGE;
    if (own == null && ownSex != null && heading == null && hasPaediatric) own = ADULT;
    const band = own ?? heading?.band ?? null;
    const s = ownSex ?? heading?.sex ?? null;
    if (ruledOut(band, s)) { line.keep = false; dropped++; return; }
    // Undecidable by age or sex is kept, but is nobody's band in particular.
    line.fits = !UNDECIDABLE.test(line.label) && fits(band, s);
  });
  if (dropped === 0) return formatted;

  // A heading with nothing left under it goes too; a heading whose own
  // label the patient fails ("Children:") goes with everything under it.
  lines.forEach((line, i) => {
    if (!line.heading) return;
    const under = lines.filter((l) => !l.heading && l.headingIdx === i);
    const selfOut = ruledOut(ageBandOf(line.label), sexOf(line.label));
    if (selfOut) for (const l of under) l.keep = false;
    if (under.length > 0 && under.every((l) => !l.keep)) line.keep = false;
    if (under.length === 0 && selfOut) line.keep = false;
  });

  // Something must have been POSITIVELY the patient's for the pruning to
  // stand; a residue of lines nobody could place (a 16-year-old left with
  // only the trimester bands, a man left with "5 weeks") is not an answer.
  const kept = lines.filter((l) => l.keep);
  if (!kept.some((l) => !l.heading && l.fits)) return formatted;
  return kept.map((l) => l.text).join('\n');
}

/**
 * Infinity-only rewording of catalogue names at DISPLAY time.
 *
 * Noble is the live LIS shared with Telo and Listec, and the strings below
 * are master data there — copied onto every result row at registration, and
 * printed as-is by both older products. When the lab changed instruments the
 * ask was that Infinity's reports say so WITHOUT touching the database or
 * anything the LIS prints. So the rename happens here, on the way to the
 * page, and nowhere else: the row still says what Noble says.
 *
 * Add a pair per rename. Matched case-insensitively on the phrase, so the
 * "& Microscopy" variant and any future re-spelling are covered by one line.
 */
const DISPLAY_RENAMES: ReadonlyArray<[RegExp, string]> = [
  [/\bAutomated\s+5[\s-]*Part\b/gi, 'Automated 7 Part'],
];

export function displayTestName(name: string | null | undefined): string | null {
  if (!name) return null;
  let out = name;
  for (const [re, to] of DISPLAY_RENAMES) out = out.replace(re, to);
  return out;
}
