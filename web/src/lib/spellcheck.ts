/**
 * Autocorrect for the worksheet's free-text fields, in British/Indian English.
 *
 * ── THIS IS A CORRECTION LIST, NOT A SPELL CHECKER ────────────────────────
 * The obvious build is a dictionary of correct words plus edit distance:
 * anything not in the dictionary is wrong, and the nearest word wins. In a
 * laboratory that is actively dangerous. A bench comment says things like
 * "Klebsiella", "hyphae", "Trichomonas", "poikilocytosis", "eGFR", "AFB",
 * "MacConkey" — none of which are in a general dictionary, all of which have a
 * plausible-looking near neighbour, and each of which would be silently
 * rewritten into a different clinical claim.
 *
 * So this goes the other way. It only ever fires on a string that appears in
 * the tables below: a known misspelling with a known intended word. A term it
 * has never heard of is left exactly as typed, which is the correct behaviour
 * for every organism, abbreviation and stain name in the building. The cost is
 * recall — it will miss misspellings nobody listed — and that is the right side
 * to fail on when the alternative is editing a result.
 *
 * ── WHAT IS DELIBERATELY ABSENT ───────────────────────────────────────────
 * No homophone or confusable pair: practice/practise, affect/effect,
 * discreet/discrete, mucus/mucous. Every one of those is a real word whose
 * correct form depends on the sentence, and a machine that picks for you gets
 * it wrong in exactly the cases that matter. Every entry in MISSPELLINGS is a
 * string that is not an English word at all, so correcting it cannot change a
 * meaning that was intended.
 */

/**
 * Misspelling → intended word. Keys are lower-case and must NOT be valid
 * English words; that invariant is what makes the correction safe.
 *
 * Two groups: ordinary prose errors a typist makes anywhere, and the lab
 * vocabulary that actually appears in bench comments.
 */
