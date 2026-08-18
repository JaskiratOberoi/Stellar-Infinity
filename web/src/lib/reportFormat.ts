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
    // "…200 - 239 High 240" breaks before the Title-case label.
    .flatMap((l) => l.replace(/(\d)\s+(?=[A-Z][a-z])/g, '$1\n').split('\n'))
    .map((l) => normalizeComparators(l.trim()))
    .filter(Boolean);
  return lines.length ? lines.join('\n') : s.trim();
}
