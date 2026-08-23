/**
 * Manual-discount policy for the B2C (walk-in) order form, ported from Telo's
 * lib/discountPolicy.ts so the two counters enforce the SAME contract. The
 * server holds the authoritative copy (Orders/DiscountPolicy.cs); this one
 * exists so the operator sees the ceiling while typing instead of at submit.
 *
 * Default ceiling 20% of the bill. MDCARE / MEDICARE are contractually capped
 * at 10%, and for them a set of floor-priced tests takes no discount at all:
 * their line value drops out of the discountable base, so the cap is a % of
 * the OTHER lines only. Custom (external) lines stay discountable.
 */

export const DEFAULT_DISCOUNT_CAP_PCT = 0.2;

const CLIENT_DISCOUNT_CAP_PCT: Record<string, number> = {
  MDCARE: 0.1,
  MEDICARE: 0.1,
};

const NON_DISCOUNTABLE_CODES = new Set<string>([
  'HE011', // Complete Blood Count (CBC)
  'BI114', // Glucose - Fasting
  'BI116', // Glucose - Random
  'BI115', // Glucose - Post Prandial (PP)
  'HE017', // Erythrocyte Sedimentation Rate (ESR)
  'CP004', // Complete Urine Examination
  'BI221', // TSH
  'BI034', // Anti-Mullerian Hormone (AMH)
  'BI181', // PSA (Prostate Specific Antigen) Total
  'HE021', // Hemoglobin
  'HE006', // Blood Grouping and Typing (ABO and Rh)
  'BI089', // Creatinine
  'BI224', // Urea
  'BI227', // Uric acid
  'BI209', // Testosterone - Total
]);

const NON_DISCOUNTABLE_BY_CLIENT: Record<string, ReadonlySet<string>> = {
  MDCARE: NON_DISCOUNTABLE_CODES,
  MEDICARE: NON_DISCOUNTABLE_CODES,
};

const EMPTY: ReadonlySet<string> = new Set();

export function discountCapPct(clientCode: string | null | undefined): number {
  const code = (clientCode ?? '').trim().toUpperCase();
  return CLIENT_DISCOUNT_CAP_PCT[code] ?? DEFAULT_DISCOUNT_CAP_PCT;
}

/** Whole-number percent (10, 20) for operator-facing messages. */
export function discountCapLabel(clientCode: string | null | undefined): number {
  return Math.round(discountCapPct(clientCode) * 100);
}

export function nonDiscountableTestCodes(
  clientCode: string | null | undefined,
): ReadonlySet<string> {
  const code = (clientCode ?? '').trim().toUpperCase();
  return NON_DISCOUNTABLE_BY_CLIENT[code] ?? EMPTY;
}

/** `total` minus the value of any non-discountable lines. Never negative. */
export function discountableTotal(
  clientCode: string | null | undefined,
  lines: { code: string | null | undefined; amount: number }[],
  total: number,
): number {
  const excl = nonDiscountableTestCodes(clientCode);
  if (excl.size === 0) return total;
  let excluded = 0;
  for (const l of lines) {
    if (excl.has((l.code ?? '').trim().toUpperCase())) excluded += l.amount || 0;
  }
  return Math.max(0, total - excluded);
}

// ── Gold Card details, same leniency as Telo's lib/gold-card.ts ────────────
// Lenient on format (the exact card scheme is not known here) but rejects
// trivially-fake entries like "1" or "x", so the 50% benefit cannot be
// claimed without a plausible card and name.

export function isValidGoldCardNumber(raw: string | null | undefined): boolean {
  const v = (raw ?? '').trim();
  return v.length >= 4 && /^[A-Za-z0-9][A-Za-z0-9 -]*$/.test(v);
}

export function isValidGoldCardHolder(raw: string | null | undefined): boolean {
  const v = (raw ?? '').trim();
  return v.length >= 3 && /[A-Za-z]/.test(v);
}