const MISSPELLINGS: Record<string, string> = {
  // ---- ordinary prose ----
  abscence: 'absence', accomodate: 'accommodate', acheived: 'achieved',
  acknowlege: 'acknowledge', aparent: 'apparent', apparant: 'apparent',
  approxmately: 'approximately', aproximately: 'approximately',
  arguement: 'argument', assesment: 'assessment', avaliable: 'available',
  becuase: 'because', begining: 'beginning', beleive: 'believe',
  calender: 'calendar', catagory: 'category', comittee: 'committee',
  commited: 'committed', comparision: 'comparison', completly: 'completely',
  concious: 'conscious', concieve: 'conceive', consistant: 'consistent',
  definately: 'definitely', decribed: 'described', dependant: 'dependent',
  descripton: 'description', diferent: 'different', diffrent: 'different',
  dissapear: 'disappear', dissapoint: 'disappoint', embarass: 'embarrass',
  enviroment: 'environment', equipement: 'equipment', excelent: 'excellent',
  existance: 'existence', experiance: 'experience', explaination: 'explanation',
  familar: 'familiar', finaly: 'finally', foriegn: 'foreign',
  fourty: 'forty', freind: 'friend', futher: 'further',
  goverment: 'government', gaurd: 'guard', happend: 'happened',
  imediately: 'immediately', immediatly: 'immediately', incidently: 'incidentally',
  independant: 'independent', indispensible: 'indispensable', interupted: 'interrupted',
  irrelevent: 'irrelevant', knowlege: 'knowledge', liesure: 'leisure',
  maintainance: 'maintenance', maintenence: 'maintenance', managable: 'manageable',
  neccessary: 'necessary', necesary: 'necessary', noticable: 'noticeable',
  occassion: 'occasion', occured: 'occurred', occuring: 'occurring',
  occurance: 'occurrence', ocurred: 'occurred', paralel: 'parallel',
  particulary: 'particularly', peice: 'piece', perfrom: 'perform',
  posible: 'possible', posession: 'possession', prefered: 'preferred',
  presance: 'presence', priviledge: 'privilege', probaly: 'probably',
  proffesional: 'professional', pronounciation: 'pronunciation', publically: 'publicly',
  recieve: 'receive', recieved: 'received', reciept: 'receipt',
  recomend: 'recommend', recomended: 'recommended', refered: 'referred',
  refering: 'referring', relevent: 'relevant', repitition: 'repetition',
  reccomend: 'recommend', rythm: 'rhythm', seperate: 'separate',
  seperated: 'separated', seperately: 'separately', sieze: 'seize',
  similiar: 'similar', succesful: 'successful', successfull: 'successful',
  supress: 'suppress', supressed: 'suppressed', surprize: 'surprise',
  temperture: 'temperature', tendancy: 'tendency', therefor: 'therefore',
  threshhold: 'threshold', tommorow: 'tomorrow', tommorrow: 'tomorrow',
  truely: 'truly', unfortunatly: 'unfortunately', untill: 'until',
  usualy: 'usually', wierd: 'weird', wich: 'which', writen: 'written',
  yeild: 'yield', teh: 'the', adn: 'and', taht: 'that', woth: 'with',
  hte: 'the', nad: 'and', ot: 'to', si: 'is',

  // ---- the bench vocabulary ----
  // Every one of these is a non-word; the intended term is unambiguous.
  aglutination: 'agglutination', agglutinaton: 'agglutination',
  anisocitosis: 'anisocytosis',
  bacterialogical: 'bacteriological',
  basophill: 'basophil', basophills: 'basophils',
  bilrubin: 'bilirubin', bilirubine: 'bilirubin',
  colonys: 'colonies', contamintaed: 'contaminated', contamiated: 'contaminated',
  cristals: 'crystals', crystalls: 'crystals', crystall: 'crystal',
  culutre: 'culture', cultrue: 'culture',
  cyctes: 'cysts', cystes: 'cysts',
  eosinophill: 'eosinophil', eosinophills: 'eosinophils', esinophils: 'eosinophils',
  epithilial: 'epithelial', epithelal: 'epithelial', epitheial: 'epithelial',
  erythrocyt: 'erythrocyte', erythrocytse: 'erythrocytes',
  flourescent: 'fluorescent', flourescence: 'fluorescence',
  granulcytes: 'granulocytes', haemogloblin: 'haemoglobin', haemglobin: 'haemoglobin',
  hemogloblin: 'haemoglobin', hyphea: 'hyphae', hypae: 'hyphae',
  inclusiuons: 'inclusions', leucocyt: 'leucocyte',
  lymphocite: 'lymphocyte', lymphocites: 'lymphocytes', lympocytes: 'lymphocytes',
  macrocitic: 'macrocytic', microcitic: 'microcytic',
  metabolights: 'metabolites', microscopc: 'microscopic', micrscopic: 'microscopic',
  moderatly: 'moderately', monocyt: 'monocyte', monocytse: 'monocytes',
  motil: 'motile',
  neutrophill: 'neutrophil', neutrophills: 'neutrophils', nuetrophils: 'neutrophils',
  occassional: 'occasional',
  organsim: 'organism', organsims: 'organisms', orgamism: 'organism',
  parasyte: 'parasite', parasytes: 'parasites',
  pathogenc: 'pathogenic', platlets: 'platelets', platlet: 'platelet',
  pyocytes: 'pus cells',
  reticulocyt: 'reticulocyte', sensitivty: 'sensitivity', sensitivety: 'sensitivity',
  specimin: 'specimen', specemin: 'specimen', speciman: 'specimen',
  sterril: 'sterile', sterlie: 'sterile',
  suspention: 'suspension', trophozoit: 'trophozoite',
  urobilinogin: 'urobilinogen', vacuolatd: 'vacuolated',
};

/**
 * American → British/Indian spelling.
 *
 * Separate from MISSPELLINGS because these ARE valid words — just not the
 * convention a Noble report is written in. Kept to the lab vocabulary where
 * Indian usage is settled and one-sided; forms that both conventions genuinely
 * use are absent on purpose. `leukocyte` is not here for exactly that reason,
 * and neither is `gray`.
 */
const US_TO_UK: Record<string, string> = {
  anemia: 'anaemia', anemic: 'anaemic',
  hemoglobin: 'haemoglobin', hemolysis: 'haemolysis', hemolytic: 'haemolytic',
  hematology: 'haematology', hematuria: 'haematuria', hematoma: 'haematoma',
  hemorrhage: 'haemorrhage', hemorrhagic: 'haemorrhagic',
  hemostasis: 'haemostasis', hematocrit: 'haematocrit',
  edema: 'oedema', edematous: 'oedematous',
  diarrhea: 'diarrhoea', gonorrhea: 'gonorrhoea', leukorrhea: 'leucorrhoea',
  esophagus: 'oesophagus', esophageal: 'oesophageal',
  fetus: 'foetus', fetal: 'foetal',
  color: 'colour', colored: 'coloured', colorless: 'colourless',
  center: 'centre', centers: 'centres',
  liter: 'litre', liters: 'litres', milliliter: 'millilitre',
  fiber: 'fibre', fibers: 'fibres',
  labeled: 'labelled', labeling: 'labelling',
  analyze: 'analyse', analyzed: 'analysed', analyzer: 'analyser',
  sterilization: 'sterilisation', sterilized: 'sterilised',
  pediatric: 'paediatric', anesthesia: 'anaesthesia',
  celiac: 'coeliac', leukemia: 'leukaemia',
};

