/**
 * The report renderer.
 *
 * Infinity's API is .NET and cannot drive a browser; this service owns the one
 * job that genuinely needs one — turning the SPA's own print route into a PDF —
 * and the pdf-lib work that goes with it (letterhead, page numbers, stapling
 * graph attachments, concatenating a batch).
 *
 * The point of rendering the SPA's route rather than composing a PDF in code:
 * the report's layout stays in ONE place. Change the print stylesheet and the
 * PDF changes with it. A PDF hand-composed in C# would immediately begin
 * drifting from what the screen shows, and the screen is what people check
 * against.
 *
 * The letterhead compositing, page numbering and attachment stapling below are
 * ported from Telo (lib/report/letterheadPdf.ts, mergePdfs.ts) so the two
 * systems put ink in the same places — a report printed from Infinity has to be
 * the same document as one printed from Telo.
 *
 * Trust: this listens on the compose network only and is never published. It
 * takes a cookie header from the API and replays it; it does not authenticate
 * anything itself, because the page it loads does. Publishing this port would
 * hand anyone a way to render any URL with someone else's session.
 */
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { PDFArray, PDFBool, PDFDocument, PDFName, StandardFonts, rgb } from 'pdf-lib';

const PORT = Number(process.env.PORT ?? 8090);
/** Where the SPA is reachable from inside the compose network. */
const BASE_URL = process.env.RENDER_BASE_URL ?? 'http://web';
const NAV_TIMEOUT = Number(process.env.RENDER_NAV_TIMEOUT_MS ?? 45_000);
/** Pages open at once. A batch of 50 reports must not open 50 tabs. */
const CONCURRENCY = Number(process.env.RENDER_CONCURRENCY ?? 4);

const LETTERHEAD_PATH = path.join(process.cwd(), 'report-assets', 'letterhead.pdf');
let letterheadBytes = null;
/**
 * The letterhead, with its embedded CMYK ICC profile replaced by the device
 * space it names as its own alternate.
 *
 * The profile is 1.37MB of the file's 1.49MB — the artwork is 120KB of
 * vector — and it rode into every document, and once per stapled unit into
 * a bundle: a five-sheet PID report weighed 7.8MB, of which 6.8MB was five
 * copies of the same colour table. Chromium's viewer draws the stripped
 * page identically (compared side by side, header and watermark alike),
 * because /DeviceCMYK is what the profile itself declares as its fallback.
 * The 2.6KB sRGB profile beside it is left alone. The file on disk is not
 * touched; this is done in memory, once.
 */
async function letterhead() {
  if (letterheadBytes) return letterheadBytes;
  letterheadBytes = await stripIcc(await readFile(LETTERHEAD_PATH));
  return letterheadBytes;
}

/** The ICC replacement above, for any letterhead PDF. */
async function stripIcc(bytes) {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const ctx = doc.context;
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFArray) || obj.size() < 2 || obj.get(0) !== PDFName.of('ICCBased')) continue;
    const profile = ctx.lookup(obj.get(1));
    if (!profile || !profile.contents || profile.contents.length < 100_000) continue;
    const n = profile.dict.get(PDFName.of('N'));
    const alternate = profile.dict.get(PDFName.of('Alternate'))
      ?? PDFName.of(String(n) === '4' ? 'DeviceCMYK' : String(n) === '1' ? 'DeviceGray' : 'DeviceRGB');
    ctx.assign(ref, alternate);
    ctx.delete(obj.get(1));
  }
  return doc.save({ useObjectStreams: true });
}

/*
 * A client's own letterhead (inf_letterhead, kind 'digital'), handed in by the
 * API with the request. A PDF is used as Noble's is — page 0 the first sheet,
 * page 1 (when present) every later one. A PNG or JPEG is laid full-bleed on
 * one A4 page, used for every sheet. Kept by content hash: the API sends the
 * same bytes for every report on that letterhead, and preparing them is the
 * slow part.
 */
