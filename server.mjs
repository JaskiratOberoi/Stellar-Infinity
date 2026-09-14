/**
 * Report Seal — the HTTP surface.
 *
 *   GET  /                            the sealing page
 *   POST /api/upload                  body: the PDF (application/pdf) → upload id + the text lines found in it
 *   POST /api/seal                    JSON { uploadId, options, rows } → seals that upload; JSON with the links
 *   POST /api/seal?<options>          or the PDF itself as the body: one shot, no parameter-row marks
 *   GET  /r/:id?t=…                   where the printed QR lands: a page with a download button
 *   GET  /api/public/:id/pdf?t=…      the sealed PDF, token-gated (add &inline=1 to view in place)
 *   GET  /api/public/:id/qr.png?t=…   the same QR that is on the paper, as an image
 *   GET  /api/health
 *
 * The public routes answer 404 for every failure — bad token, unknown id,
 * missing file — so nothing about which ids exist leaks to a caller without
 * a token. Everything else is same-origin static content.
 *
 * Trust: there is no sign-in. Anyone who can reach POST /api/seal can seal a
 * document. Put it behind whatever access control the deployment already has
 * (a VPN, a reverse proxy with auth); the token-gated public routes are the
 * only part meant to be reachable from the open internet.
 */
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ID_PATTERN, loadSecret, newId, publicUrl, qrPng, token, verify } from './lib/links.mjs';
import { DEFAULTS, SealError, seal } from './lib/stamp.mjs';
import { analyze } from './lib/analyze.mjs';
import { Store } from './lib/store.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8080);
const DATA_DIR = path.resolve(process.env.DATA_DIR ?? path.join(here, 'data'));
const MAX_UPLOAD = Math.max(1, Number(process.env.MAX_UPLOAD_MB ?? 25)) * 1024 * 1024;
/** Where the QR must resolve. Empty: taken from each sealing request's own host. */
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL ?? '').trim().replace(/\/+$/, '');
const PUBLIC_DIR = path.join(here, 'public');
/**
 * The sealing page's sign-in. The README asks for the page to sit behind the
 * deployment's own access control; behind a public hostname with nothing in
 * front, this is it: HTTP Basic Auth, one shared user and password from the
 * environment. Unset, the page is open — right for a desk instance only.
 *
 * What stays open regardless is exactly what the README says must: the QR
 * landing page (/r/<id>), the download and the QR image behind it
 * (/api/public/*), the static files that page needs, and the health probe.
 * Everything else — the sealing page, its script, upload, seal, defaults —
 * asks for the credentials first.
 */
const SEAL_USER = (process.env.SEAL_USER ?? 'noble').trim();
const SEAL_PASSWORD = (process.env.SEAL_PASSWORD ?? '').trim();
const OPEN_PATHS = new Set(['/api/health', '/styles.css', '/favicon.svg', '/report.js']);
const isOpen = (p) => OPEN_PATHS.has(p) || /^\/r\/[^/]+$/.test(p) || p.startsWith('/api/public/');
const same = (a, b) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
const authorised = (req) => {
  if (!SEAL_PASSWORD) return true;
  const h = req.headers.authorization ?? '';
  if (!h.startsWith('Basic ')) return false;
  const [user, ...rest] = Buffer.from(h.slice(6), 'base64').toString('utf8').split(':');
  return same(user ?? '', SEAL_USER) && same(rest.join(':'), SEAL_PASSWORD);
};
/** Uploads wait here between analysis and sealing; anything older than this is swept. */
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const UPLOAD_TTL_MS = 2 * 60 * 60 * 1000;

const secret = loadSecret(DATA_DIR);
const store = new Store(DATA_DIR);

/* ---------------------------------------------------------------- static -- */

const STATIC = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/report.js', ['report.js', 'text/javascript; charset=utf-8']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml']],
]);

const CSP = [
  "default-src 'self'",
  "img-src 'self' data: blob:",
  "style-src 'self'",
  "script-src 'self'",
  "frame-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

function baseHeaders(res) {
  res.setHeader('x-content-type-options', 'nosniff');
  // The token rides in the URL of the landing page; never hand it to a third party as a referrer.
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('x-frame-options', 'SAMEORIGIN');
}

async function sendFile(res, name, type, extra = {}) {
  const body = await readFile(path.join(PUBLIC_DIR, name));
  const headers = { 'content-type': type, 'content-length': body.length, ...extra };
  if (type.startsWith('text/html')) headers['content-security-policy'] = CSP;
  res.writeHead(200, headers);
  res.end(body);
}

function json(res, status, body) {
  const s = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(s), 'cache-control': 'no-store' });
  res.end(s);
}

const notFound = (res) => json(res, 404, { error: 'not found' });