/** Ends a word. Everything else is treated as part of one. */
const BOUNDARY = /[\s.,;:!?)\]}"'/\\]/;

export interface Correction {
  /** The text as typed. */
  from: string;
  /** What it became. */
  to: string;
  /** Index in the field where the replaced word started. */
  start: number;
}

export interface CorrectionResult {
  text: string;
  caret: number;
  correction: Correction;
}

/**
 * Match the replacement to the shape of what was typed.
 *
 * ALL-CAPS is refused rather than handled: in this application a run of capitals
 * is far more likely to be a test code, an abbreviation or an organism's short
 * form than a shouted English word, and those are precisely what must not be
 * touched.
 */
function matchCase(typed: string, replacement: string): string | null {
  if (typed.length > 1 && typed === typed.toUpperCase()) return null;
  if (typed[0] === typed[0].toUpperCase()) {
    return replacement[0].toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

/* ── THE DICTIONARY LAYER ────────────────────────────────────────────────────
 * The tables above encode INTENT and fire instantly; everything they miss —
 * "recived", "blader", the browser's whole red-squiggle set — falls through to
 * a real Hunspell en-GB dictionary, loaded lazily so the main bundle stays
 * lean (the .dic is half a megabyte before gzip).
 *
 * The original fear about dictionaries stands — "Klebsiella" must never become
 * something else — so the layer is fenced three ways:
 *
 *   1. MEDICAL below is both a shield and a magnet: a word in it is never
 *      treated as a misspelling, and when a typo sits at equal distance from a
 *      medical word and an everyday one, the medical word wins — "blader" is a
 *      bladder, not a blade, in this building.
 *   2. Only close corrections fire: edit distance 1, or 2 for words of eight
 *      letters and up. A rare organism or drug name has no close neighbour and
 *      is left alone (the browser's red underline still marks it for a human).
 *   3. The existing guards hold: digits, compounds, ALL-CAPS and short words
 *      are never touched, and the case of what was typed is preserved.
 */
const MEDICAL = new Set([
  // anatomy & specimens
  'bladder', 'gall', 'gallbladder', 'kidney', 'ureter', 'urethra', 'prostate',
  'cervix', 'uterus', 'ovary', 'testis', 'thyroid', 'liver', 'spleen',
  'pancreas', 'appendix', 'colon', 'rectum', 'oesophagus', 'stomach',
  'duodenum', 'ileum', 'jejunum', 'larynx', 'pharynx', 'trachea', 'bronchus',
  'pleura', 'peritoneum', 'omentum', 'lymph', 'node', 'marrow', 'serum',
  'plasma', 'sputum', 'urine', 'stool', 'biopsy', 'aspirate', 'swab',
  'tissue', 'lesion', 'polyp', 'cyst', 'nodule', 'ulcer', 'mucosa',
  'stroma', 'septum', 'follicle', 'papilla', 'villi', 'crypt',
  // cells & haematology
  'erythrocyte', 'erythrocytes', 'leucocyte', 'leucocytes', 'leukocyte',
  'leukocytes', 'lymphocyte', 'lymphocytes', 'monocyte', 'monocytes',
  'neutrophil', 'neutrophils', 'eosinophil', 'eosinophils', 'basophil',
  'basophils', 'platelet', 'platelets', 'reticulocyte', 'reticulocytes',
  'blast', 'blasts', 'myelocyte', 'metamyelocyte', 'normoblast',
  'poikilocytosis', 'anisocytosis', 'rouleaux', 'haemolysis', 'haemolysed',
  'hypochromia', 'microcytic', 'macrocytic', 'normocytic', 'normochromic',
  // micro & path
  'klebsiella', 'pseudomonas', 'staphylococcus', 'streptococcus',
  'escherichia', 'coli', 'enterococcus', 'proteus', 'salmonella', 'shigella',
  'candida', 'aspergillus', 'trichomonas', 'giardia', 'entamoeba',
  'plasmodium', 'mycobacterium', 'acinetobacter', 'citrobacter',
  'enterobacter', 'serratia', 'morganella', 'gardnerella', 'neisseria',
  'haemophilus', 'brucella', 'leptospira', 'rickettsia', 'chlamydia',
  'mycoplasma', 'gonococcus', 'meningococcus', 'pneumococcus',
  'hyphae', 'spores', 'mycelium', 'trophozoite', 'trophozoites',
  'gametocyte', 'gametocytes', 'schizont', 'ova', 'cysts', 'flagellate',
  'bacilli', 'cocci', 'diplococci', 'spirochaete', 'agglutination',
  'inoculated', 'subculture', 'sensitivity', 'resistant', 'intermediate',
  'colonies', 'colony', 'haemolytic', 'lactose', 'fermenter', 'motile',
  'oxidase', 'catalase', 'coagulase', 'urease', 'indole',
  // chemistry & tests
  'bilirubin', 'creatinine', 'urea', 'uric', 'glucose', 'cholesterol',
  'triglycerides', 'haemoglobin', 'glycated', 'albumin', 'globulin',
  'fibrinogen', 'prothrombin', 'thromboplastin', 'amylase', 'lipase',
  'phosphatase', 'transaminase', 'aminotransferase', 'dehydrogenase',
  'ferritin', 'transferrin', 'folate', 'cortisol', 'prolactin',
  'testosterone', 'oestrogen', 'progesterone', 'thyroxine', 'calcium',
  'phosphorus', 'magnesium', 'sodium', 'potassium', 'chloride',
  'bicarbonate', 'lactate', 'ammonia', 'osmolality', 'electrophoresis',
  'immunoassay', 'chemiluminescence', 'nephelometry', 'turbidimetry',
  'urobilinogen', 'ketones', 'nitrites', 'leucocyturia', 'proteinuria',
  'haematuria', 'glycosuria', 'microalbumin',
  // common report words
  'reactive', 'nonreactive', 'positive', 'negative', 'equivocal',
  'malignancy', 'metastasis', 'metastatic', 'carcinoma', 'adenoma',
  'sarcoma', 'lymphoma', 'leukaemia', 'dysplasia', 'hyperplasia',
  'metaplasia', 'atypia', 'atypical', 'benign', 'malignant', 'infiltrate',
  'infiltration', 'inflammation', 'inflammatory', 'granuloma',
  'granulomatous', 'necrosis', 'necrotic', 'fibrosis', 'oedema',
  'congestion', 'haemorrhage', 'received', 'specimen', 'sections',
  'histopathology', 'cytology', 'impression', 'microscopy', 'gross',
]);

/**
 * Everyday words a lab actually types, preferred over an obscure dictionary
 * neighbour at the same distance — "paitent" is a patient, not a patent, and
 * "wieght" is a weight, not a wight. Second tier after MEDICAL.
 */
const COMMON = new Set([
  'patient', 'patients', 'sample', 'samples', 'report', 'reports', 'result',
  'results', 'weight', 'height', 'blood', 'pressure', 'advised', 'advise',
  'suggested', 'suggest', 'repeat', 'repeated', 'review', 'reviewed',
  'clinical', 'correlation', 'correlate', 'history', 'present', 'presence',
  'absent', 'absence', 'normal', 'abnormal', 'within', 'limits', 'range',
  'value', 'values', 'increased', 'decreased', 'raised', 'reduced', 'mild',
  'moderate', 'severe', 'trace', 'occasional', 'numerous', 'plenty', 'few',
  'seen', 'noted', 'observed', 'examination', 'examined', 'collection',
  'collected', 'processed', 'reported', 'requested', 'required', 'kindly',
  'please', 'doctor', 'centre', 'laboratory', 'morning', 'fasting', 'random',
]);

type Dict = { correct(word: string): boolean; suggest(word: string): string[] };
let dict: Dict | null = null;

// Kicked off at module load, awaited by nobody: until the half-megabyte
// dictionary chunk lands, the tables above carry corrections alone, which is
// exactly what they did before this layer existed.
void (async () => {
  try {
    // Vendored into assets: the dictionary package's exports map does not
    // expose its raw files to the bundler. Its licence rides alongside.
    const [{ default: nspell }, aff, dic] = await Promise.all([
      import('nspell'),
      import('../assets/en-gb.aff?raw'),
      import('../assets/en-gb.dic?raw'),
    ]);
    dict = nspell(aff.default, dic.default);
  } catch {
    /* No dictionary is a quieter portal, not a broken one. */
  }
})();

/**
 * Damerau–Levenshtein (adjacent transpositions cost 1), capped: distances
 * past `max` all read as max+1. Transposition matters here — "wieght" is one
 * slip from "weight", not two, and counting it as two let "wight" win.
 */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev2: number[] | null = null;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      if (prev2 && i > 1 && j > 1
          && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        cur[j] = Math.min(cur[j], prev2[j - 2] + 1);
      }
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return max + 1;
    prev2 = prev;
    prev = cur;
  }
  return prev[b.length];
}