const artworkCache = new Map();
async function clientLetterhead(b64, mime) {
  const hash = createHash('sha1').update(b64).digest('hex');
  if (artworkCache.has(hash)) return artworkCache.get(hash);
  const raw = Buffer.from(b64, 'base64');
  let bytes;
  if (mime === 'application/pdf') {
    bytes = await stripIcc(raw);
  } else {
    const doc = await PDFDocument.create();
    const img = mime === 'image/png' ? await doc.embedPng(raw) : await doc.embedJpg(raw);
    const page = doc.addPage([A4_W, A4_H]);
    page.drawImage(img, { x: 0, y: 0, width: A4_W, height: A4_H });
    bytes = await doc.save({ useObjectStreams: true });
  }
  if (artworkCache.size >= 24) artworkCache.delete(artworkCache.keys().next().value);
  artworkCache.set(hash, bytes);
  return bytes;
}

/* Page tags that survive stapling, so the one compositing pass at the end
   knows what each sheet is: the first sheet of a report (primary letterhead,
   patient block under it), a continuation sheet, or an attachment (a graph
   the instrument produced — no letterhead at all). Private keys on the page
   dictionary; every viewer ignores them. */
const TAG_FIRST = PDFName.of('InfinityFirstSheet');
const TAG_BARE = PDFName.of('InfinityNoLetterhead');

/** Mark the first page of a freshly rendered report. */
async function tagFirstPage(bytes) {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  if (doc.getPageCount() > 0) doc.getPage(0).node.set(TAG_FIRST, PDFBool.True);
  return doc.save();
}

/* ---------------------------------------------------------------- browser -- */

const LAUNCH = {
  headless: true,
  executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'],
};

/**
 * One browser, kept warm.
 *
 * Telo launches per request, which costs a few hundred ms it can afford. A
 * merged batch here can be fifty reports, so the launch would be paid fifty
 * times or the batch would serialise behind one cold start. The handle is
 * dropped on disconnect so a crashed Chromium is replaced rather than reused.
 */
let browserPromise = null;
async function browser() {
  if (!browserPromise) {
    browserPromise = puppeteer.launch(LAUNCH).then((b) => {
      b.on('disconnected', () => { browserPromise = null; });
      return b;
    }).catch((e) => { browserPromise = null; throw e; });
  }
  return browserPromise;
}

/**
 * Cookies arrive as a raw header and are re-domained onto the host Chromium is
 * about to visit — the API sees them for `localhost:3121`, the browser here
 * visits `web`. `secure` is deliberately not set: the session cookie is issued
 * Secure for the public origin, and a Secure cookie is dropped on the plain-http
 * internal hop. Nothing is weakened by that — this hop never leaves the compose
 * network, and the cookie was already handed to us by the API.
 */
function cookiesFor(header, domain) {
  if (!header) return [];
  return header.split(';').map((c) => c.trim()).filter(Boolean).map((c) => {
    const eq = c.indexOf('=');
    return {
      name: (eq === -1 ? c : c.slice(0, eq)).trim(),
      value: eq === -1 ? '' : c.slice(eq + 1),
      domain,
      path: '/',
    };
  }).filter((c) => c.name);
}

