/**
 * The download link printed inside the QR, and the token that gates it.
 *
 * A sealed report carries a QR encoding a public URL. Nobody signs in to open
 * it, so the URL itself has to be the credential: the id names the report and
 * the token proves the holder got the URL from the document rather than by
 * guessing. The token is an HMAC of the id under a server secret, truncated to
 * 24 base64url characters (144 bits) so it survives QR density and the odd
 * hand-typed URL. Holding one token says nothing about any other id.
 *
 * It is not a session and it does not expire: anyone holding the printed
 * report, or a photograph of it, can fetch that report. That is the intended
 * behaviour for a document already in the reader's hands, but it is a real
 * property and worth stating plainly.
 *
 * Fails closed: with no secret, no token is ever minted and no public request
 * ever verifies.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import QRCode from 'qrcode';

const PURPOSE = 'seal:report:';
const TOKEN_CHARS = 24;

/** 32 symbols, none of 0/O/1/I, so an id read off paper is unambiguous. */
const ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const ID_PATTERN = /^[A-HJ-NP-Z2-9]{10}$/;

/** A fresh report id: 10 symbols, 50 bits, uniform (256 / 32 exactly). */
export function newId() {
  let s = '';
  for (const b of randomBytes(10)) s += ID_ALPHABET[b & 31];
  return s;
}

/**
 * The signing secret: TOKEN_SECRET from the environment, else one generated
 * on first run and kept in the data directory so links survive restarts.
 */
export function loadSecret(dataDir) {
  const fromEnv = (process.env.TOKEN_SECRET ?? '').trim();
  if (fromEnv) return fromEnv;
  const file = path.join(dataDir, 'secret');
  if (existsSync(file)) {
    const s = readFileSync(file, 'utf8').trim();
    if (s) return s;
  }
  mkdirSync(dataDir, { recursive: true });
  const s = randomBytes(32).toString('hex');
  writeFileSync(file, s + '\n', { mode: 0o600 });
  return s;
}

/** The token for an id, or empty when there is no secret. */
export function token(secret, id) {
  if (!secret) return '';
  return createHmac('sha256', secret)
    .update(PURPOSE + String(id).trim())
    .digest('base64url')
    .slice(0, TOKEN_CHARS);
}

/** Constant-time check that `got` opens `id`. An empty expected token never matches. */
export function verify(secret, id, got) {
  const expected = token(secret, id);
  const candidate = String(got ?? '').trim();
  if (expected.length === 0 || candidate.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(candidate));
}

/** The URL a reader scans. */
export function publicUrl(baseUrl, id, secret) {
  return `${String(baseUrl).replace(/\/+$/, '')}/r/${encodeURIComponent(id)}?t=${token(secret, id)}`;
}

/**
 * The QR as a PNG. Error-correction level Q rather than the usual M: this is
 * printed small and then scanned off paper that has been folded, stamped and
 * posted.
 */
export function qrPng(url) {
  return QRCode.toBuffer(url, { type: 'png', errorCorrectionLevel: 'Q', margin: 1, scale: 8 });
}
