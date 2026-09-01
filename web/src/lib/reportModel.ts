/**
 * The report's shape, rebuilt from the flat result rows.
 *
 * The LIS does not store a report; it stores a list of rows, and the report is
 * the shape those rows are printed in. Telo reconstructs that shape in
 * `db/read/sampleReport.ts` before rendering, and this is a port of that walk —
 * because the two products print the SAME document, and a report that groups
 * its tests differently is a different document even when every number on it
 * agrees.
 *
 *   Department (CLINICAL BIOCHEMISTRY)
 *     ├─ Panel                  testtype='Profile' — LIVER FUNCTION TEST, and
 *     │    every row sharing its profile_id:
 *     │      ├─ Group           testtype='Head' + its 'Param' rows  (BILIRUBIN)
 *     │      └─ Single          testtype='Test'                     (AST, ALT)
 *     ├─ Group                  a standalone Head with no profile
 *     └─ Single                 a standalone Test
 *
 * The panel's children are what the per-test tick boxes operate on; unticking
 * the panel cascades to all of them.
 *
 * Row order IS report order: the LIS writes each heading immediately before the
 * analytes it introduces (see the note in ReportsRepository.ParseResults, which
 * restores that order before this ever sees the rows). profile_id is the real
 * parent link and is used where present.
 */
import type { TestResult } from '../pages/ReportViewer';

export interface ReportRow {
  /** Uppercased test code — the key static notes are looked up on. */
  code: string | null;
  name: string | null;
  method: string | null;
  value: string | null;
  unit: string | null;
  range: string | null;
  abnormal: boolean;
  comments: string | null;
  /** The result row's own id — the unit the tick boxes and ?exclude= use. */
  resultId: number;
  /** NABL medallion beside the name — set on a Delhi-processed sample's
   *  accredited standalone tests, never on Param analytes. */
  nabl: boolean;
  /**
   * The value EXACTLY as stored, markup included. `value` above is cleaned
   * for the tabular cells; a rich descriptive result (the Desc Report editor
   * writes real HTML) renders from this instead, sanitised — see
   * lib/richText and the rich branch in PrintReport's ResultRow.
   */
  valueRaw: string | null;
}

/**
 * A Culture & Sensitivity result, rebuilt from the LIS's fixed parameter
 * template (Gram stained smear / Organism Isolated / Colony count / Sensitive
 * to / Intermediate to / Resistant to / Remarks).
 *
 * The three "… to" parameters hold their antibiotic lists as newline-separated
 * text inside ONE value, which is split back into one entry per drug so the
 * antibiogram can be printed as a table rather than as a paragraph. A "no
 * growth" report stores the token "NOT APPLICABLE" in each field; it survives
 * as a one-element list and prints as-is.
 */
export interface CultureReport {
  /** "1st Interim Report" / "Final Report" — the 24h/48h/5-day reads, in LIS
   *  order, label kept verbatim. */
  narratives: { label: string; value: string }[];
  gramStain: string | null;
  organism: string | null;
  colonyCount: string | null;
  remarks: string | null;
  sensitive: string[];
  intermediate: string[];
  resistant: string[];
}

export interface ReportGroup {
  title: string | null;
  testId: number | null;
  /** The heading row's own id, so the group can be ticked as a unit. */
  resultId: number;
  method: string | null;
  interpretation: string | null;
  /** An interpretation held as a picture, inlined as a data URI. */
  interpretationImage: string | null;
  /** NABL medallion beside the heading, from the Head row's flag. */
  nabl: boolean;
  rows: ReportRow[];
  /** Set when this group is a Culture & Sensitivity result — the report then
   *  draws the antibiogram instead of `rows`. */
  culture?: CultureReport;
}

/** A leaf: a multi-parameter Head, or one standalone Test. */
export interface ReportBlock {
  kind: 'group' | 'single';
  group?: ReportGroup;
  row?: ReportRow;
  testId?: number | null;
  interpretation?: string | null;
  interpretationImage?: string | null;
}

export interface ReportPanel {
  /** tbl_med_test_profile_master.id — the key the profile's clinical
   *  significance is stored under in Telo's shared sidecar. */
  profileId: number | null;
  title: string | null;
  /** The Profile row's own id, for the panel's tick box. */
  resultId: number;
  children: ReportBlock[];
}

export interface ReportItem {
  kind: 'panel' | 'group' | 'single';
  panel?: ReportPanel;
  group?: ReportGroup;
  row?: ReportRow;
  testId?: number | null;
  interpretation?: string | null;
  interpretationImage?: string | null;
}

export interface ReportDepartment {
  name: string;
  items: ReportItem[];
}

export interface SampleReport {
  departments: ReportDepartment[];
  /** Distinct specimen types on the sample, first-seen order. */
  specimens: string[];
}

/* -------------------------------------------------------------- cleaning -- */

const clean = (s: string | null | undefined): string | null => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t || null;
};