/** Render one print route to a content-only PDF (no letterhead yet). */
async function renderContent(url, cookieHeader) {
  const target = new URL(url, BASE_URL);
  const b = await browser();
  const page = await b.newPage();
  try {
    /*
     * Print media and the printed content width from the first paint. The
     * print page paginates ITSELF before it declares ready — to catch an
     * "End of Report" stranded on a sheet of its own and tighten spacing
     * until it is not (PrintReport's fit) — and that measurement is only
     * honest if the layout it measures is the layout page.pdf prints: the
     * same @media print rules, the same line wraps. page.pdf uses print
     * media regardless; this makes the page see it earlier. The width is
     * A4 less the side margins the page's own @page sets per paper
     * (ReportPaper.SideMm: 14mm on a client's plain sheet, 10mm otherwise).
     */
    await page.emulateMediaType('print');
    const sideMm = target.searchParams.get('paper') === 'plain' ? 14 : 10;
    await page.setViewport({
      width: Math.round((210 - 2 * sideMm) * 96 / 25.4),
      height: Math.round(297 * 96 / 25.4),
      deviceScaleFactor: 1,
    });
    /*
     * The browser is long-lived (see above), so its HTTP cache outlives
     * deploys — and it bit: the HTML shell had no Cache-Control, entries are
     * per-URL, and a print URL first visited under an older deploy kept
     * rendering that deploy's bundle for weeks (heuristic freshness), while
     * never-visited URLs rendered the new one. nginx now marks the shells
     * no-cache; this is the belt to that suspender. The refetch cost is a few
     * assets over the compose network, invisible next to the render itself.
     */
    await page.setCacheEnabled(false);
    const jar = cookiesFor(cookieHeader, target.hostname);
    if (jar.length) await page.setCookie(...jar);

    /*
     * Waits, in order of what they actually guarantee:
     *
     *   domcontentloaded   the document exists — nothing more. The old
     *                      networkidle2 gate here charged a fixed 500ms of
     *                      network silence on top of everything below, per
     *                      report, and guaranteed nothing the later waits
     *                      don't.
     *   data-print-ready   the page's own contract: data fetched, painted.
     *   fonts.ready        text metrics are final — a PDF taken earlier can
     *                      reflow mid-photograph.
     *   networkidle(200)   images the ready flag knows nothing about (QR,
     *                      signatures, the smart cover art). Usually already
     *                      settled by now, so this is ~200ms — and best-effort,
     *                      because a stray long request must not fail a render
     *                      that is visibly complete.
     */
    const t0 = Date.now();
    const res = await page.goto(target.toString(), { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    if (res && res.status() >= 400) {
      throw new Error(`print route returned HTTP ${res.status()} for ${target.pathname}`);
    }
    const tNav = Date.now();
    await page.waitForSelector('[data-print-ready="true"]', { timeout: NAV_TIMEOUT });
    const tReady = Date.now();
    // Which end-of-report fit step the page settled on (0 = untouched), for
    // the log line below — the one place a stranded marker can be diagnosed
    // after the fact without opening the PDF.
    const fit = await page.$eval('[data-print-ready="true"]', (el) => el.getAttribute('data-print-fit') ?? '-')
      .catch(() => '-');
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    await page.waitForNetworkIdle({ idleTime: 200, timeout: 8_000 }).catch(() => {});
    const tSettle = Date.now();

    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
    });
    console.log(`page ${target.pathname} fit=${fit} nav=${tNav - t0} ready=${tReady - tNav} settle=${tSettle - tReady} pdf=${Date.now() - tSettle}`);
    return pdf;
  } finally {
    await page.close().catch(() => {});
  }
}

/* ------------------------------------------------------------------- pdf --- */

/**
 * Composite content pages onto the letterhead and stamp "Page X of Y".
 *
 * Ported from Telo's mergeOntoLetterhead. Page 0 of the letterhead is the
 * primary sheet and page 1, when present, is the continuation sheet. Drawing
 * the letterhead as an embedded page rather than a raster keeps it vector.
 *
 * headless: skip the background entirely, for printing onto physical
 * pre-printed letterhead. The margins stay, so the content still lands under
 * the paper's printed header.
 */
/** Millimetres to PDF points. */
const mm = (v) => (v / 25.4) * 72;
const A4_W = mm(210);
const A4_H = mm(297);

