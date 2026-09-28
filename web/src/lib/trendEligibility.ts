/**
 * Which parameters earn a trend.
 *
 * A history is worth printing only where the number is FOLLOWED over time —
 * where guidelines set a target and the next visit asks "is it moving the
 * right way": HbA1c every three months, lipids under a statin, TSH while a
 * thyroxine dose is settled, creatinine and eGFR for kidney function, ALT on
 * a hepatotoxic drug, haemoglobin and ferritin through an anaemia course,
 * Vitamin D and B12 under repletion, uric acid under treatment, PSA velocity,
 * CRP and ESR through an inflammatory illness. These are the analytes
 * laboratories run delta checks on for the same reason: their change carries
 * meaning (Hong 2020; Randell & Yenice 2019 on delta checks; ADA, KDIGO and
 * ATA follow-up intervals).
 *
 * A history is noise, or worse, where the result does not move or was never
 * meant to be compared: a lifelong IgG, a blood group, a genetic marker, a
 * qualitative screen, a culture, a smear description, a cycle-dependent
 * hormone such as LH, FSH or oestradiol, and the ratios and calculated
 * lines that only restate a primary value. Those get no strip.
 *
 * Matched on the LIS's own test name (and code where a name is ambiguous),
 * so no catalogue is touched. Deny first, then allow; anything unlisted is
 * left alone.
 */

/* Names that would trip a deny rule below but are followed in practice: the
   urine albumin (microalbumin) line the LIS writes with a slash. */
const ALWAYS: RegExp[] = [/microalb/i];

const DENY: RegExp[] = [
  /\bratio\b|(?<!\([^)]*)\/(?!\s*(?:dl|l|ml|min))/i,       // ratios and "A/B" lines — a slash inside parentheses is an alias, not a ratio
  /calculat|derived|estimated average glucose|\beag\b/i,   // restated values
  /\bigg\b|\bigm\b|\biga\b|antibod|\bab\b|titre|titer/i,   // serology, lifelong or qualitative
  /blood group|\brh\b|genotyp|mutation|\bhla\b|karyotyp|\bpcr\b|\bdna\b|\brna\b/i,
  /culture|sensitivity|sensitive to|organism|smear|impression|series|hemoparasite|haemoparasite/i,
  /colou?r|appearance|reaction|specific gravity|transparen|volume|odour|odor/i,
  /\bfsh\b|\blh\b|luteini|follicle|oestradiol|estradiol|progesterone|mullerian|\bamh\b|\bhcg\b|beta hcg/i,
  /torch|toxoplasma|rubella|\bcmv\b|cytomegalo|herpes|\bhsv\b|\bhbsag\b|\bhcv\b|\bhiv\b|vdrl|widal|typhi|dengue|malaria/i,
  /\bana\b|anti ?nuclear|anti ?ccp|citrullinated|rheumatoid|\bra factor\b|\brf\b/i,
  /differential|\bcount %|%$/i,                             // differential percentages; the absolutes qualify below
  /\bmcv\b|\bmch\b|\bmchc\b|\brdw\b|\bmpv\b|\bpdw\b/i,      // red-cell indices: read with the counts, not followed alone
];

const ALLOW: RegExp[] = [
  /glycated|glycosylated|hba1c|hb a1c/i,
  /glucose|blood sugar/i,
  /cholesterol|triglycerid|\bhdl\b|\bldl\b|\bvldl\b/i,
  /\btsh\b|thyroid stimulating|\bt3\b|\bt4\b|thyroxine|iodothyronine/i,
  /creatinine|\begfr\b|glomerular|\burea\b|\bbun\b|urea nitrogen|uric acid/i,
  /microalb|albumin.*urine|urine.*albumin|\bacr\b|\buacr\b|protein.*urine|urine.*protein/i,
  /\bsodium\b|potassium|chloride|bicarbonate|calcium|phosph|magnesium/i,
  /\balt\b|\bsgpt\b|\bast\b|\bsgot\b|alkaline phosphatase|\balp\b|\bggt\b|gamma glutamyl|bilirubin|total protein|protein total|\balbumin\b|globulin/i,
  /h(a)?emoglobin|h(a)?ematocrit|\bpcv\b|rbc count|red blood cell|total leu[ck]ocyte|\btlc\b|\bwbc\b|white blood cell|platelet count|absolute (neutrophil|lymphocyte|eosinophil|monocyte)/i,
  /\besr\b|sedimentation|c[- ]?reactive|\bcrp\b|hs[- ]?crp/i,
  /ferritin|\biron\b|\btibc\b|iron binding|transferrin sat/i,
  /vitamin d|25[- ]?oh|vitamin b12|cobalamin|folate|folic acid/i,
  /\bpsa\b|prostate specific/i,
  /testosterone|prolactin|\bpth\b|parathyroid/i,
  /\binr\b|prothrombin|\bpt\b/i,
  /\bcea\b|ca[- ]?125|ca[- ]?19|ca[- ]?15|\bafp\b|alpha[- ]?feto|viral load/i,
  /\bck\b|creatine kinase|\bldh\b|lactate dehydrogenase|amylase|lipase|troponin|\bnt[- ]?probnp\b|\bbnp\b/i,
];

const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

/** Whether this parameter's history is worth printing. */
export function trendWorthy(name: string | null | undefined, code?: string | null): boolean {
  const n = norm(name);
  if (!n) return false;
  const hay = `${n} ${norm(code)}`;
  if (ALWAYS.some((re) => re.test(n))) return true;
  if (DENY.some((re) => re.test(hay))) return false;
  return ALLOW.some((re) => re.test(n));
}
