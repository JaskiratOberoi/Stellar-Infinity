/**
 * Stamping: the accreditation symbol, the QR download link and page numbers,
 * drawn onto an existing PDF without re-typesetting anything in it.
 *
 * Everything is placed in the page's VISUAL frame, the one the reader sees,
 * which is the CropBox turned by the page's /Rotate. Coordinates are worked
 * out there and mapped back into raw page space at the last moment, so a
 * landscape scan or a rotated attachment gets its stamp in the same corner,
 * the right way up, as every portrait sheet.
 *
 * The images are embedded once per document and drawn on every page that
 * wants them: a fifty-page report carries one copy of the symbol, not fifty.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib';
import { qrPng } from './links.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SYMBOL_PATH = path.join(here, '..', 'assets', 'nabl.png');

/** Millimetres to PDF points. */
export const mm = (v) => (v / 25.4) * 72;

export const DEFAULTS = Object.freeze({
  /**
   * Accreditation certificate number, printed beneath the symbol when given.
   * Empty by default: the symbol alone. The reports this seals already carry
   * the number in their own footer line and medallion, and a second copy
   * under every mark read as clutter.
   */
  cert: '',
  /**
   * Where the foot symbol goes. `original`: beside the report's own QR, to
   * its left, sized to its height — the place an accredited report carries
   * it. Otherwise header-/footer- × left/center/right, or off. A page with no
   * QR of its own falls back to the bottom centre.
   */
  mark: 'original',
  /** Which pages carry the symbol: all | first | last. */
  markPages: 'all',
  /** Foot symbol height, mm. */
  markSize: 14,
  /** Height of the small symbol beside each parameter name, mm. */
  rowSize: 4,
  /**
   * Where the QR goes. `original`: in place of the report's own QR — the
   * old code is painted out and the new one drawn in its box, so the
   * report's own caption ("Scan to verify") now points at the sealed file.
   * Otherwise the same anchors as `mark`; items sharing an anchor sit side
   * by side, symbol first. A page with no QR of its own falls back to the
   * bottom centre.
   */
  qr: 'original',
  qrPages: 'all',
  /** QR side, mm. Below ~12mm a phone camera starts to struggle on paper. */
  qrSize: 13,
  /** Caption under the QR. Empty: none. */
  caption: 'Scan to download this report',
  /** "Page X of Y": right | center | left | off. */
  numbers: 'right',
  /** Distance from the paper edge, mm. */
  margin: 10,
});

const ANCHORS = ['original', 'header-left', 'header-center', 'header-right', 'footer-left', 'footer-center', 'footer-right', 'off'];
/** Where an `original` placement lands on a page that has no QR of its own. */
const FALLBACK = 'footer-center';
const PAGE_SETS = ['all', 'first', 'last'];
const NUMBERS = ['right', 'center', 'left', 'off'];