async function compositeOntoLetterhead(contentPdf, opts = {}) {
  const headless = opts.headless === true;
  // Baseline for "Page X of Y", in points from the paper bottom. It rides just
  // above the @page foot band so it shares the footer's baseline — and the band
  // depends on the paper (ReportPaper in the API): 40mm on a client's sheet,
  // 28mm on Noble's, whose footer band starts 25.4mm up. 116pt ≈ 40.9mm for
  // the former, 82pt ≈ 28.9mm for the latter.
  // A default only for a caller that says nothing — the public route, always
  // the composited letterhead. The API always passes it: headless alone
  // cannot tell Noble's pre-printed paper (28mm foot) from a client's 40mm
  // sheet, and guessing 40mm put the number over the signatures.
  const pageNumberY = opts.pageNumberY ?? (headless ? 116 : 82);
  // Inset from the paper's right edge, in points: the @page side margin, which
  // is 10mm on Noble's paper and 14mm on a client's 40mm sheet. The API passes
  // it per paper; the default covers the public route, which is always the
  // composited letterhead.
  const pageNumberRight = opts.pageNumberRight ?? mm(headless ? 14 : 10);
  const pageNumbers = opts.pageNumbers !== false;
  // A printer's own drift (inf_letterhead.nudge_*), in points: the content and
  // its page number move together, the artwork stays where the sheet has it.
  const nudgeX = Number(opts.nudgeX) || 0;
  const nudgeY = Number(opts.nudgeY) || 0;

  const out = await PDFDocument.create();
  const content = await PDFDocument.load(contentPdf, { ignoreEncryption: true });

  // Embedded ONCE per document and drawn on every sheet that wants it. This
  // is the whole of the size fix: the pass runs on the finished, stapled
  // document, so a bundle carries one letterhead where it carried one per
  // unit — the XObject is shared, and a five-sheet PID report is the size of
  // its own content plus 120KB.
  let embeddedLetterhead = [];
  if (!headless) {
    const art = opts.artworkB64
      ? await clientLetterhead(opts.artworkB64, opts.artworkMime)
      : await letterhead();
    const lh = await PDFDocument.load(art, { ignoreEncryption: true });
    embeddedLetterhead = await Promise.all(lh.getPages().map((p) => out.embedPage(p)));
  }

  const font = await out.embedFont(StandardFonts.Helvetica);
  const pages = content.getPages();

  for (let i = 0; i < pages.length; i++) {
    const src = pages[i];
    const { width, height } = src.getSize();
    const page = out.addPage([width, height]);

    // Which sheet this is, from the tags the render pass left: a report's
    // first sheet takes the primary letterhead, any other its continuation,
    // and an attachment none. A page with no tag at all (a document from
    // before the tags) falls back to position.
    const bare = src.node.get(TAG_BARE) === PDFBool.True;
    const first = src.node.has(TAG_FIRST) ? src.node.get(TAG_FIRST) === PDFBool.True : i === 0;
    if (embeddedLetterhead.length && !bare) {
      const bg = embeddedLetterhead[first ? 0 : Math.min(1, embeddedLetterhead.length - 1)];
      page.drawPage(bg, { x: 0, y: 0, width, height });
    }

    page.drawPage(await out.embedPage(src), { x: nudgeX, y: -nudgeY, width, height });

    // NABL wants every page numbered. Right-aligned to the content margin,
    // on the footer's own baseline rather than a line of its own.
    if (!pageNumbers) continue;
    const label = `Page ${i + 1} of ${pages.length}`;
    const size = 8;
    page.drawText(label, {
      x: width - pageNumberRight - font.widthOfTextAtSize(label, size) + nudgeX,
      y: pageNumberY - nudgeY,
      size,
      font,
      color: rgb(0.35, 0.35, 0.35),
    });
  }

  return out.save();
}

/**
 * Staple a graph attachment after the report. A PDF contributes its pages
 * as-is; an image is centred on its own A4 page (defensive — the LIS data is
 * practically all PDF, but the column allows either).
 */
