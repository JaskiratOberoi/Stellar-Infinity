/**
 * The WhatsApp sidecar.
 *
 * Holds ONE linked WhatsApp Web session — a phone number linked the way
 * WhatsApp Web is, by scanning a QR from the phone's "Linked devices" — and
 * sends through it on the Infinity API's instruction. whatsapp-web.js drives
 * the real WhatsApp Web page in headless Chromium, so this is the same thing a
 * person at a browser does, one message at a time.
 *
 * Deliberately dumb. It does not decide who gets a report, when, or how fast:
 * the API's WhatsAppWorker does all of that (pacing, daily cap, quiet hours,
 * the staging allowlist, opt-outs) and this only carries out one send at a
 * time. It keeps nothing but the session itself (in /data) and a short ring
 * of recent events (delivery ticks, opt-out replies) for the API to collect.
 *
 * Trust: like the render sidecar, this listens on the compose network only and
 * is never published. Anyone who can reach it can message anyone from the
 * lab's number.
 *
 * The session handling follows the lab's existing WhatsApp bots
 * (X:Listec Automationpersonal_whatsapp_service.js): LocalAuth with a
 * named clientId, a local WhatsApp Web version cache, a cooldown between
 * failed starts, a ready timeout, and pairing by phone-number code as well as
 * by QR (with the same library patch, see patch-wweb-pairing-defer.cjs).
 *
 *   GET  /status            {state, qr, pairingCode, me, since, error}
 *                           state: starting | qr | ready | disconnected
 *   POST /send              {to, text, pdfB64?, filename?} → {id} | 422 not_on_whatsapp
 *   GET  /events?after=N    {events:[{seq, type, id?, ack?, from?, at}], last}
 *   POST /logout            unlink this device; a fresh QR follows
 *   POST /pair {phone}      link by phone number instead: an 8-character code
 *                           to type in WhatsApp → Linked devices → Link with
 *                           phone number
 */
import { createServer } from 'node:http';
import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import QRCode from 'qrcode';
import wweb from 'whatsapp-web.js';

const { Client, LocalAuth, MessageMedia } = wweb;

const PORT = Number(process.env.PORT ?? 8095);
const DATA = process.env.WA_DATA ?? '/data';
const AUTH_DIR = path.join(DATA, '.wwebjs_auth');
const WEB_CACHE_DIR = path.join(DATA, '.wwebjs_cache');
const CLIENT_ID = 'infinity-reports';
/** As the Listec bots: wait this long after a failed start before the next. */
const RETRY_COOLDOWN_MS = 25_000;
/** WhatsApp Web that has not come up in two minutes is not going to. */
const READY_TIMEOUT_MS = 120_000;

/* ------------------------------------------------------------- state ---- */

const state = { state: 'starting', qr: null, pairingCode: null, me: null, since: new Date().toISOString(), error: null };
const setState = (s, extra = {}) => Object.assign(state, { state: s, since: new Date().toISOString() }, extra);

/** Recent events for the API to collect: delivery acks and opt-out replies. */
const events = [];
let seq = 0;
function pushEvent(e) {
  events.push({ seq: ++seq, at: new Date().toISOString(), ...e });
  if (events.length > 2000) events.splice(0, events.length - 2000);
}

/* ------------------------------------------------------------ client ---- */

/*
 * A container killed mid-run leaves Chromium's Singleton* lock files in the
 * profile, and the next launch refuses the "profile in use". Nothing else can
 * be using it — this container is its only user — so they are removed first.
 */
async function clearLocks(dir) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await clearLocks(p);
    else if (/^Singleton(Lock|Socket|Cookie)$/.test(e.name)) await rm(p, { force: true });
  }
}

let client = null;
let starting = false;
/** Set by POST /pair: the next start links by phone-number code, not QR. */
let pairPhone = null;
let readyTimer = null;

