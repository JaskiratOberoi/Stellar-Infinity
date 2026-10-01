/**
 * The WhatsApp sidecar.
 *
 * Holds linked WhatsApp Web sessions — phone numbers linked the way WhatsApp
 * Web is, by scanning a QR from the phone's "Linked devices" — and sends
 * through them on the Infinity API's instruction. whatsapp-web.js drives the
 * real WhatsApp Web page in headless Chromium, so this is the same thing a
 * person at a browser does, one message at a time.
 *
 * SENDERS. One session is 'default' — the lab's universal number. Any number
 * of others can be added (POST /senders), each a separate linked number with
 * its own session directory and its own Chromium; the API decides which
 * sender a message goes from (a client can be assigned a number of its own).
 * The default sender keeps the directory and client id the single-session
 * version used, so the number linked before senders existed stays linked.
 *
 * Deliberately dumb. It does not decide who gets a report, when, or how fast:
 * the API's WhatsAppWorker does all of that (pacing, daily cap, quiet hours,
 * the staging allowlist, opt-outs) and this only carries out one send at a
 * time. It keeps nothing but the sessions themselves (in /data) and a short
 * ring of recent events (delivery ticks, opt-out replies) for the API to
 * collect.
 *
 * Trust: like the render sidecar, this listens on the compose network only and
 * is never published. Anyone who can reach it can message anyone from the
 * lab's numbers.
 *
 * The session handling follows the lab's existing WhatsApp bots
 * (X:\Listec Automation\personal_whatsapp_service.js): LocalAuth with a
 * named clientId, a local WhatsApp Web version cache, a cooldown between
 * failed starts, a ready timeout, and pairing by phone-number code as well as
 * by QR (with the same library patch, see patch-wweb-pairing-defer.cjs).
 *
 *   GET  /status                 {senders: {id: {state, qr, pairingCode, me, since, error}}}
 *   GET  /status?sender=ID       one sender's state (state: starting | qr | ready | disconnected)
 *   POST /senders {id}           add a sender and start its session (a QR follows)
 *   DELETE /senders/ID           unlink, stop and forget a sender (never 'default')
 *   POST /send {sender?, to, text, pdfB64?, filename?} → {id} | 422 not_on_whatsapp
 *   GET  /events?after=N         {events:[{seq, sender, type, id?, ack?, from?, at}], last}
 *   POST /logout {sender?}       unlink that device; a fresh QR follows
 *   POST /pair {sender?, phone}  link by phone number instead: an 8-character
 *                                code to type in WhatsApp → Linked devices →
 *                                Link with phone number
 */