async function appendAttachment(reportBytes, { b64, mime }) {
  const extra = Buffer.from(b64, 'base64');
  const out = await PDFDocument.load(reportBytes, { ignoreEncryption: true });

  if (mime === 'application/pdf') {
    const doc = await PDFDocument.load(extra, { ignoreEncryption: true });
    for (const p of await out.copyPages(doc, doc.getPageIndices())) {
      // Stapled BEFORE the letterhead pass now, so the sheet says for itself
      // that it must stay bare.
      p.node.set(TAG_BARE, PDFBool.True);
      out.addPage(p);
    }
  } else {
    const img = mime === 'image/png' ? await out.embedPng(extra) : await out.embedJpg(extra);
    const page = out.addPage([595.28, 841.89]); // A4, points
    const margin = 36;
    const scale = Math.min(
      (page.getWidth() - margin * 2) / img.width,
      (page.getHeight() - margin * 2) / img.height,
      1,
    );
    const w = img.width * scale, h = img.height * scale;
    page.drawImage(img, { x: (page.getWidth() - w) / 2, y: (page.getHeight() - h) / 2, width: w, height: h });
    page.node.set(TAG_BARE, PDFBool.True);
  }
  return out.save();
}

/**
 * Stamp "Page X of Y" across a finished document — the batch path, where the
 * per-report stamping is turned OFF and the merged bundle is numbered as one
 * document instead: an eight-sheet stack that says "Page 1 of 2" halfway
 * through reads as a misprint. Same ink as compositeOntoLetterhead: 8pt
 * Helvetica, right-aligned to the paper's side margin, on the footer baseline.
 */
async function stampPageNumbers(bytes, pageNumberY = 116, pageNumberRight = mm(14)) {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = doc.getPages();
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const label = `Page ${i + 1} of ${pages.length}`;
    page.drawText(label, {
      x: page.getWidth() - pageNumberRight - font.widthOfTextAtSize(label, 8),
      y: pageNumberY,
      size: 8,
      font,
      color: rgb(0.35, 0.35, 0.35),
    });
  }
  return doc.save();
}

/** Concatenate finished reports, each keeping its own page numbering. */
async function concat(docs) {
  if (docs.length === 1) return docs[0];
  const out = await PDFDocument.create();
  for (const bytes of docs) {
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
    for (const p of await out.copyPages(doc, doc.getPageIndices())) out.addPage(p);
  }
  return out.save();
}

/*
 * The calibration sheet for a letterhead profile: two A4 pages (first sheet,
 * continuation sheet) that show where the report will put ink. Printed at
 * actual size onto the client's own stationery, the dashed box has to sit
 * inside the paper's clear area; if the whole box sits shifted, that shift is
 * the printer's drift and goes into the profile's nudge. The rulers on every
 * edge are there to measure it with.
 *
 * Body: { name, firstTopMm, topMm, bottomMm, sideMm, nudgeXMm, nudgeYMm,
 *         artworkB64?, artworkMime? } — the artwork, when given, is drawn
 * faintly behind, so the same sheet also checks a digital letterhead on
 * screen.
 */