/** A correction from the dictionary, under the fences described above. */
function dictionaryCorrection(word: string): string | null {
  if (!dict) return null;
  // Short strings are where abbreviations and codes live; leave them to the
  // curated table, which knows the ones worth fixing ("teh", "adn").
  if (word.length < 4) return null;

  const lower = word.toLowerCase();
  if (MEDICAL.has(lower) || COMMON.has(lower)) return null;
  if (dict.correct(word) || dict.correct(lower)) return null;

  const typedLower = word[0] === word[0].toLowerCase();
  const maxD = lower.length >= 8 ? 2 : 1;
  const ranked: { s: string; d: number }[] = [];
  for (const raw of dict.suggest(word)) {
    let s = raw;
    // A lowercase typo must not become a proper noun — "sampel" is a sample,
    // never a Samuel. A capitalised suggestion for lowercase input survives
    // only if its lowercase form is a word in its own right.
    if (typedLower && s[0] !== s[0].toLowerCase()) {
      const low = s.toLowerCase();
      if (!dict.correct(low) && !MEDICAL.has(low) && !COMMON.has(low)) continue;
      s = low;
    }
    const d = editDistance(lower, s.toLowerCase(), maxD);
    if (d <= maxD) ranked.push({ s, d });
  }
  if (ranked.length === 0) return null;

  const minD = Math.min(...ranked.map((c) => c.d));
  const atMin = ranked.filter((c) => c.d === minD);
  // Tie-breaks, in order: the lab's own vocabulary; then a candidate made of
  // the SAME letters as the typo — a transposition is the commonest slip, so
  // "thier" is their (same letters), not thief; then the everyday-word tier;
  // then Hunspell's own ranking.
  const letters = [...lower].sort().join('');
  const pick =
    atMin.find((c) => MEDICAL.has(c.s.toLowerCase()))?.s
    ?? atMin.find((c) => [...c.s.toLowerCase()].sort().join('') === letters)?.s
    ?? atMin.find((c) => COMMON.has(c.s.toLowerCase()))?.s
    ?? atMin[0].s;

  return matchCase(word, pick);
}