/* ------------------------------------------------------------------ body -- */

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, `That file is larger than the ${Math.round(limit / 1048576)} MB limit.`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** The origin the QR should point at: configured, else the one this request arrived on. */
function resolveBase(req) {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL;
  const proto = String(req.headers['x-forwarded-proto'] ?? 'http').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? `localhost:${PORT}`).split(',')[0].trim();
  return `${proto}://${host}`;
}

/* ---------------------------------------------------------------- routes -- */

/** The request body as a PDF, or an error that says why not. */
async function readPdfBody(req) {
  const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/pdf' && type !== 'application/octet-stream') {
    throw new HttpError(415, 'Send the PDF as the request body with Content-Type: application/pdf.');
  }
  const bytes = await readBody(req, MAX_UPLOAD);
  if (bytes.length < 8 || bytes.subarray(0, 5).toString('latin1') !== '%PDF-') {
    throw new HttpError(400, 'That file is not a PDF.');
  }
  return bytes;
}

function fileNameFrom(req) {
  try {
    const n = decodeURIComponent(String(req.headers['x-file-name'] ?? '')).trim();
    if (n) return path.basename(n).slice(0, 200);
  } catch { /* a bad header is not a reason to refuse the file */ }
  return 'report.pdf';
}

async function sweepUploads() {
  let names;
  try { names = await readdir(UPLOAD_DIR); } catch { return; }
  const now = Date.now();
  await Promise.all(names.map(async (n) => {
    const f = path.join(UPLOAD_DIR, n);
    try {
      if (now - (await stat(f)).mtimeMs > UPLOAD_TTL_MS) await rm(f, { force: true });
    } catch { /* already gone */ }
  }));
}

/** Step one: take the file, keep it, and report the text lines found in it. */
async function upload(req, res) {
  const original = await readPdfBody(req);
  const name = fileNameFrom(req);
  const uploadId = newId();
  await mkdir(UPLOAD_DIR, { recursive: true });
  await writeFile(path.join(UPLOAD_DIR, `${uploadId}.pdf`), original);
  await writeFile(path.join(UPLOAD_DIR, `${uploadId}.json`), JSON.stringify({ name, bytes: original.length, createdAt: new Date().toISOString() }));
  sweepUploads().catch(() => {});

  let analysis = { pages: 0, lines: [], truncated: false };
  let analysisError = null;
  const started = Date.now();
  try {
    analysis = await analyze(original);
  } catch (e) {
    console.warn(`analyze upload=${uploadId} failed: ${e?.message ?? e}`);
    analysisError = 'The text in this PDF could not be read, so no parameter rows can be offered. It may be a scanned image. The mark beside the QR and the QR itself can still be added.';
  }
  console.log(`upload id=${uploadId} bytes=${original.length} pages=${analysis.pages} lines=${analysis.lines.length} ms=${Date.now() - started}`);
  json(res, 201, { uploadId, name, bytes: original.length, ...analysis, analysisError });
}

/** Step two: seal a stored upload (JSON), or a PDF sent directly (one shot). */
async function sealRequest(req, res, url) {
  const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (type === 'application/json') {
    let body;
    try {
      body = JSON.parse((await readBody(req, 4 * 1024 * 1024)).toString('utf8') || '{}');
    } catch {
      throw new HttpError(400, 'The request body is not valid JSON.');
    }
    const uploadId = String(body.uploadId ?? '');
    if (!ID_PATTERN.test(uploadId)) throw new HttpError(400, 'Drop the report again; this upload reference is not valid.');
    const pdfPath = path.join(UPLOAD_DIR, `${uploadId}.pdf`);
    const infoPath = path.join(UPLOAD_DIR, `${uploadId}.json`);
    let original, info;
    try {
      original = await readFile(pdfPath);
      info = JSON.parse(await readFile(infoPath, 'utf8'));
    } catch {
      throw new HttpError(410, 'That upload has expired. Drop the report again.');
    }
    await finishSeal(req, res, {
      original,
      originalName: info.name ?? 'report.pdf',
      rawOptions: body.options && typeof body.options === 'object' ? body.options : {},
      rows: body.rows,
      cleanup: () => Promise.all([rm(pdfPath, { force: true }), rm(infoPath, { force: true })]),
    });
    return;
  }
  const original = await readPdfBody(req);
  await finishSeal(req, res, {
    original,
    originalName: fileNameFrom(req),
    rawOptions: Object.fromEntries(url.searchParams),
    rows: [],
    cleanup: null,
  });
}