async function calibrationSheet(b) {
  const out = await PDFDocument.create();
  const font = await out.embedFont(StandardFonts.Helvetica);
  const bold = await out.embedFont(StandardFonts.HelveticaBold);
  const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const side = num(b.sideMm, 14), bottom = num(b.bottomMm, 40);
  const nx = mm(num(b.nudgeXMm)), ny = mm(num(b.nudgeYMm));
  let art = [];
  if (b.artworkB64) {
    const lh = await PDFDocument.load(await clientLetterhead(b.artworkB64, b.artworkMime), { ignoreEncryption: true });
    art = await Promise.all(lh.getPages().map((p) => out.embedPage(p)));
  }
  const ink = rgb(0.1, 0.1, 0.1), soft = rgb(0.55, 0.55, 0.55), accent = rgb(0.05, 0.35, 0.75);

  for (const [i, label] of [[0, 'First sheet'], [1, 'Continuation sheet']]) {
    const top = i === 0 ? num(b.firstTopMm, 40) : num(b.topMm, 40);
    const page = out.addPage([A4_W, A4_H]);
    if (art.length) page.drawPage(art[Math.min(i, art.length - 1)], { x: 0, y: 0, width: A4_W, height: A4_H, opacity: 0.35 });

    // Rulers on all four edges: a tick every millimetre-5, a longer one and a
    // number every 10. Drawn with no nudge — they measure the paper itself.
    for (let v = 0; v <= 297; v += 5) {
      const long = v % 10 === 0, len = mm(long ? 4 : 2);
      const y = A4_H - mm(v);
      page.drawLine({ start: { x: 0, y }, end: { x: len, y }, thickness: 0.4, color: soft });
      page.drawLine({ start: { x: A4_W - len, y }, end: { x: A4_W, y }, thickness: 0.4, color: soft });
      if (long && v > 0 && v < 297) page.drawText(String(v), { x: mm(4.6), y: y - 2, size: 5, font, color: soft });
    }
    for (let v = 0; v <= 210; v += 5) {
      const long = v % 10 === 0, len = mm(long ? 4 : 2);
      const x = mm(v);
      page.drawLine({ start: { x, y: A4_H }, end: { x, y: A4_H - len }, thickness: 0.4, color: soft });
      page.drawLine({ start: { x, y: 0 }, end: { x, y: len }, thickness: 0.4, color: soft });
      if (long && v > 0 && v < 210) page.drawText(String(v), { x: x - 3, y: A4_H - mm(7), size: 5, font, color: soft });
    }

    // The content box: where the report's text may go, nudge applied.
    const x0 = mm(side) + nx, x1 = A4_W - mm(side) + nx;
    const yTop = A4_H - mm(top) - ny, yBot = mm(bottom) - ny;
    const dash = { thickness: 1, color: accent, dashArray: [4, 3] };
    page.drawLine({ start: { x: x0, y: yTop }, end: { x: x1, y: yTop }, ...dash });
    page.drawLine({ start: { x: x0, y: yBot }, end: { x: x1, y: yBot }, ...dash });
    page.drawLine({ start: { x: x0, y: yTop }, end: { x: x0, y: yBot }, ...dash });
    page.drawLine({ start: { x: x1, y: yTop }, end: { x: x1, y: yBot }, ...dash });
    // Corner crosses, easy to find on a busy sheet.
    for (const [cx, cy] of [[x0, yTop], [x1, yTop], [x0, yBot], [x1, yBot]]) {
      page.drawLine({ start: { x: cx - 8, y: cy }, end: { x: cx + 8, y: cy }, thickness: 1.2, color: accent });
      page.drawLine({ start: { x: cx, y: cy - 8 }, end: { x: cx, y: cy + 8 }, thickness: 1.2, color: accent });
    }

    const lines = [
      [bold, 13, `${b.name || 'Letterhead'} — ${label}`],
      [font, 9, `Report text is laid inside the dashed box: top ${top} mm, bottom ${bottom} mm, sides ${side} mm.`],
      [font, 9, `Printer nudge applied: ${num(b.nudgeXMm)} mm across, ${num(b.nudgeYMm)} mm down.`],
      [font, 9, 'Print at 100% / Actual size (no "fit to page") on the client\'s own stationery.'],
      [font, 9, 'The box must clear the printed header and footer. If it is shifted as a whole, measure the'],
      [font, 9, 'shift against the rulers and enter it as the nudge; if it is too tall, adjust the margins.'],
    ];
    let y = (yTop + yBot) / 2 + 40;
    for (const [f, size, text] of lines) {
      page.drawText(text, { x: x0 + mm(6), y, size, font: f, color: ink, maxWidth: x1 - x0 - mm(12) });
      y -= size + 7;
    }
  }
  return out.save();
}

