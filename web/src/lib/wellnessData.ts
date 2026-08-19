/**
 * Reference data for the Smart Report's "Your Wellness" section — an estimated
 * daily-calorie table and age/sex-appropriate preventive screenings, plus
 * evergreen lifestyle tips. Mirrors the "Your Wellness" pages of Quest's
 * "Blueprint for Wellness" booklet.
 *
 * Copied VERBATIM from Telo (lib/report/wellnessData.ts). Verbatim matters:
 * these are clinical reference figures a patient reads and acts on, and a
 * paraphrase is a different recommendation. If one needs to change it should
 * change in both products, in the same commit.
 *
 * Sources (web-verified): calorie needs — USDA Dietary Guidelines for Americans
 * 2020–2025, Appendix 2; screenings — USPSTF A/B recommendations + CDC/ACIP;
 * eye/dental cadences — AAO/ADA. These are general references; the report always
 * tells the reader their doctor tailors them to the individual.
 */

export interface CalorieRow {
  age: string;
  sedentary: number;
  moderate: number;
  active: number;
}

export const CALORIE_DEFINITIONS = {
  sedentary: 'Only the light activity of day-to-day living.',
  moderate: 'Daily living plus walking ~1.5–3 miles a day (or equivalent).',
  active: 'Daily living plus walking more than 3 miles a day (or equivalent).',
};

export const CALORIES: { male: CalorieRow[]; female: CalorieRow[] } = {
  male: [
    { age: '19–20', sedentary: 2600, moderate: 2800, active: 3000 },
    { age: '21–25', sedentary: 2400, moderate: 2800, active: 3000 },
    { age: '26–30', sedentary: 2400, moderate: 2600, active: 3000 },
    { age: '31–35', sedentary: 2400, moderate: 2600, active: 3000 },
    { age: '36–40', sedentary: 2400, moderate: 2600, active: 2800 },
    { age: '41–45', sedentary: 2200, moderate: 2600, active: 2800 },
    { age: '46–50', sedentary: 2200, moderate: 2400, active: 2800 },
    { age: '51–60', sedentary: 2200, moderate: 2400, active: 2600 },
    { age: '61–70', sedentary: 2000, moderate: 2200, active: 2600 },
    { age: '71+', sedentary: 2000, moderate: 2200, active: 2400 },
  ],
  female: [
    { age: '19–20', sedentary: 2000, moderate: 2200, active: 2400 },
    { age: '21–25', sedentary: 2000, moderate: 2200, active: 2400 },
    { age: '26–30', sedentary: 1800, moderate: 2000, active: 2400 },
    { age: '31–35', sedentary: 1800, moderate: 2000, active: 2200 },
    { age: '36–40', sedentary: 1800, moderate: 2000, active: 2200 },
    { age: '41–45', sedentary: 1800, moderate: 2000, active: 2200 },
    { age: '46–50', sedentary: 1800, moderate: 2000, active: 2200 },
    { age: '51–60', sedentary: 1600, moderate: 1800, active: 2200 },
    { age: '61–70', sedentary: 1600, moderate: 1800, active: 2000 },
    { age: '71+', sedentary: 1600, moderate: 1800, active: 2000 },
  ],
};

/** Estimated calorie rows for a patient's sex (defaults to female when unknown —
 *  the more conservative figures). */
export function caloriesForSex(sex: string | null): CalorieRow[] {
  return /^m/i.test((sex ?? '').trim()) ? CALORIES.male : CALORIES.female;
}

/** The calorie age band that contains `age` (for row highlighting). */
export function calorieBandForAge(age: number | null): string | null {
  if (age == null) return null;
  const bands = CALORIES.male.map((r) => r.age);
  for (const b of bands) {
    if (b.endsWith('+')) {
      if (age >= parseInt(b, 10)) return b;
    } else {
      const [lo, hi] = b.split('–').map((n) => parseInt(n, 10));
      if (age >= lo && age <= hi) return b;
    }
  }
  return age < 19 ? bands[0] : bands[bands.length - 1];
}

export interface Screening {
  area: string;
  test: string;
  /** 'all' | 'women' | 'men' */
  sex: string;
  bands: Record<string, string>;
}