async function start() {
  if (starting) return;
  starting = true;
  try {
    await clearLocks(DATA);
    setState('starting', { qr: null, pairingCode: null, error: null });
    const options = {
      authStrategy: new LocalAuth({ dataPath: AUTH_DIR, clientId: CLIENT_ID }),
      webVersionCache: { type: 'local', path: WEB_CACHE_DIR },
      puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      },
    };
    if (pairPhone) options.pairWithPhoneNumber = { phoneNumber: pairPhone, showNotification: true };
    client = new Client(options);

    clearTimeout(readyTimer);
    readyTimer = setTimeout(() => {
      if (state.state !== 'ready' && state.state !== 'qr' && !state.pairingCode) {
        console.warn('wa ready timeout; restarting');
        setState('disconnected', { error: 'WhatsApp Web did not finish loading.' });
        void restart(RETRY_COOLDOWN_MS);
      }
    }, READY_TIMEOUT_MS);

    client.on('code', (code) => setState('qr', { qr: null, pairingCode: code, me: null }));
    client.on('qr', async (qr) => {
      if (pairPhone) return;
      setState('qr', { qr: await QRCode.toDataURL(qr, { margin: 1, width: 320 }), pairingCode: null, me: null });
    });
    client.on('authenticated', () => setState('starting', { qr: null }));
    client.on('auth_failure', (m) => {
      setState('disconnected', { error: `auth failure: ${m}` });
      void restart(RETRY_COOLDOWN_MS);
    });
    client.on('ready', () => {
      const w = client.info?.wid;
      pairPhone = null;
      clearTimeout(readyTimer);
      setState('ready', { qr: null, pairingCode: null, error: null, me: { number: w?.user ?? null, name: client.info?.pushname ?? null } });
      console.log(`wa ready as ${w?.user}`);
    });
    client.on('disconnected', (reason) => {
      console.warn(`wa disconnected: ${reason}`);
      setState('disconnected', { error: String(reason), me: null });
      // Unlinked from the phone, or the session dropped: start again, which
      // either restores the session or shows a fresh QR.
      void restart(RETRY_COOLDOWN_MS);
    });
    // 1 sent (server), 2 delivered, 3 read, 4 played; -1 error.
    client.on('message_ack', (msg, ack) => {
      if (msg.fromMe) pushEvent({ type: 'ack', id: msg.id._serialized, ack });
    });
    // "STOP" from a patient: the API records the opt-out and sends nothing
    // more to that number.
    client.on('message', (msg) => {
      const body = (msg.body ?? '').trim().toUpperCase();
      if (['STOP', 'UNSUBSCRIBE', 'STOP REPORTS'].includes(body)) {
        pushEvent({ type: 'optout', from: String(msg.from ?? '').replace(/@.*$/, '') });
      }
    });

    await client.initialize();
  } catch (e) {
    console.error('wa start failed:', e);
    setState('disconnected', { error: String(e?.message ?? e) });
    void restart(RETRY_COOLDOWN_MS);
  } finally {
    starting = false;
  }
}

let restartTimer = null;
async function restart(delayMs = 0) {
  clearTimeout(restartTimer);
  const old = client;
  client = null;
  try { await old?.destroy(); } catch { /* already gone */ }
  restartTimer = setTimeout(() => void start(), delayMs);
}

/* -------------------------------------------------------------- http ---- */

async function readJson(req, limit = 32 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error('request body too large');
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function reply(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) });
  res.end(s);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && url.pathname === '/status') return reply(res, 200, state);

    if (req.method === 'GET' && url.pathname === '/events') {
      const after = Number(url.searchParams.get('after') ?? 0);
      return reply(res, 200, { events: events.filter((e) => e.seq > after), last: seq });
    }

    if (req.method === 'POST' && url.pathname === '/send') {
      if (state.state !== 'ready' || !client) return reply(res, 503, { error: 'not_ready', state: state.state });
      const b = await readJson(req);
      const to = String(b.to ?? '').replace(/\D/g, '');
      if (!/^\d{10,15}$/.test(to)) return reply(res, 400, { error: 'bad_number' });
      const id = await client.getNumberId(to);
      if (!id) return reply(res, 422, { error: 'not_on_whatsapp' });
      const chatId = id._serialized;
      // A beat of "typing…" before each message, as a person would.
      try {
        const chat = await client.getChatById(chatId);
        await chat.sendStateTyping();
        await sleep(1500 + Math.random() * 2500);
        await chat.clearState();
      } catch { /* a new chat may not exist yet; sending creates it */ }
      let msg;
      if (b.pdfB64) {
        const media = new MessageMedia('application/pdf', b.pdfB64, b.filename || 'Report.pdf');
        msg = await client.sendMessage(chatId, media, { caption: b.text || undefined, sendMediaAsDocument: true });
      } else {
        msg = await client.sendMessage(chatId, String(b.text ?? ''));
      }
      console.log(`wa sent to ${to.slice(0, 4)}…${to.slice(-2)} pdf=${b.pdfB64 ? 'yes' : 'no'}`);
      return reply(res, 200, { id: msg.id._serialized });
    }

    if (req.method === 'POST' && url.pathname === '/logout') {
      try { await client?.logout(); } catch (e) { console.warn('logout:', e?.message ?? e); }
      await rm(AUTH_DIR, { recursive: true, force: true }).catch(() => {});
      pairPhone = null;
      void restart();
      return reply(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/pair') {
      const b = await readJson(req);
      let d = String(b.phone ?? '').replace(/D/g, '');
      if (d.length === 10) d = '91' + d;
      if (!/^d{11,15}$/.test(d)) return reply(res, 400, { error: 'bad_number' });
      if (state.state === 'ready') return reply(res, 409, { error: 'already_linked' });
      pairPhone = d;
      await rm(AUTH_DIR, { recursive: true, force: true }).catch(() => {});
      void restart();
      return reply(res, 200, { ok: true });
    }

    return reply(res, 404, { error: 'not found' });
  } catch (e) {
    console.error(`${req.method} ${url.pathname} failed:`, e);
    return reply(res, 500, { error: String(e?.message ?? e) });
  }
});

server.listen(PORT, () => console.log(`whatsapp sidecar on ${PORT}`));
void start();

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    server.close();
    try { await client?.destroy(); } catch { /* shutting down anyway */ }
    process.exit(0);
  });
}
