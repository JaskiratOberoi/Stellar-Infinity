/**
 * Text analysis: where the parameter names are.
 *
 * The accreditation mark goes beside each accredited parameter's name, and an
 * uploaded PDF does not say where its names are. pdf.js reads the text runs
 * and their positions; this groups them into lines and picks out the ones
 * shaped like a result row. The list is a proposal for a person to confirm,
 * not a verdict.
 *
 * Two readings, chosen per document:
 *
 *   • A report with a results TABLE — a header line naming the columns
 *     ("Test Name … Value … Unit …") — is read by region: result rows can only
 *     be BELOW that header and ABOVE the end marker or the signature block.
 *     The patient block above the header and the footer below the marker are
 *     never rows, whatever they contain. Within the table a row is a name at
 *     the left margin with a value to its right — a figure, or a qualitative
 *     result ("NEGATIVE", "NON REACTIVE", "LOWER THAN THE LINEAR RANGE OF THE
 *     ASSAY"). A department band or a group heading has nothing to its right
 *     and is left alone. A continuation page with no header of its own is
 *     still inside the table until an end marker closes it.
 *
 *     This is what fixed the HCV report that was read wrongly: "Ordered by …
 *     Collected : 10/09/2026" and the footer's "Report printed date:" were
 *     offered as rows — a label the filter did not know, a date to its right —
 *     while "HCV QUANTITATIVE  LOWER THAN THE LINEAR RANGE OF THE ASSAY" was
 *     not, having no digit anywhere on its line.
 *
 *   • A document with no such header falls back to the shape test alone —
 *     a name at the left, a value to its right, the obvious labels filtered
 *     out — since there is no region to trust.
 *
 * Positions come back in raw page space (points, origin bottom-left, before
 * /Rotate), which is exactly what the stamper draws in.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { OPS, getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const require = createRequire(import.meta.url);
// Forward slashes and a trailing one, whatever the platform: pdf.js checks
// for the slash literally, and path.join on Windows hands it a backslash.
const STANDARD_FONTS = path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts').replace(/\\/g, '/') + '/';

const MAX_PAGES = 200;
const MAX_LINES = 4000;

/** A line whose first word is one of these is furniture, not a result. */
const LABEL = /^(patient|name|age|sex|gender|dob|date|time|collected|received|reported|registered|printed|ordered|sample|specimen|referred|referring|ref\.?|doctor|dr\.?|consultant|client|centre|center|address|phone|tel|mob|email|page|method|note|notes|interpretation|comment|remarks?|end of report|test|tests|parameter|investigation|result|results|value|unit|units|reference|range|bill|order|reg\.?|id|uhid|mrn|lab|report|signature|authorised|authorized|verified|checked|processed|this is)\b/i;

/** The column header of a results table: a name column and a value column, named. */
const HEADER_NAME = /\b(test name|test description|tests?|parameters?|investigations?|analytes?)\b/i;
const HEADER_VALUE = /\b(values?|results?|observed|findings?)\b/i;

/** Where the results stop: the end marker, or the signature and footer block. */
const END = /end of report|electronically (authenticated|signed|generated)|scan to verify|nabl accredited|processed at:|report printed|\bpage \d+ of \d+/i;

/** A qualitative result — no digit in it, but a value all the same. */
const QUALITATIVE = /^(negative|positive|reactive|non[- ]?reactive|detected|not detected|absent|present|nil|normal|abnormal|trace|equivocal|indeterminate|borderline|lower than|higher than|less than|more than|below|above|within|seen|not seen|nad|<|>)/i;

const round = (n) => Math.round(n * 100) / 100;

/**
 * @returns {{ pages: number, lines: Array<{page:number,text:string,x:number,y:number,w:number,h:number,likely:boolean}>, truncated: boolean }}
 */
export async function analyze(bytes) {
  const task = getDocument({
    data: new Uint8Array(bytes),
    standardFontDataUrl: STANDARD_FONTS,
    disableFontFace: true,
    isEvalSupported: false,
    verbosity: 0,
  });
  const pdf = await task.promise;
  const pageCount = pdf.numPages;
  const lines = [];
  const qrs = [];
  // Whether the previous page ended still inside a results table — a report
  // that runs on carries its table onto a page that repeats no header.
  let carry = false;
  try {
    for (let p = 1; p <= Math.min(pageCount, MAX_PAGES) && lines.length < MAX_LINES; p++) {
      const page = await pdf.getPage(p);
      const box = await findQr(page).catch(() => null);
      if (box) qrs.push({ page: p - 1, ...box });
      const tc = await page.getTextContent();
      const items = tc.items
        .filter((it) => typeof it.str === 'string' && it.str.trim())
        .map((it) => ({
          text: it.str.trim(),
          x: it.transform[4],
          y: it.transform[5],
          w: it.width,
          h: it.height || Math.hypot(it.transform[2], it.transform[3]) || 10,
        }));
      const [w0, , w1] = page.view;
      const { lines: pageLines, inTable } = readPage(items, { width: Math.abs(w1 - w0), carry });
      carry = inTable;
      for (const line of pageLines) {
        if (lines.length >= MAX_LINES) break;
        lines.push({ page: p - 1, ...line });
      }
      page.cleanup();
    }
  } finally {
    await task.destroy();
  }
  return { pages: pageCount, lines, qrs, truncated: pageCount > MAX_PAGES || lines.length >= MAX_LINES };
}