export const SCREENINGS: Screening[] = [
  { area: 'Blood pressure', test: 'Blood pressure measurement', sex: 'all', bands: { '18-39': 'Every 3–5 years if normal', '40-49': 'At least once a year', '50-64': 'At least once a year', '65+': 'At least once a year' } },
  { area: 'Cholesterol / lipids', test: 'Lipid panel', sex: 'all', bands: { '18-39': 'Every 4–6 years, sooner if at risk', '40-49': 'Every 4–6 years with a risk review', '50-64': 'Every 4–6 years with a risk review', '65+': 'Periodically, as your doctor advises' } },
  { area: 'Type 2 diabetes', test: 'Fasting glucose or HbA1c', sex: 'all', bands: { '18-39': 'If overweight with risk factors', '40-49': 'Every 3 years (from age 35)', '50-64': 'Every 3 years', '65+': 'As your doctor advises' } },
  { area: 'Colorectal cancer', test: 'Colonoscopy / stool test', sex: 'all', bands: { '18-39': 'Only if higher risk', '40-49': 'Begin at age 45', '50-64': 'Colonoscopy every 10 years, or a yearly stool test', '65+': 'Continue through age 75' } },
  { area: 'Cervical cancer', test: 'Pap / HPV test', sex: 'women', bands: { '18-39': 'Pap every 3 yrs (21–29); HPV every 5 yrs (30+)', '40-49': 'HPV or co-test every 5 years', '50-64': 'HPV or co-test every 5 years', '65+': 'May stop if prior screening was normal' } },
  { area: 'Breast cancer', test: 'Mammogram', sex: 'women', bands: { '18-39': 'Only if higher risk', '40-49': 'Every 2 years from age 40', '50-64': 'Every 2 years', '65+': 'Every 2 years through age 74' } },
  { area: 'Prostate health', test: 'PSA discussion', sex: 'men', bands: { '18-39': 'Not recommended', '40-49': 'Only discuss if higher risk', '50-64': 'Shared decision at ages 55–69', '65+': 'Discuss through 69; not routine at 70+' } },
  { area: 'Bone density', test: 'DEXA scan', sex: 'all', bands: { '18-39': 'Not routine', '40-49': 'Not routine', '50-64': 'Women past menopause with risk factors', '65+': 'All women 65+; men 70+' } },
  { area: 'Eye exam', test: 'Comprehensive eye check', sex: 'all', bands: { '18-39': 'Every 2–3 years', '40-49': 'Every 2–4 years', '50-64': 'Every 1–3 years', '65+': 'Every 1–2 years' } },
  { area: 'Dental', test: 'Check-up & cleaning', sex: 'all', bands: { '18-39': 'Every 6–12 months', '40-49': 'Every 6–12 months', '50-64': 'Every 6–12 months', '65+': 'Every 6–12 months' } },
  { area: 'Vaccinations', test: 'Routine adult vaccines', sex: 'all', bands: { '18-39': 'Flu yearly; tetanus every 10 yrs', '40-49': 'Flu yearly; tetanus every 10 yrs', '50-64': 'Flu yearly; tetanus every 10 yrs; shingles at 50+', '65+': 'Flu, tetanus, pneumococcal, shingles, RSV' } },
];

/** Age band key used by the screenings table. */
export function screeningBand(age: number | null): '18-39' | '40-49' | '50-64' | '65+' {
  if (age == null) return '18-39';
  if (age <= 39) return '18-39';
  if (age <= 49) return '40-49';
  if (age <= 64) return '50-64';
  return '65+';
}

/** Screenings relevant to a patient's sex, with the recommendation for their
 *  age band resolved. */
export function screeningsFor(
  age: number | null,
  sex: string | null,
): { area: string; test: string; recommendation: string }[] {
  const band = screeningBand(age);
  const isMale = /^m/i.test((sex ?? '').trim());
  const isFemale = /^f/i.test((sex ?? '').trim());
  return SCREENINGS.filter((s) => {
    if (s.sex === 'all') return true;
    if (s.sex === 'women') return isFemale || (!isMale && !isFemale);
    if (s.sex === 'men') return isMale || (!isMale && !isFemale);
    return true;
  }).map((s) => ({ area: s.area, test: s.test, recommendation: s.bands[band] }));
}

/** The four lifestyle pillars shown at the top of "Your Wellness". */
export const WELLNESS_PILLARS: { title: string; note: string }[] = [
  { title: 'Good nutrition', note: 'Plenty of vegetables, fruit, whole grains and healthy fats; less sugar, salt and fried food.' },
  { title: 'Regular activity', note: 'Aim for about 30 minutes of movement most days — a brisk walk counts.' },
  { title: 'Stress & sleep', note: 'Wind down, keep a steady sleep routine, and make time for things you enjoy.' },
  { title: 'Healthy weight', note: 'A steady, healthy weight eases the load on your heart, joints and blood sugar.' },
];

/** Short, evergreen everyday tips. */
export const WELLNESS_TIPS: { title: string; body: string }[] = [
  { title: 'Eat well', body: 'Fill half your plate with vegetables and fruit, choose whole grains, and watch portion sizes. Keep processed and sugary foods occasional rather than everyday.' },
  { title: 'Move more', body: 'Most days, aim for around 30 minutes of activity you enjoy — walking, cycling, swimming or dancing. Short bursts through the day add up too.' },
  { title: 'Manage stress', body: 'A few slow breaths, a short walk, or time with people you like all help. Notice what winds you up and plan small ways to ease it.' },
  { title: 'Sleep & hydrate', body: 'Aim for 7–9 hours of sleep on a steady schedule, and drink water through the day. Good rest and hydration support almost every result in this report.' },
];