/* ------------------------------------------------------------------ http --- */

/** Map over items with a ceiling on how many run at once, preserving order. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

async function readJson(req, limitBytes = 64 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limitBytes) throw new Error('request body too large');
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && url.pathname === '/health') {
    let chromium = null, ok = true;
    try { chromium = await (await browser()).version(); } catch (e) { ok = false; chromium = String(e.message); }
    res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok, chromium, baseUrl: BASE_URL }));
  }

  if (req.method === 'POST' && url.pathname === '/render') {
    const started = Date.now();
    try {
      const body = await readJson(req);
      const reports = Array.isArray(body.reports) ? body.reports : [];
      if (reports.length === 0) {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'no reports requested' }));
      }

      /*
       * Content first, letterhead last. Each report is rendered and its
       * attachments stapled as a CONTENT-ONLY document, tagged sheet by
       * sheet; the batch is concatenated; and then the letterhead and the
       * page numbers go on in ONE pass over the finished document. The
       * previous order — composite each unit, then staple — put a full copy
       * of the letterhead into every unit, and a bundle carried as many
       * copies as it had units.
       *
       * contentOnly: the API's per-unit render for its cache. What comes
       * back is the tagged content document, which a later batch call hands
       * in as pdfB64 for stapling under one letterhead. A cache hit from
       * before this change never reaches here: the API's cache version moved
       * with it.
       */
      const rendered = await mapLimit(reports, CONCURRENCY, async (r) => {
        if (r.pdfB64) return Buffer.from(r.pdfB64, 'base64');
        let doc = await tagFirstPage(await renderContent(r.url, body.cookie ?? null));
        for (const a of r.attachments ?? []) doc = await appendAttachment(doc, a);
        return doc;
      });

      let pdf = Buffer.from(await concat(rendered));
      if (body.contentOnly !== true) {
        // One paper per document: the batch says so at the top, a single
        // render on its own item.
        const lead = reports[0];
        const headless = body.headless ?? lead.headless === true;
        const numbered = body.numberPages === true
          || (reports.length === 1 && !lead.pdfB64 && lead.pageNumbers !== false);
        pdf = Buffer.from(await compositeOntoLetterhead(pdf, {
          headless,
          pageNumbers: numbered,
          // The batch-level Y tracks the foot band the API laid out for (40mm
          // plain / 28mm letterhead); a single render carries its own.
          pageNumberY: body.numberPagesY ?? lead.pageNumberY,
          pageNumberRight: body.numberPagesRight ?? lead.pageNumberRight,
          artworkB64: body.letterheadB64 ?? lead.letterheadB64 ?? null,
          artworkMime: body.letterheadMime ?? lead.letterheadMime ?? null,
          nudgeX: body.nudgeX ?? lead.nudgeX ?? 0,
          nudgeY: body.nudgeY ?? lead.nudgeY ?? 0,
        }));
      }
      console.log(`render ok reports=${reports.length} pages_in=${rendered.length} bytes=${pdf.length} ms=${Date.now() - started}`);
      res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': pdf.length });
      return res.end(pdf);
    } catch (e) {
      console.error(`render failed ms=${Date.now() - started}:`, e);
      res.writeHead(500, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: String(e && e.message ? e.message : e) }));
    }
  }

  if (req.method === 'POST' && url.pathname === '/calibration') {
    try {
      const pdf = Buffer.from(await calibrationSheet(await readJson(req)));
      res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': pdf.length });
      return res.end(pdf);
    } catch (e) {
      console.error('calibration failed:', e);
      res.writeHead(500, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: String(e && e.message ? e.message : e) }));
    }
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(PORT, () => console.log(`render listening on ${PORT}, base=${BASE_URL}`));

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    server.close();
    try { if (browserPromise) (await browserPromise).close(); } catch { /* shutting down anyway */ }
    process.exit(0);
  });
}