/**
 * The report's own QR on a page, if it carries one: the square image nearest
 * the foot. Walks the page's drawing operators with the transform stack —
 * through form XObjects, which is where a composited report keeps its
 * content — and takes the box each image lands in, in raw page space.
 *
 * Square within 6%, between 20 and 150 points a side: a QR is drawn square to
 * the point, a signature is three times wider than tall, the accreditation
 * seal is taller than wide, the watermark is a page wide. Of several, the
 * lowest on the page wins — the verify code sits in the signature block at
 * the foot, and a logo in a header does not.
 *
 * @returns {Promise<{x:number,y:number,w:number,h:number}|null>}
 */
async function findQr(page) {
  const ops = await page.getOperatorList();
  const mul = (m, n) => [
    m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
  ];
  const IMAGE = new Set([OPS.paintImageXObject, OPS.paintImageMaskXObject, OPS.paintInlineImageXObject]);
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  let best = null;
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i], a = ops.argsArray[i];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() ?? ctm;
    else if (fn === OPS.transform) ctm = mul(ctm, a);
    else if (fn === OPS.paintFormXObjectBegin) { stack.push(ctm); if (Array.isArray(a?.[0])) ctm = mul(ctm, a[0]); }
    else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() ?? ctm;
    else if (IMAGE.has(fn)) {
      // The image fills the unit square under the current transform.
      const xs = [ctm[4], ctm[0] + ctm[4], ctm[2] + ctm[4], ctm[0] + ctm[2] + ctm[4]];
      const ys = [ctm[5], ctm[1] + ctm[5], ctm[3] + ctm[5], ctm[1] + ctm[3] + ctm[5]];
      const x = Math.min(...xs), y = Math.min(...ys);
      const w = Math.max(...xs) - x, h = Math.max(...ys) - y;
      if (w < 20 || w > 150 || h < 20 || h > 150 || Math.abs(w - h) > 0.06 * Math.max(w, h)) continue;
      if (!best || y < best.y) best = { x: round(x), y: round(y), w: round(w), h: round(h) };
    }
  }
  return best;
}

/** Text runs → lines (by baseline), each with its leftmost run's box and a likelihood flag. */
export function groupLines(items, opts = {}) {
  return readPage(items, opts).lines;
}

/**
 * One page: group the runs into lines, find the table (if any), and flag the
 * lines that read as result rows. Returns the lines and whether the page ends
 * still inside a table, for the next page to inherit.
 */
function readPage(items, { width = 595, carry = false } = {}) {
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const raw = [];
  let cur = null;
  for (const it of sorted) {
    if (cur && Math.abs(it.y - cur.y) <= Math.max(2, cur.h * 0.5)) cur.items.push(it);
    else { cur = { y: it.y, h: it.h, items: [it] }; raw.push(cur); }
  }
  for (const l of raw) {
    l.items.sort((a, b) => a.x - b.x);
    l.lead = l.items[0];
    l.text = l.items.map((i) => i.text).join('  ');
  }

  // The table's extent on this page, walking top to bottom. A header opens
  // it (or the carry from the previous page does); an end marker closes it.
  const headerAt = raw.findIndex((l) => HEADER_NAME.test(l.text) && HEADER_VALUE.test(l.text) && !l.items.some((i) => /\d/.test(i.text)));
  const region = new Set();
  let inTable = carry && headerAt < 0;
  let anyHeader = headerAt >= 0;
  for (let i = 0; i < raw.length; i++) {
    const l = raw[i];
    if (i === headerAt) { inTable = true; continue; }
    if (inTable && END.test(l.text)) { inTable = false; continue; }
    if (inTable) region.add(i);
  }
  const tabular = anyHeader || carry;

  const lines = raw.map((l, i) => {
    const { lead } = l;
    const rest = l.items.slice(1);
    // Inside a table a capitalised word beside the name is a value too:
    // "Colour  PALE YELLOW", "Appearance  CLEAR" — the LIS stores its
    // qualitative results in capitals, and no list of them is ever complete.
    const valueToTheRight = rest.some((r) => /\d/.test(r.text) || QUALITATIVE.test(r.text)
      || (tabular && /^[A-Z][A-Z .\/-]{2,}$/.test(r.text)));
    // A whole row emitted as one run: "Haemoglobin    12.8   g/dL".
    const rowShapedRun = l.items.length === 1 && /^[A-Za-z][^\d]+\s{2,}\S*\d/.test(lead.text);
    const nameLike = /^[A-Za-z]/.test(lead.text) && lead.text.length >= 2 && !LABEL.test(lead.text);
    const likely = tabular
      // In a table: only inside it, only from the left margin (a centred
      // department band is not a row), with a value beside the name.
      ? region.has(i) && nameLike && lead.x < width * 0.35 && (valueToTheRight || rowShapedRun)
      // No table found: the shape alone has to do.
      : nameLike && (valueToTheRight || rowShapedRun);
    return { text: l.text.slice(0, 160), x: round(lead.x), y: round(lead.y), w: round(lead.w), h: round(lead.h), likely };
  });

  return { lines, inTable };
}
