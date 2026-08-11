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
  if (!fixed) return null;

  const cased = matchCase(word, fixed);
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
