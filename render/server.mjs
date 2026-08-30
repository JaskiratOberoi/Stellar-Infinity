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
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const PORT = Number(process.env.PORT ?? 8090);
/** Where the SPA is reachable from inside the compose network. */
const BASE_URL = process.env.RENDER_BASE_URL ?? 'http://web';
const NAV_TIMEOUT = Number(process.env.RENDER_NAV_TIMEOUT_MS ?? 45_000);
/** Pages open at once. A batch of 50 reports must not open 50 tabs. */
const CONCURRENCY = Number(process.env.RENDER_CONCURRENCY ?? 4);

const LETTERHEAD_PATH = path.join(process.cwd(), 'report-assets', 'letterhead.pdf');
let letterheadBytes = null;
async function letterhead() {
  if (!letterheadBytes) letterheadBytes = await readFile(LETTERHEAD_PATH);
  return letterheadBytes;
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
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    await page.waitForNetworkIdle({ idleTime: 200, timeout: 8_000 }).catch(() => {});
    const tSettle = Date.now();

    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
    });
    console.log(`page ${target.pathname} nav=${tNav - t0} ready=${tReady - tNav} settle=${tSettle - tReady} pdf=${Date.now() - tSettle}`);
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
async function compositeOntoLetterhead(contentPdf, opts = {}) {
  const headless = opts.headless === true;
  // Baseline for "Page X of Y", in points from the paper bottom. It rides just
  // above the @page foot band so it shares the footer's baseline — and the band
  // depends on the mode (PrintQuery in the API): 40mm on plain paper, 34mm to
  // match Noble's pre-printed letterhead clear area. 116pt ≈ 40.9mm for the
  // former, 99pt ≈ 34.9mm for the latter.
  const pageNumberY = opts.pageNumberY ?? (headless ? 116 : 99);
  const pageNumbers = opts.pageNumbers !== false;

  const out = await PDFDocument.create();
  const content = await PDFDocument.load(contentPdf, { ignoreEncryption: true });

  let embeddedLetterhead = [];
  if (!headless) {
    const lh = await PDFDocument.load(await letterhead(), { ignoreEncryption: true });
    embeddedLetterhead = await Promise.all(lh.getPages().map((p) => out.embedPage(p)));
  }

  const font = await out.embedFont(StandardFonts.Helvetica);
  const pages = content.getPages();

  for (let i = 0; i < pages.length; i++) {
    const src = pages[i];
    const { width, height } = src.getSize();
    const page = out.addPage([width, height]);

    if (embeddedLetterhead.length) {
      const bg = embeddedLetterhead[i === 0 ? 0 : Math.min(1, embeddedLetterhead.length - 1)];
      page.drawPage(bg, { x: 0, y: 0, width, height });
    }

    page.drawPage(await out.embedPage(src), { x: 0, y: 0, width, height });

    // NABL wants every page numbered. Right-aligned to the 14mm content margin,
    // on the footer's own baseline rather than a line of its own.
    if (!pageNumbers) continue;
    const label = `Page ${i + 1} of ${pages.length}`;
    const size = 8;
    const rightMargin = (14 / 25.4) * 72;
    page.drawText(label, {
      x: width - rightMargin - font.widthOfTextAtSize(label, size),
      y: pageNumberY,
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
    for (const p of await out.copyPages(doc, doc.getPageIndices())) out.addPage(p);
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
  }
  return out.save();
}

/**
 * Stamp "Page X of Y" across a finished document — the batch path, where the
 * per-report stamping is turned OFF and the merged bundle is numbered as one
 * document instead: an eight-sheet stack that says "Page 1 of 2" halfway
 * through reads as a misprint. Same ink as compositeOntoLetterhead: 8pt
 * Helvetica, right-aligned to the 14mm margin, on the footer baseline.
 */
async function stampPageNumbers(bytes, pageNumberY = 116) {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = doc.getPages();
  const rightMargin = (14 / 25.4) * 72;
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const label = `Page ${i + 1} of ${pages.length}`;
    page.drawText(label, {
      x: page.getWidth() - rightMargin - font.widthOfTextAtSize(label, 8),
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

      const rendered = await mapLimit(reports, CONCURRENCY, async (r) => {
        // A finished document — the API's cache hit — skips the browser, the
        // letterhead and the stapling: all of that is already baked into it.
        if (r.pdfB64) return Buffer.from(r.pdfB64, 'base64');

        let doc = await compositeOntoLetterhead(
          await renderContent(r.url, body.cookie ?? null),
          { headless: r.headless, pageNumbers: r.pageNumbers, pageNumberY: r.pageNumberY },
        );
        for (const a of r.attachments ?? []) doc = await appendAttachment(doc, a);
        return doc;
      });

      let pdf = Buffer.from(await concat(rendered));
      if (body.numberPages === true) {
        // The batch-level Y tracks the foot band the API laid out for (40mm
        // plain / 34mm letterhead); default keeps the plain-paper baseline.
        pdf = Buffer.from(await stampPageNumbers(pdf, body.numberPagesY ?? 116));
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