/** The intended spelling of `word`, or null to leave it alone. */
export function correctionFor(word: string): string | null {
  // Too short to be worth it, and short strings are where abbreviations live.
  if (word.length < 2) return null;
  // Anything carrying a digit is a value, a code or a unit — never prose.
  if (/\d/.test(word)) return null;
  // Hyphens and slashes mark compounds and ratios ("gram-negative", "A/G"),
  // which are not in the tables and must not be split apart to look.
  if (/[^A-Za-z]/.test(word)) return null;

  const lower = word.toLowerCase();
  const fixed = MISSPELLINGS[lower] ?? US_TO_UK[lower];
  const cased = fixed ? matchCase(word, fixed) : dictionaryCorrection(word);
  // A correction that changes nothing is not a correction.
  return cased && cased !== word ? cased : null;
}

/**
 * Correct the word that has just been completed, if it needs it.
 *
 * Fires only when the character before the caret ENDS a word, so nothing is
 * rewritten while it is still being typed — "recie" is not yet a mistake, and a
 * field that argues with you mid-word is unusable. Pass `atEnd` to check the
 * final word too, which is what blur does.
 *
 * Returns null when there is nothing to change.
 */
export function correctAt(text: string, caret: number, atEnd = false): CorrectionResult | null {
  let end: number;

  if (atEnd) {
    end = caret;
  } else {
    if (caret < 1) return null;
    if (!BOUNDARY.test(text[caret - 1])) return null;
    end = caret - 1;
  }

  /*
   * Skip back over any further boundary characters before looking for the word.
   *
   * Without this, only the FIRST punctuation mark after a word could trigger a
   * correction: typing "occured, " ends with a space, and the character before
   * that space is the comma, so the search for a word started and finished on
   * punctuation and found nothing. Every misspelling followed by a comma, a
   * bracket or a quote and then a space went uncorrected.
   */
  while (end > 0 && BOUNDARY.test(text[end - 1])) end--;

  // Walk back over the word itself.
  let start = end;
  while (start > 0 && !BOUNDARY.test(text[start - 1])) start--;
  if (start === end) return null;

  const word = text.slice(start, end);
  const fixed = correctionFor(word);
  if (!fixed) return null;

  return {
    text: text.slice(0, start) + fixed + text.slice(end),
    // The caret keeps its position relative to the end of the text, which is
    // where it was: the user is typing forwards, not editing this word.
    caret: caret + (fixed.length - word.length),
    correction: { from: word, to: fixed, start },
  };
}
