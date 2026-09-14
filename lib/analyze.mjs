/**
 * Text analysis: where the parameter names are.
 *
 * The accreditation mark goes beside each accredited parameter's name, and an
 * uploaded PDF does not say where its names are. pdf.js reads the text runs
 * and their positions; this groups them into lines and picks out the ones
 * shaped like a result row: a name at the left, a figure somewhere to its
 * right. The list is a proposal for a person to confirm, not a verdict. A
 * patient block reads much like a result row to a machine, so the obvious
 * labels are filtered out, and everything else is left for the checklist.
 *
 * Positions come back in raw page space (points, origin bottom-left, before
 * /Rotate), which is exactly what the stamper draws in.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const require = createRequire(import.meta.url);
const STANDARD_FONTS = path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts/');

const MAX_PAGES = 200;
const MAX_LINES = 4000;

/** A line whose first word is one of these is furniture, not a result. */
const LABEL = /^(patient|name|age|sex|gender|dob|date|time|collected|received|reported|registered|printed|sample|specimen|referred|ref\.?|doctor|dr\.?|consultant|client|centre|center|address|phone|tel|mob|email|page|method|note|notes|interpretation|comment|remarks?|end of report|test|tests|parameter|investigation|result|results|value|unit|units|reference|range|bill|order|reg\.?|id|uhid|mrn|lab|report|signature|authorised|authorized|verified|checked|processed)\b/i;

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
  try {
    for (let p = 1; p <= Math.min(pageCount, MAX_PAGES) && lines.length < MAX_LINES; p++) {
      const page = await pdf.getPage(p);
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
      for (const line of groupLines(items)) {
        if (lines.length >= MAX_LINES) break;
        lines.push({ page: p - 1, ...line });
      }
      page.cleanup();
    }
  } finally {
    await task.destroy();
  }
  return { pages: pageCount, lines, truncated: pageCount > MAX_PAGES || lines.length >= MAX_LINES };
}

/** Text runs → lines (by baseline), each with its leftmost run's box and a likelihood flag. */
export function groupLines(items) {
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  let cur = null;
  for (const it of sorted) {
    if (cur && Math.abs(it.y - cur.y) <= Math.max(2, cur.h * 0.5)) cur.items.push(it);
    else { cur = { y: it.y, h: it.h, items: [it] }; lines.push(cur); }
  }
  return lines.map((l) => {
    l.items.sort((a, b) => a.x - b.x);
    const lead = l.items[0];
    const text = l.items.map((i) => i.text).join('  ');
    const figureToTheRight = l.items.slice(1).some((i) => /\d/.test(i.text));
    // A whole row emitted as one run: "Haemoglobin    12.8   g/dL".
    const rowShapedRun = l.items.length === 1 && /^[A-Za-z][^\d]+\s{2,}\S*\d/.test(lead.text);
    const likely = /^[A-Za-z]/.test(lead.text)
      && lead.text.length >= 2
      && !LABEL.test(lead.text)
      && (figureToTheRight || rowShapedRun);
    return { text: text.slice(0, 160), x: round(lead.x), y: round(lead.y), w: round(lead.w), h: round(lead.h), likely };
  });
}