/**
 * Like clean(), but KEEPS line breaks.
 *
 * Interpretation and reference-range text is stored with intentional paragraph
 * and per-band breaks; collapsing them turns a list of bands into a run-on
 * sentence. Runs of spaces inside a line still collapse, and a gap of three or
 * more blank lines becomes one.
 */
const cleanMultiline = (s: string | null | undefined): string | null => {
  const t = (s ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return t || null;
};

/** One entry per drug: the LIS packs the list into a single newline- and
 *  tab-separated value, some entries carrying a potency suffix like "(++)". */
const splitAbxList = (s: string | null | undefined): string[] =>
  (s ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((t) => t.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean);

const emptyCulture = (): CultureReport => ({
  narratives: [],
  gramStain: null,
  organism: null,
  colonyCount: null,
  remarks: null,
  sensitive: [],
  intermediate: [],
  resistant: [],
});

/** Route a Param row into the group's structured culture slot when it is part
 *  of the C&S template, creating the slot on first match. */
function applyCultureField(group: ReportGroup, t: TestResult): void {
  const key = (t.testName ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

  // Matched by pattern rather than by an exact list so any number of interim
  // reads is handled; kept in encounter order, label preserved.
  if (key.includes('interim') || key.includes('final report')) {
    const val = cleanMultiline(t.value);
    if (val) {
      (group.culture ??= emptyCulture()).narratives.push({
        label: (t.testName ?? '').replace(/\s+/g, ' ').trim(),
        value: val,
      });
    }
    return;
  }

  switch (key) {
    case 'gram stained smear':
    case 'gram stain':
      (group.culture ??= emptyCulture()).gramStain = clean(t.value);
      break;
    case 'organism isolated':
      (group.culture ??= emptyCulture()).organism = clean(t.value);
      break;
    case 'colony count':
      (group.culture ??= emptyCulture()).colonyCount = clean(t.value);
      break;
    case 'remarks':
      (group.culture ??= emptyCulture()).remarks = clean(t.value);
      break;
    case 'sensitive to':
      (group.culture ??= emptyCulture()).sensitive = splitAbxList(t.value);
      break;
    case 'intermediate to':
      (group.culture ??= emptyCulture()).intermediate = splitAbxList(t.value);
      break;
    case 'resistant to':
      (group.culture ??= emptyCulture()).resistant = splitAbxList(t.value);
      break;
    default:
      break;
  }
}

/** A group is really a C&S report only if it carries the antibiogram's
 *  signature. Guards against an ordinary multi-parameter test that merely has
 *  a "Remarks" parameter. */
const hasAntibiogram = (c: CultureReport): boolean =>
  c.organism != null ||
  c.narratives.length > 0 ||
  c.sensitive.length > 0 ||
  c.intermediate.length > 0 ||
  c.resistant.length > 0;

/** Drop the potency suffix and all whitespace so "Piperacillin /Tazobactam"
 *  and "Piperacillin/ Tazobactam(++)" collapse to one key. */
const abxKey = (s: string): string =>
  s.toLowerCase().replace(/\(\s*\++\s*\)/g, '').replace(/\s+/g, '');

/** A drug cannot be both sensitive and resistant. First occurrence in
 *  Sensitive → Intermediate → Resistant order wins; "NOT APPLICABLE"
 *  placeholders are left in every column. */
function dedupeAntibiogram(c: CultureReport): void {
  const seen = new Set<string>();
  const prune = (list: string[]): string[] =>
    list.filter((item) => {
      if (/^\s*not applicable\s*$/i.test(item)) return true;
      const key = abxKey(item);
      if (!key) return true;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  c.sensitive = prune(c.sensitive);
  c.intermediate = prune(c.intermediate);
  c.resistant = prune(c.resistant);
}

/* ------------------------------------------------------------------ walk -- */

export function buildSampleReport(results: readonly TestResult[]): SampleReport {
  const toRow = (t: TestResult): ReportRow => ({
    code: t.testCode ? t.testCode.trim().toUpperCase() : null,
    name: clean(t.testName),
    method: clean(t.method),
    value: clean(t.value),
    unit: clean(t.unit),
    // Bands keep their own lines; formatRange finishes the job at render time.
    range: cleanMultiline(t.normalRange),
    abnormal: t.abnormal === true,
    comments: clean(t.comments),
    resultId: t.resultId,
    nabl: t.nabl === true,
    valueRaw: t.value ?? null,
  });

  /*
   * Coded 'Head' rows per test.
   *
   * A multi-parameter test emits an untitled "report name" Head immediately
   * followed by the real coded Head its Param rows hang off. Where there is
   * exactly ONE coded Head (TB Gene Xpert) the two collapse into a single
   * group, so the title is not printed twice. Where there are SEVERAL (CBC →
   * Automated 5 Part Analyzer / Differential Counts % / Differential Counts
   * Absolute) each coded Head is a real sub-group and keeps its own name.
   */
  const codedHeadCount = new Map<number, number>();
  for (const t of results) {
    if ((t.testType ?? '').trim() === 'Head' && t.testId != null && t.testCode && t.testCode.trim()) {
      codedHeadCount.set(t.testId, (codedHeadCount.get(t.testId) ?? 0) + 1);
    }
  }

  const deptOrder: string[] = [];
  const deptItems = new Map<string, ReportItem[]>();
  const specimens = new Set<string>();
  const cultureGroups: ReportGroup[] = [];

  const pushItem = (dept: string, item: ReportItem) => {
    if (!deptItems.has(dept)) {
      deptItems.set(dept, []);
      deptOrder.push(dept);
    }
    deptItems.get(dept)!.push(item);
  };

  /** Merge a further interpretation into a group without repeating it. */
  const addInterp = (group: ReportGroup, interp: string | null) => {
    if (!interp) return;
    if (!group.interpretation) group.interpretation = interp;
    else if (!group.interpretation.includes(interp)) {
      group.interpretation = `${group.interpretation}\n\n${interp}`;
    }
  };

  // The open profile panel, and inside it (or at top level) the open Head
  // collecting its Param rows.
  let panel: { dept: string; pid: number; item: ReportItem } | null = null;
  let head: { tid: number | null; group: ReportGroup } | null = null;

  for (const t of results) {
    const dept = clean(t.departmentName) ?? 'OTHER';
    const type = (t.testType ?? '').trim();
    const spec = clean(t.specimen);
    if (spec) specimens.add(spec);

    // Membership in the open panel is a shared profile_id inside one department.
    const inPanel =
      panel != null && t.profileId != null && t.profileId === panel.pid && panel.dept === dept;

    if (type === 'Profile') {
      head = null;
      const item: ReportItem = {
        kind: 'panel',
        panel: {
          profileId: t.profileId ?? null,
          title: clean(t.testName),
          resultId: t.resultId,
          children: [],
        },
      };
      panel = { dept, pid: t.profileId ?? -1, item };
      pushItem(dept, item);
      continue;
    }

    if (type === 'Head') {
      // The untitled "report name" Head, collapsed into the coded one that
      // follows it — but only for a test with a single coded Head.
      if (
        head &&
        head.tid === t.testId &&
        t.testId != null &&
        head.group.rows.length === 0 &&
        (codedHeadCount.get(t.testId) ?? 0) <= 1
      ) {
        continue;
      }
      const group: ReportGroup = {
        // The row's OWN name. reportTestName is the PARENT test's name, shared
        // by every row under it, and using it here would clobber the
        // sub-group names on a CBC.
        title: clean(t.testName),
        testId: t.testId ?? null,
        resultId: t.resultId,
        method: clean(t.method),
        interpretation: cleanMultiline(t.interpretation),
        interpretationImage: t.interpretationImage ?? null,
        nabl: t.nabl === true,
        rows: [],
      };
      if (inPanel) {
        panel!.item.panel!.children.push({ kind: 'group', group });
      } else {
        panel = null;
        pushItem(dept, { kind: 'group', group });
      }
      head = { tid: t.testId ?? null, group };
      continue;
    }

    if (type === 'Param' && head) {
      head.group.rows.push(toRow(t));
      addInterp(head.group, cleanMultiline(t.interpretation));
      const hadCulture = head.group.culture != null;
      applyCultureField(head.group, t);
      if (!hadCulture && head.group.culture) cultureGroups.push(head.group);
      continue;
    }

    if (type === 'Test') {
      head = null;
      const block: ReportBlock = {
        kind: 'single',
        row: toRow(t),
        testId: t.testId ?? null,
        interpretation: cleanMultiline(t.interpretation),
        interpretationImage: t.interpretationImage ?? null,
      };
      if (inPanel) {
        panel!.item.panel!.children.push(block);
      } else {
        panel = null;
        pushItem(dept, {
          kind: 'single',
          row: block.row,
          testId: block.testId,
          interpretation: block.interpretation,
          interpretationImage: block.interpretationImage,
        });
      }
      continue;
    }

    // An orphan Param, or a type we have not seen. Printed as a standalone
    // rather than dropped — a value on the sheet beats a value nobody sees.
    head = null;
    panel = null;
    pushItem(dept, {
      kind: 'single',
      row: toRow(t),
      testId: t.testId ?? null,
      interpretation: cleanMultiline(t.interpretation),
      interpretationImage: t.interpretationImage ?? null,
    });
  }

  // A group that matched a culture field but lacks the antibiogram's signature
  // falls back to ordinary parameter rows.
  for (const g of cultureGroups) {
    if (!g.culture) continue;
    if (!hasAntibiogram(g.culture)) {
      delete g.culture;
      continue;
    }
    dedupeAntibiogram(g.culture);
  }

  return {
    departments: deptOrder.map((name) => ({ name, items: deptItems.get(name)! })),
    specimens: [...specimens],
  };
}