async function finishSeal(req, res, { original, originalName, rawOptions, rows, cleanup }) {
  const id = newId();
  const t = token(secret, id);
  const link = publicUrl(resolveBase(req), id, secret);
  const started = Date.now();
  const result = await seal(original, rawOptions, { qrUrl: link, rows });

  const meta = {
    id,
    createdAt: new Date().toISOString(),
    originalName,
    originalBytes: original.length,
    sealedBytes: result.bytes.length,
    pages: result.pages,
    options: result.options,
    stamped: result.stamped,
    publicUrl: link,
  };
  await store.save(id, { original, sealed: result.bytes, meta });
  if (cleanup) await cleanup().catch(() => {});
  console.log(`seal id=${id} pages=${result.pages} rows=${result.stamped.rows} in=${original.length} out=${result.bytes.length} ms=${Date.now() - started}`);

  json(res, 201, {
    id,
    token: t,
    pages: result.pages,
    originalName,
    sealedBytes: result.bytes.length,
    stamped: result.stamped,
    options: result.options,
    publicUrl: link,
    downloadUrl: `/api/public/${id}/pdf?t=${t}`,
    viewUrl: `/api/public/${id}/pdf?t=${t}&inline=1`,
    qrImageUrl: `/api/public/${id}/qr.png?t=${t}`,
  });
}

/** The sealed PDF, on the strength of the token alone. */
async function publicPdf(id, url, res) {
  if (!ID_PATTERN.test(id) || !verify(secret, id, url.searchParams.get('t'))) return notFound(res);
  const file = store.sealedPath(id);
  let s;
  try { s = await stat(file); } catch { return notFound(res); }
  const inline = url.searchParams.get('inline') === '1';
  res.writeHead(200, {
    'content-type': 'application/pdf',
    'content-length': s.size,
    'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="Report-${id}.pdf"`,
    'cache-control': 'private, no-store',
    'x-robots-tag': 'noindex',
  });
  createReadStream(file).pipe(res);
}

/** The QR exactly as printed: regenerated from the URL that was sealed in, not from this request's host. */
async function publicQr(id, url, res) {
  if (!ID_PATTERN.test(id) || !verify(secret, id, url.searchParams.get('t'))) return notFound(res);
  const meta = await store.meta(id);
  if (!meta?.publicUrl) return notFound(res);
  const png = await qrPng(meta.publicUrl);
  res.writeHead(200, { 'content-type': 'image/png', 'content-length': png.length, 'cache-control': 'private, no-store' });
  res.end(png);
}

async function handle(req, res) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const p = url.pathname;
  baseHeaders(res);

  if (!isOpen(p) && !authorised(req)) {
    res.writeHead(401, {
      'www-authenticate': 'Basic realm="Report Seal", charset="UTF-8"',
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
    });
    return res.end('Sign in to seal a report.');
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    const file = STATIC.get(p);
    if (file) return sendFile(res, file[0], file[1]);
    if (p === '/api/health') return json(res, 200, { ok: true, publicBaseUrl: PUBLIC_BASE_URL || null, maxUploadMb: MAX_UPLOAD / 1048576 });
    if (p === '/api/defaults') return json(res, 200, DEFAULTS);
    let m;
    // The same page for every id, valid or not: it only holds the button. The
    // fetch behind the button is what the token actually opens.
    if (/^\/r\/[^/]+$/.test(p)) return sendFile(res, 'report.html', 'text/html; charset=utf-8', { 'cache-control': 'no-store' });
    if ((m = p.match(/^\/api\/public\/([^/]+)\/pdf$/))) return publicPdf(m[1], url, res);
    if ((m = p.match(/^\/api\/public\/([^/]+)\/qr\.png$/))) return publicQr(m[1], url, res);
  }
  if (req.method === 'POST' && p === '/api/upload') return upload(req, res);
  if (req.method === 'POST' && p === '/api/seal') return sealRequest(req, res, url);

  return notFound(res);
}

const server = createServer((req, res) => {
  handle(req, res).catch((e) => {
    const status = e instanceof HttpError || e instanceof SealError ? e.status : 500;
    if (status === 500) console.error(`${req.method} ${req.url} failed:`, e);
    if (res.headersSent) { res.destroy(); return; }
    json(res, status, { error: status === 500 ? 'Something went wrong while sealing. Try again.' : e.message });
  });
});

server.listen(PORT, () => {
  console.log(`report-seal listening on http://localhost:${PORT}`);
  console.log(`  data:        ${DATA_DIR}`);
  console.log(`  public base: ${PUBLIC_BASE_URL || '(from each request; set PUBLIC_BASE_URL for production)'}`);
  console.log(`  secret:      ${process.env.TOKEN_SECRET ? 'TOKEN_SECRET' : path.join(DATA_DIR, 'secret')}`);
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => { server.close(); process.exit(0); });
}
