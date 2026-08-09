/**
 * Reference notes the LIS does not hold.
 *
 * Almost all note and interpretation text on a report comes from the catalogue
 * — tbl_med_test_master.Interpretation, and Telo's profile-level sidecar. These
 * are the handful that live only on the printed reference reports, so they are
 * carried in code and keyed by test code.
 *
 * Ported verbatim from Telo's lib/report/panels.ts. Verbatim matters: this is
 * clinical text that a doctor reads off the page, and a paraphrase is a
 * different claim. If a note needs to change it should change in the catalogue
 * or in both products at once — see the note in the same file on Telo's side.
 */

const TSH_NOTES: string[] = [
  'TSH levels are subject to circadian variation, reaching peak levels between 2 - 4 a.m. and a minimum '
    + 'between 6 - 10 pm. The variation is of the order of 50%, hence time of the day has influence on the '
    + 'measured serum TSH concentrations.',
  'Values <0.03 µIU/mL need to be clinically correlated due to presence of a rare TSH variant in some '
    + 'individuals.',
  'Transient increase in TSH levels or abnormal TSH levels can be seen in various nonthyroidal diseases. '
    + 'Simultaneous measurement of TSH with free T4 is useful in evaluating the differential diagnosis.',
];

/** test code (upper case) → the extra Note lines that test brings with it. */
export const STATIC_NOTES_BY_CODE: Record<string, string[]> = {
  BI221: TSH_NOTES,
};

/**
 * The notes a report carries, given the test codes on it.
 *
 * Deduplicated by text rather than by code: a panel can bring the same note in
 * twice through two of its members, and the same sentence printed twice reads
 * as a mistake.
 */
export function notesForCodes(codes: (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of codes) {
    const code = (raw ?? '').trim().toUpperCase();
    if (!code) continue;
    for (const note of STATIC_NOTES_BY_CODE[code] ?? []) {
      if (seen.has(note)) continue;
      seen.add(note);
      out.push(note);
    }
  }
  return out;
}