export class SealError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const pick = (v, allowed, fallback) => (allowed.includes(v) ? v : fallback);
const num = (v, min, max, fallback) => {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
/* Printable ASCII only: the standard fonts cannot encode everything, and a
   certificate number or caption needs nothing more. */
const text = (v, max, fallback) => (typeof v === 'string' ? v.replace(/[^\x20-\x7E]/g, '').trim().slice(0, max) : fallback);

/** Options as sent (query string or JSON) → validated, clamped, defaulted. */
export function normalizeOptions(raw = {}) {
  return {
    cert: text(raw.cert, 40, DEFAULTS.cert),
    mark: pick(raw.mark, ANCHORS, DEFAULTS.mark),
    markPages: pick(raw.markPages, PAGE_SETS, DEFAULTS.markPages),
    markSize: num(raw.markSize, 6, 40, DEFAULTS.markSize),
    rowSize: num(raw.rowSize, 2.5, 10, DEFAULTS.rowSize),
    qr: pick(raw.qr, ANCHORS, DEFAULTS.qr),
    qrPages: pick(raw.qrPages, PAGE_SETS, DEFAULTS.qrPages),
    qrSize: num(raw.qrSize, 10, 50, DEFAULTS.qrSize),
    caption: text(raw.caption, 60, DEFAULTS.caption),
    numbers: pick(raw.numbers, NUMBERS, DEFAULTS.numbers),
    margin: num(raw.margin, 3, 30, DEFAULTS.margin),
  };
}

const onPage = (set, i, n) => set === 'all' || (set === 'first' && i === 0) || (set === 'last' && i === n - 1);

/**
 * The visual frame of a page: its size as displayed, and a mapping from a
 * point in that frame (x from the left, y from the bottom, as the reader sees
 * it) to raw page coordinates, plus the rotation that keeps drawn content
 * upright once the viewer applies /Rotate.
 */
function frame(page) {
  const box = page.getCropBox();
  const angle = ((page.getRotation().angle % 360) + 360) % 360;
  const { width: W, height: H } = box;
  const swap = angle === 90 || angle === 270;
  const toPage = (vx, vy) => {
    switch (angle) {
      case 90: return { x: box.x + W - vy, y: box.y + vx };
      case 180: return { x: box.x + W - vx, y: box.y + H - vy };
      case 270: return { x: box.x + vy, y: box.y + H - vx };
      default: return { x: box.x + vx, y: box.y + vy };
    }
  };
  const toVisual = (x, y) => {
    const px = x - box.x, py = y - box.y;
    switch (angle) {
      case 90: return { vx: py, vy: W - px };
      case 180: return { vx: W - px, vy: H - py };
      case 270: return { vx: H - py, vy: px };
      default: return { vx: px, vy: py };
    }
  };
  return { vw: swap ? H : W, vh: swap ? W : H, toPage, toVisual, rotate: degrees(angle) };
}

const GREY = rgb(0.35, 0.35, 0.35);
const INK = rgb(0.08, 0.09, 0.12);

/** The symbol, with the certificate number centred beneath it when given. */
function symbolItem(img, opts, bold) {
  const h = mm(opts.markSize);
  const w = h * (img.width / img.height);
  const certSize = opts.cert ? Math.max(5, h * 0.22) : 0;
  const gap = opts.cert ? h * 0.05 : 0;
  const certW = opts.cert ? bold.widthOfTextAtSize(opts.cert, certSize) : 0;
  const width = Math.max(w, certW);
  const height = h + gap + certSize;
  return {
    width,
    height,
    draw(page, f, vx, vy) {
      const ip = f.toPage(vx + (width - w) / 2, vy + certSize + gap);
      page.drawImage(img, { x: ip.x, y: ip.y, width: w, height: h, rotate: f.rotate });
      if (opts.cert) {
        const tp = f.toPage(vx + (width - certW) / 2, vy + certSize * 0.18);
        page.drawText(opts.cert, { x: tp.x, y: tp.y, size: certSize, font: bold, color: INK, rotate: f.rotate });
      }
    },
  };
}

/** The QR, with its caption centred beneath it when given. */
function qrItem(img, opts, font) {
  const s = mm(opts.qrSize);
  let capSize = opts.caption ? 6.5 : 0;
  let capW = opts.caption ? font.widthOfTextAtSize(opts.caption, capSize) : 0;
  // A long caption shrinks a little rather than making the block much wider
  // than the code it labels.
  while (opts.caption && capW > s * 1.6 && capSize > 4.5) {
    capSize -= 0.5;
    capW = font.widthOfTextAtSize(opts.caption, capSize);
  }
  const gap = opts.caption ? 2 : 0;
  const width = Math.max(s, capW);
  const height = s + gap + capSize;
  return {
    width,
    height,
    draw(page, f, vx, vy) {
      const ip = f.toPage(vx + (width - s) / 2, vy + capSize + gap);
      page.drawImage(img, { x: ip.x, y: ip.y, width: s, height: s, rotate: f.rotate });
      if (opts.caption) {
        const tp = f.toPage(vx + (width - capW) / 2, vy + capSize * 0.18);
        page.drawText(opts.caption, { x: tp.x, y: tp.y, size: capSize, font, color: GREY, rotate: f.rotate });
      }
    },
  };
}

/**
 * Place every item at its anchor. Items sharing an anchor sit side by side
 * (symbol then QR, in the order added), aligned to the bottom in a footer and
 * to the top in a header, so a report that wants both in one corner still
 * reads as one tidy block.
 */
function layout(page, f, groups, marginPt) {
  const gapX = mm(4);
  for (const [anchor, items] of groups) {
    const [band, side] = anchor.split('-');
    const total = items.reduce((a, it) => a + it.width, 0) + gapX * (items.length - 1);
    let vx = side === 'left' ? marginPt : side === 'right' ? f.vw - marginPt - total : (f.vw - total) / 2;
    for (const it of items) {
      const vy = band === 'footer' ? marginPt : f.vh - marginPt - it.height;
      it.draw(page, f, vx, vy);
      vx += it.width + gapX;
    }
  }
}

/**
 * "Page X of Y", 8pt grey, in the margin strip below the footer items so it
 * never collides with them, and never closer than 3.5mm to the paper edge.
 */
function drawPageNumber(page, f, font, i, n, opts, marginPt) {
  const label = `Page ${i + 1} of ${n}`;
  const size = 8;
  const w = font.widthOfTextAtSize(label, size);
  const vy = Math.max(mm(3.5), marginPt - mm(6));
  const vx = opts.numbers === 'left' ? marginPt
    : opts.numbers === 'center' ? (f.vw - w) / 2
      : f.vw - marginPt - w;
  const p = f.toPage(vx, vy);
  page.drawText(label, { x: p.x, y: p.y, size, font, color: GREY, rotate: f.rotate });
}

/**
 * Rows to mark, as the analysis reported them and the person confirmed them:
 * the leftmost text run of each line, in raw page space. Anything malformed
 * is dropped rather than refused; a bad row is not a reason to lose the seal.
 */
export function normalizeRows(rows, pageCount) {
  if (!Array.isArray(rows)) return [];
  const out = [];
  for (const r of rows.slice(0, 4000)) {
    const page = Number(r?.page), x = Number(r?.x), y = Number(r?.y);
    const w = Number(r?.w ?? 0), h = Number(r?.h ?? 10);
    if (!Number.isInteger(page) || page < 0 || page >= pageCount) continue;
    if (![x, y, w, h].every(Number.isFinite)) continue;
    out.push({ page, x, y, w: Math.max(0, w), h: Math.max(4, h) });
  }
  return out;
}

/**
 * The small symbol beside a parameter name: to the LEFT of the name, in the
 * gutter, centred on the line of text. When the name sits so close to the
 * paper edge that nothing fits before it, the symbol goes after it instead.
 */
function drawRowMark(page, f, img, opts, bold, row) {
  const item = symbolItem(img, { markSize: opts.rowSize, cert: opts.cert }, bold);
  const v = f.toVisual(row.x, row.y);
  const centre = v.vy + row.h * 0.36;
  const vy = centre - item.height / 2;
  let vx = v.vx - mm(1.5) - item.width;
  if (vx < mm(1)) vx = v.vx + row.w + mm(1.5);
  item.draw(page, f, vx, vy);
}

/**
 * The seal's QR in place of the report's own: the old code painted out with
 * a hair of white around it (a printed QR has a quiet zone; the paint-out
 * must not eat into anything beside it), the new one drawn square in the
 * same box. Whatever caption the report set under it still stands.
 */
function drawOverQr(page, f, img, box) {
  const v = f.toVisual(box.x, box.y);
  const s = Math.min(box.w, box.h);
  const pad = 1.5;
  const r = f.toPage(v.vx - pad, v.vy - pad);
  page.drawRectangle({ x: r.x, y: r.y, width: s + pad * 2, height: s + pad * 2, color: rgb(1, 1, 1), borderWidth: 0, rotate: f.rotate });
  const p = f.toPage(v.vx, v.vy);
  page.drawImage(img, { x: p.x, y: p.y, width: s, height: s, rotate: f.rotate });
}

/**
 * The symbol beside the report's own QR: to its left, bottom-aligned, sized
 * so the symbol and its certificate number together stand as tall as the
 * code. Where nothing fits on the left it goes to the right instead.
 */
function drawBesideQr(page, f, img, opts, bold, box) {
  const v = f.toVisual(box.x, box.y);
  const s = Math.min(box.w, box.h);
  // symbolItem stands h + 5% gap + a 22% certificate line tall; solve for h.
  const h = opts.cert ? s / 1.27 : s;
  const item = symbolItem(img, { markSize: h / mm(1), cert: opts.cert }, bold);
  const gap = mm(3);
  let vx = v.vx - gap - item.width;
  if (vx < mm(2)) vx = v.vx + s + gap;
  item.draw(page, f, vx, v.vy);
}

let symbolBytes = null;
async function symbol() { return (symbolBytes ??= await readFile(SYMBOL_PATH)); }

/**
 * Seal a PDF.
 *
 * @param {Uint8Array|Buffer} input   the report as uploaded
 * @param {object} rawOptions         see DEFAULTS; anything invalid falls back
 * @param {{ qrUrl?: string|null, rows?: Array, qrBoxes?: Array }} qrUrl: the URL the QR should carry (null draws no QR);
 *        rows: parameter-name positions to mark, see normalizeRows;
 *        qrBoxes: where the report's own QR sits per page ({page,x,y,w,h}, raw page space),
 *        as analyze() found it — what the `original` placements take the place of
 * @returns {{ bytes: Uint8Array, pages: number, options: object, stamped: { mark: boolean, qr: boolean, rows: number, qrReplaced: number } }}
 */
export async function seal(input, rawOptions = {}, { qrUrl = null, rows = [], qrBoxes = [] } = {}) {
  const opts = normalizeOptions(rawOptions);

  let doc;
  try {
    // updateMetadata:false leaves the document's own Producer/ModDate alone.
    doc = await PDFDocument.load(input, { ignoreEncryption: true, updateMetadata: false });
  } catch (e) {
    throw new SealError(`That file could not be read as a PDF (${e.message}).`);
  }
  // Drawing onto an encrypted document would leave the new content readable
  // and the old content not, which no viewer will open. Say so instead.
  if (doc.isEncrypted) throw new SealError('This PDF is password-protected. Remove the protection and upload it again.');

  const pages = doc.getPages();
  const n = pages.length;
  if (n === 0) throw new SealError('This PDF has no pages.');

  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const rowMarks = normalizeRows(rows, n);
  const rowsByPage = new Map();
  for (const r of rowMarks) {
    if (!rowsByPage.has(r.page)) rowsByPage.set(r.page, []);
    rowsByPage.get(r.page).push(r);
  }
  const markImg = opts.mark !== 'off' || rowMarks.length ? await doc.embedPng(await symbol()) : null;
  const qrImg = opts.qr !== 'off' && qrUrl ? await doc.embedPng(await qrPng(qrUrl)) : null;
  const marginPt = mm(opts.margin);
  // The report's own QR per page, as found; one per page, the first given.
  const boxByPage = new Map();
  for (const b of Array.isArray(qrBoxes) ? qrBoxes : []) {
    const page = Number(b?.page);
    if (!Number.isInteger(page) || page < 0 || page >= n || boxByPage.has(page)) continue;
    if (![b.x, b.y, b.w, b.h].every((v) => Number.isFinite(Number(v))) || Number(b.w) < 10 || Number(b.h) < 10) continue;
    boxByPage.set(page, { x: Number(b.x), y: Number(b.y), w: Number(b.w), h: Number(b.h) });
  }
  let qrReplaced = 0;

  pages.forEach((page, i) => {
    const f = frame(page);
    const box = boxByPage.get(i) ?? null;
    const groups = new Map();
    const put = (anchor, item) => {
      if (!groups.has(anchor)) groups.set(anchor, []);
      groups.get(anchor).push(item);
    };
    // Symbol before QR, so the two share the fallback anchor in that order.
    if (markImg && opts.mark !== 'off' && onPage(opts.markPages, i, n)) {
      if (opts.mark === 'original' && box) drawBesideQr(page, f, markImg, opts, bold, box);
      else put(opts.mark === 'original' ? FALLBACK : opts.mark, symbolItem(markImg, opts, bold));
    }
    if (qrImg && onPage(opts.qrPages, i, n)) {
      if (opts.qr === 'original' && box) { drawOverQr(page, f, qrImg, box); qrReplaced++; }
      else put(opts.qr === 'original' ? FALLBACK : opts.qr, qrItem(qrImg, opts, font));
    }
    layout(page, f, groups, marginPt);
    for (const row of rowsByPage.get(i) ?? []) drawRowMark(page, f, markImg, opts, bold, row);
    if (opts.numbers !== 'off') drawPageNumber(page, f, font, i, n, opts, marginPt);
  });

  const bytes = await doc.save({ useObjectStreams: true });
  return {
    bytes,
    pages: n,
    options: opts,
    stamped: { mark: Boolean(markImg) && opts.mark !== 'off', qr: Boolean(qrImg), rows: rowMarks.length, qrReplaced },
  };
}