import { createServer } from 'node:http';
import { mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import QRCode from 'qrcode';
import wweb from 'whatsapp-web.js';

const { Client, LocalAuth, MessageMedia } = wweb;

const PORT = Number(process.env.PORT ?? 8095);
const DATA = process.env.WA_DATA ?? '/data';
const SENDERS_DIR = path.join(DATA, 'senders');
const WEB_CACHE_DIR = path.join(DATA, '.wwebjs_cache');
const DEFAULT = 'default';
const SENDER_ID = /^[a-z0-9][a-z0-9-]{0,30}$/;
/** As the Listec bots: wait this long after a failed start before the next. */
const RETRY_COOLDOWN_MS = 25_000;
/** WhatsApp Web that has not come up in two minutes is not going to. */
const READY_TIMEOUT_MS = 120_000;

/* ------------------------------------------------------------ events ---- */

/** Recent events for the API to collect: delivery acks and opt-out replies. */
const events = [];
let seq = 0;
function pushEvent(e) {
  events.push({ seq: ++seq, at: new Date().toISOString(), ...e });
  if (events.length > 4000) events.splice(0, events.length - 4000);
}

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ----------------------------------------------------------- session ---- */

class Session {
  constructor(id) {
    this.id = id;
    this.state = { state: 'starting', qr: null, pairingCode: null, me: null, since: new Date().toISOString(), error: null };
    this.client = null;
    this.starting = false;
    this.stopped = false;
    /** Set by /pair: the next start links by phone-number code, not QR. */
    this.pairPhone = null;
    this.readyTimer = null;
    this.restartTimer = null;
  }

  /** The default keeps the single-session layout; others nest under senders/. */
  get root() { return this.id === DEFAULT ? DATA : path.join(SENDERS_DIR, this.id); }
  get authDir() { return path.join(this.root, '.wwebjs_auth'); }
  get clientId() { return this.id === DEFAULT ? 'infinity-reports' : `infinity-${this.id}`; }
  get ready() { return this.state.state === 'ready' && !!this.client; }

  setState(s, extra = {}) { Object.assign(this.state, { state: s, since: new Date().toISOString() }, extra); }
  log(...a) { console.log(`[${this.id}]`, ...a); }
  warn(...a) { console.warn(`[${this.id}]`, ...a); }

  async start() {
    if (this.starting || this.stopped) return;
    this.starting = true;
    try {
      await mkdir(this.authDir, { recursive: true });
      await clearLocks(this.authDir);
      this.setState('starting', { qr: null, pairingCode: null, error: null });
      const options = {
        authStrategy: new LocalAuth({ dataPath: this.authDir, clientId: this.clientId }),
        webVersionCache: { type: 'local', path: WEB_CACHE_DIR },
        puppeteer: {
          headless: true,
          args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
        },
      };
      if (this.pairPhone) options.pairWithPhoneNumber = { phoneNumber: this.pairPhone, showNotification: true };
      const client = new Client(options);
      this.client = client;

      clearTimeout(this.readyTimer);
      this.readyTimer = setTimeout(() => {
        if (this.state.state !== 'ready' && this.state.state !== 'qr' && !this.state.pairingCode) {
          this.warn('ready timeout; restarting');
          this.setState('disconnected', { error: 'WhatsApp Web did not finish loading.' });
          void this.restart(RETRY_COOLDOWN_MS);
        }
      }, READY_TIMEOUT_MS);

      client.on('code', (code) => this.setState('qr', { qr: null, pairingCode: code, me: null }));
      client.on('qr', async (qr) => {
        if (this.pairPhone) return;
        this.setState('qr', { qr: await QRCode.toDataURL(qr, { margin: 1, width: 320 }), pairingCode: null, me: null });
      });
      client.on('authenticated', () => {
        this.log('authenticated');
        this.setState('starting', { qr: null, pairingCode: null });
        // Linked, but WhatsApp Web can hang on its first sync without ever
        // saying ready. Give it three minutes, then start again from the
        // saved session, which normally comes straight up.
        clearTimeout(this.readyTimer);
        this.readyTimer = setTimeout(() => {
          if (this.state.state !== 'ready') {
            this.warn('authenticated but not ready; restarting from the saved session');
            void this.restart(0);
          }
        }, 180_000);
      });
      client.on('loading_screen', (percent, message) => this.log(`loading ${percent}% ${message ?? ''}`));
      client.on('change_state', (s) => this.log(`state ${s}`));
      client.on('auth_failure', (m) => {
        this.setState('disconnected', { error: `auth failure: ${m}` });
        void this.restart(RETRY_COOLDOWN_MS);
      });
      client.on('ready', () => {
        const w = client.info?.wid;
        this.pairPhone = null;
        clearTimeout(this.readyTimer);
        this.setState('ready', { qr: null, pairingCode: null, error: null, me: { number: w?.user ?? null, name: client.info?.pushname ?? null } });
        this.log(`ready as ${w?.user}`);
      });
      client.on('disconnected', (reason) => {
        this.warn(`disconnected: ${reason}`);
        this.setState('disconnected', { error: String(reason), me: null });
        // Unlinked from the phone, or the session dropped: start again, which
        // either restores the session or shows a fresh QR.
        void this.restart(RETRY_COOLDOWN_MS);
      });
      // 1 sent (server), 2 delivered, 3 read, 4 played; -1 error.
      client.on('message_ack', (msg, ack) => {
        if (msg.fromMe) pushEvent({ sender: this.id, type: 'ack', id: msg.id._serialized, ack });
      });
      // "STOP" from a patient: the API records the opt-out and sends nothing
      // more to that number, from any sender.
      client.on('message', (msg) => {
        const body = (msg.body ?? '').trim().toUpperCase();
        if (['STOP', 'UNSUBSCRIBE', 'STOP REPORTS'].includes(body)) {
          pushEvent({ sender: this.id, type: 'optout', from: String(msg.from ?? '').replace(/@.*$/, '') });
        }
      });

      await client.initialize();
    } catch (e) {
      console.error(`[${this.id}] start failed:`, e);
      this.setState('disconnected', { error: String(e?.message ?? e) });
      void this.restart(RETRY_COOLDOWN_MS);
    } finally {
      this.starting = false;
    }
  }

  async restart(delayMs = 0) {
    clearTimeout(this.restartTimer);
    const old = this.client;
    this.client = null;
    try { await old?.destroy(); } catch { /* already gone */ }
    if (this.stopped) return;
    this.restartTimer = setTimeout(() => void this.start(), delayMs);
  }

  /** Unlink the device and come back with a fresh QR. */
  async logout() {
    try { await this.client?.logout(); } catch (e) { this.warn('logout:', e?.message ?? e); }
    await rm(this.authDir, { recursive: true, force: true }).catch(() => {});
    this.pairPhone = null;
    void this.restart();
  }

  /** Link by phone-number code instead of QR. */
  async pair(phone) {
    this.pairPhone = phone;
    await rm(this.authDir, { recursive: true, force: true }).catch(() => {});
    void this.restart();
  }

  /** Stop for good and forget the session on disk. */
  async destroy() {
    this.stopped = true;
    clearTimeout(this.readyTimer);
    clearTimeout(this.restartTimer);
    try { await this.client?.logout(); } catch { /* may never have linked */ }
    try { await this.client?.destroy(); } catch { /* already gone */ }
    this.client = null;
    if (this.id !== DEFAULT) await rm(this.root, { recursive: true, force: true }).catch(() => {});
  }

  async send({ to, text, pdfB64, filename }) {
    const client = this.client;
    const id = await client.getNumberId(to);
    if (!id) return { status: 422, body: { error: 'not_on_whatsapp' } };
    const chatId = id._serialized;
    // A beat of "typing…" before each message, as a person would.
    try {
      const chat = await client.getChatById(chatId);
      await chat.sendStateTyping();
      await sleep(1500 + Math.random() * 2500);
      await chat.clearState();
    } catch { /* a new chat may not exist yet; sending creates it */ }
    // sendSeen off: marking the chat read before sending is a step current
    // WhatsApp Web breaks ("Data passed to getter must include an id
    // property"), and a report sender has nothing to mark read anyway.
    // waitUntilMsgSent: without it the library looks the message up before
    // WhatsApp Web has finished uploading the PDF, finds nothing, and
    // returns nothing — for a message that may well have gone.
    const opts = { sendSeen: false, waitUntilMsgSent: true };
    let msg;
    if (pdfB64) {
      const media = new MessageMedia('application/pdf', pdfB64, filename || 'Report.pdf');
      msg = await client.sendMessage(chatId, media, { ...opts, caption: text || undefined, sendMediaAsDocument: true });
    } else {
      msg = await client.sendMessage(chatId, String(text ?? ''), opts);
    }
    const msgId = msg?.id?._serialized ?? null;
    this.log(`sent to ${to.slice(0, 4)}…${to.slice(-2)} pdf=${pdfB64 ? 'yes' : 'no'} confirmed=${msgId ? 'yes' : 'no'}`);
    // Unconfirmed is still "sent" to the caller: the send ran without an
    // error, and retrying could deliver the report twice.
    return { status: 200, body: { id: msgId, unconfirmed: !msgId } };
  }

  /** Where a send to this number would get stuck — sends nothing. */
  async diag(to) {
    const client = this.client;
    const id = await client.getNumberId(to);
    const chatId = id?._serialized ?? null;
    const probe = chatId ? await client.pupPage.evaluate(async (cid) => {
      const out = {};
      try {
        const wid = window.require('WAWebWidFactory').createWid(cid);
        out.wid = String(wid);
        out.inCollection = !!window.require('WAWebCollections').Chat.get(wid);
        const r = await window.require('WAWebFindChatAction').findOrCreateLatestChat(wid);
        out.chat = r?.chat ? String(r.chat.id?._serialized ?? r.chat.id) : null;
        out.getChat = !!(await window.WWebJS.getChat(cid, { getAsModel: false }));
        const msgs = r?.chat?.msgs?.getModelsArray?.() ?? [];
        out.sentByUs = msgs.filter((m) => m.id?.fromMe).slice(-10)
          .map((m) => ({ type: m.type, ack: m.ack, at: m.t, file: m.filename ?? null }));
      } catch (e) { out.error = String(e?.message ?? e); }
      return out;
    }, chatId) : null;
    return { to, chatId, probe };
  }
}

const sessions = new Map();
function addSession(id) {
  if (sessions.has(id)) return sessions.get(id);
  const s = new Session(id);
  sessions.set(id, s);
  void s.start();
  return s;
}
const senderOf = (raw) => {
  const id = String(raw ?? DEFAULT).trim().toLowerCase() || DEFAULT;
  return SENDER_ID.test(id) ? sessions.get(id) ?? null : null;
};
const statusOf = (s) => ({ ...s.state });

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

function reply(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) });
  res.end(s);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && url.pathname === '/status') {
      if (url.searchParams.has('sender')) {
        const s = senderOf(url.searchParams.get('sender'));
        return s ? reply(res, 200, statusOf(s)) : reply(res, 404, { error: 'no_such_sender' });
      }
      return reply(res, 200, { senders: Object.fromEntries([...sessions].map(([id, s]) => [id, statusOf(s)])) });
    }

    if (req.method === 'GET' && url.pathname === '/events') {
      const after = Number(url.searchParams.get('after') ?? 0);
      return reply(res, 200, { events: events.filter((e) => e.seq > after), last: seq });
    }

    if (req.method === 'POST' && url.pathname === '/senders') {
      const b = await readJson(req);
      const id = String(b.id ?? '').trim().toLowerCase();
      if (!SENDER_ID.test(id)) return reply(res, 400, { error: 'bad_id' });
      const s = addSession(id);
      return reply(res, 200, { id, ...statusOf(s) });
    }

    const del = req.method === 'DELETE' && url.pathname.match(/^\/senders\/([a-z0-9-]+)$/);
    if (del) {
      const id = del[1];
      if (id === DEFAULT) return reply(res, 400, { error: 'default_is_permanent' });
      const s = sessions.get(id);
      if (!s) return reply(res, 404, { error: 'no_such_sender' });
      sessions.delete(id);
      await s.destroy();
      return reply(res, 200, { ok: true });
    }

    if (req.method === 'GET' && url.pathname === '/diag') {
      const s = senderOf(url.searchParams.get('sender'));
      if (!s) return reply(res, 404, { error: 'no_such_sender' });
      if (!s.ready) return reply(res, 503, { error: 'not_ready' });
      const to = String(url.searchParams.get('to') ?? '').replace(/\D/g, '');
      return reply(res, 200, await s.diag(to));
    }

    if (req.method === 'POST' && url.pathname === '/send') {
      const b = await readJson(req);
      const s = senderOf(b.sender);
      if (!s) return reply(res, 404, { error: 'no_such_sender' });
      if (!s.ready) return reply(res, 503, { error: 'not_ready', state: s.state.state });
      const to = String(b.to ?? '').replace(/\D/g, '');
      if (!/^\d{10,15}$/.test(to)) return reply(res, 400, { error: 'bad_number' });
      const r = await s.send({ to, text: b.text, pdfB64: b.pdfB64, filename: b.filename });
      return reply(res, r.status, r.body);
    }

    if (req.method === 'POST' && url.pathname === '/logout') {
      const b = await readJson(req);
      const s = senderOf(b.sender);
      if (!s) return reply(res, 404, { error: 'no_such_sender' });
      await s.logout();
      return reply(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/pair') {
      const b = await readJson(req);
      const s = senderOf(b.sender);
      if (!s) return reply(res, 404, { error: 'no_such_sender' });
      let d = String(b.phone ?? '').replace(/\D/g, '');
      if (d.length === 10) d = '91' + d;
      if (!/^\d{11,15}$/.test(d)) return reply(res, 400, { error: 'bad_number' });
      if (s.ready) return reply(res, 409, { error: 'already_linked' });
      await s.pair(d);
      return reply(res, 200, { ok: true });
    }

    return reply(res, 404, { error: 'not found' });
  } catch (e) {
    console.error(`${req.method} ${url.pathname} failed:`, e);
    return reply(res, 500, { error: String(e?.message ?? e) });
  }
});

/* The default sender, then every sender left on disk from before. */
addSession(DEFAULT);
try {
  for (const e of await readdir(SENDERS_DIR, { withFileTypes: true })) {
    if (e.isDirectory() && SENDER_ID.test(e.name) && e.name !== DEFAULT) addSession(e.name);
  }
} catch { /* no senders yet */ }

server.listen(PORT, () => console.log(`whatsapp sidecar on ${PORT}, senders: ${[...sessions.keys()].join(', ')}`));

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    server.close();
    for (const s of sessions.values()) { try { await s.client?.destroy(); } catch { /* shutting down anyway */ } }
    process.exit(0);
  });
}
