import { useCallback, useEffect, useState } from 'react';
import {
  whatsappApi,
  type WaConfig,
  type WaMessageRow,
  type WaOverview,
  type WaStatus,
} from '../api/client';

/**
 * Admin → WhatsApp: patient reports through a linked WhatsApp Web number.
 *
 * The number is linked the way WhatsApp Web is — the phone's Linked devices →
 * scan this QR (or "Link with phone number" and type the code shown) — the
 * same pairing the lab's Listec automation bots use. Then:
 *   · Sending on/off — the master switch; while off, only a test goes.
 *   · Automatic — visits whose every sample is released go by themselves,
 *     for the clients listed (or all). Prod only.
 *   · Allowlist — only these numbers; required on staging, which reads real
 *     patients.
 *   · Pacing — a random gap between messages, a daily cap and quiet hours,
 *     because a linked personal number that sends too fast gets banned.
 * The log shows every message, with delivered / read ticks from WhatsApp.
 */

const STATUS_LABEL: Record<WaStatus, string> = {
  queued: 'Queued', sending: 'Sending', sent: 'Sent', delivered: 'Delivered', read: 'Read', failed: 'Failed', skipped: 'Skipped',
};
const STATUS_CLASS: Record<WaStatus, string> = {
  queued: 'wa-badge', sending: 'wa-badge', sent: 'wa-badge wa-badge--ok', delivered: 'wa-badge wa-badge--ok',
  read: 'wa-badge wa-badge--read', failed: 'wa-badge wa-badge--bad', skipped: 'wa-badge wa-badge--warn',
};

const lines = (s: string) => s.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);

export function WhatsAppSettingsPage() {
  const [data, setData] = useState<WaOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await whatsappApi.overview());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load WhatsApp settings.');
    }
  }, []);

  // Poll: fast while linking (the QR rotates, the code expires), slow once linked.
  const state = data?.status?.state;
  useEffect(() => {
    void load();
    const t = window.setInterval(() => void load(), state === 'ready' ? 15000 : 3000);
    return () => window.clearInterval(t);
  }, [load, state]);

  const run = async (what: () => Promise<string | void>) => {
    setBusy(true); setError(null); setNotice(null);
    try {
      const said = await what();
      if (said) setNotice(said);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  if (data && !data.configured) {
    return (
      <div className="page">
        <h1 className="page__title">WhatsApp</h1>
        <div className="alert alert--error" style={{ marginTop: '1rem' }}>
          WhatsApp is not configured on this server (WhatsApp__Instance is unset).
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <h1 className="page__title">
        WhatsApp {data?.instance && data.instance !== 'prod' && <span className="wa-badge wa-badge--warn" style={{ verticalAlign: 'middle' }}>{data.instance}</span>}
      </h1>
      <p className="muted" style={{ marginTop: '.2rem', maxWidth: 860 }}>
        Patient reports on WhatsApp from a linked number. Each message carries the patient’s copy of the report as a PDF —
        released samples only, never one on balance hold — on the centre’s own letterhead when it has one.
      </p>

      {error && <div className="alert alert--error" style={{ marginTop: '1rem' }}>{error}</div>}
      {notice && <div className="alert" style={{ marginTop: '1rem' }}>{notice}</div>}

      {!data ? <p className="muted" style={{ marginTop: '1rem' }}>Loading…</p> : (
        <div className="wa">
          <Connection data={data} busy={busy} run={run} />
          {data.settings && (
            <Sending key={JSON.stringify(data.settings) + (data.clients ?? []).join(',')} data={data} busy={busy} run={run} />
          )}
          <TestSend busy={busy} run={run} />
          <Log />
        </div>
      )}
    </div>
  );
}

type Run = (what: () => Promise<string | void>) => Promise<void>;

/* ---- linking the number -------------------------------------------------- */

function Connection({ data, busy, run }: { data: WaOverview; busy: boolean; run: Run }) {
  const s = data.status;
  const [pairPhone, setPairPhone] = useState('');
  if (!s) return null;
  return (
    <section className="card wa__card">
      <h2 className="wa__h">Linked number</h2>
      {s.state === 'ready' ? (
        <div className="wa__row">
          <span className="wa__dot wa__dot--on" aria-hidden />
          <span>
            Linked as <b>+{s.me?.number}</b>{s.me?.name ? ` (${s.me.name})` : ''}
            <span className="muted" style={{ display: 'block', fontSize: '.78rem' }}>
              Keep this phone on and connected: WhatsApp Web stops if the phone is offline for about two weeks.
            </span>
          </span>
          <button type="button" className="btn btn--danger btn--sm" disabled={busy} style={{ marginLeft: 'auto' }}
                  onClick={() => { if (window.confirm('Unlink this WhatsApp number? Sending stops until a number is linked again.')) void run(async () => { await whatsappApi.logout(); return 'Unlinked. Link a number again to resume.'; }); }}>
            Unlink
          </button>
        </div>
      ) : s.state === 'qr' ? (
        <div className="wa__link">
          {s.pairingCode ? (
            <div>
              <p className="muted" style={{ margin: 0 }}>On the phone: WhatsApp → Linked devices → Link a device → <b>Link with phone number instead</b>, and type:</p>
              <p className="wa__code">{s.pairingCode.slice(0, 4)}-{s.pairingCode.slice(4)}</p>
            </div>
          ) : s.qr ? (
            <img src={s.qr} alt="WhatsApp link QR code" className="wa__qr" />
          ) : null}
          <div className="wa__steps">
            <p style={{ marginTop: 0 }}><b>Link the number that will send reports</b></p>
            <ol className="muted">
              <li>Open WhatsApp on that phone.</li>
              <li>Settings → <b>Linked devices</b> → <b>Link a device</b>.</li>
              <li>Scan this code. It refreshes by itself.</li>
            </ol>
            <p className="muted" style={{ fontSize: '.8rem' }}>Can’t scan? Link with the phone number instead:</p>
            <div className="wa__row">
              <input className="input input--sm" style={{ maxWidth: 180 }} placeholder="98xxxxxxxx" inputMode="tel"
                     value={pairPhone} onChange={(e) => setPairPhone(e.target.value)} aria-label="Number to link" />
              <button type="button" className="btn btn--ghost btn--sm" disabled={busy || !pairPhone.trim()}
                      onClick={() => void run(async () => { await whatsappApi.pair(pairPhone); return 'Asking WhatsApp for a pairing code — it appears here in a few seconds.'; })}>
                Get pairing code
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="wa__row">
          <span className={`wa__dot${s.state === 'starting' ? ' wa__dot--wait' : ''}`} aria-hidden />
          <span>
            {s.state === 'starting' ? 'Starting WhatsApp Web…' : s.state === 'unreachable' ? 'The WhatsApp service is not running.' : 'Disconnected — reconnecting.'}
            {s.error && <span className="muted" style={{ display: 'block', fontSize: '.78rem' }}>{s.error}</span>}
          </span>
        </div>
      )}
      <p className="muted wa__stats">
        Today <b>{data.sentToday ?? 0}</b> sent · last 24 h: {Object.entries(data.counts ?? {}).map(([k, v]) => `${v} ${STATUS_LABEL[k as WaStatus]?.toLowerCase() ?? k}`).join(' · ') || 'nothing yet'}
      </p>
    </section>
  );
}

/* ---- the switches ---------------------------------------------------------- */

function Sending({ data, busy, run }: { data: WaOverview; busy: boolean; run: Run }) {
  const cfg = data.settings!;
  const [draft, setDraft] = useState<WaConfig>(cfg);
  const [allow, setAllow] = useState(cfg.allowlist.map((p) => p.replace(/^91/, '')).join('\n'));
  const [clients, setClients] = useState((data.clients ?? []).join(', '));
  const set = (p: Partial<WaConfig>) => setDraft((d) => ({ ...d, ...p }));

  const toggle = (on: boolean, label: string, onClick: () => void, disabled = false, title?: string) => (
    <button type="button" role="switch" aria-checked={on} aria-label={label} title={title}
            className={`toggle${on ? ' toggle--on' : ''}`} disabled={busy || disabled}
            style={{ flex: 'none', marginTop: '.15rem' }} onClick={onClick} />
  );

  const saveAll = () => run(async () => {
    const allowlist = lines(allow);
    await whatsappApi.save({
      caption: draft.caption, minGapSeconds: draft.minGapSeconds, maxGapSeconds: draft.maxGapSeconds,
      dailyCap: draft.dailyCap, quietFrom: draft.quietFrom, quietTo: draft.quietTo, allowlist,
    });
    const r = await whatsappApi.setClients(lines(clients).map((c) => c.toUpperCase()));
    return r.unknown.length ? `Saved. Not client codes, so left out: ${r.unknown.join(', ')}.` : 'Saved.';
  });

  return (
    <section className="card wa__card">
      <h2 className="wa__h">Sending</h2>

      <div className="wa__switch">
        {toggle(cfg.enabled, 'Send reports on WhatsApp', () => void run(async () => {
          await whatsappApi.save({ enabled: !cfg.enabled });
          return !cfg.enabled ? 'Sending is on.' : 'Sending is off. Queued messages wait; only a test goes.';
        }))}
        <span>
          <b>Send reports on WhatsApp</b>
          <span className="muted wa__note">The master switch. Off, nothing goes to patients — manual or automatic — and queued messages wait.</span>
        </span>
      </div>

      <div className="wa__switch">
        {toggle(cfg.auto, 'Send automatically', () => void run(async () => {
          await whatsappApi.save({ auto: !cfg.auto });
          return !cfg.auto ? 'Automatic sending is on: visits released from now on go by themselves.' : 'Automatic sending is off.';
        }), !data.autoCapable, data.autoCapable ? undefined : 'Automatic sending runs on prod only')}
        <span>
          <b>Send automatically when a visit is fully released</b>
          <span className="muted wa__note">
            Every sample of the visit authorised; sent once per visit, starting from when this is switched on (no backlog).
            An amended report is re-sent from the Reporting list.
            {!data.autoCapable && <><br /><b>This server does not send automatically</b> — only prod does.</>}
          </span>
        </span>
      </div>

      <div className="wa__switch">
        {toggle(cfg.allClients, 'Every client', () => void run(async () => {
          await whatsappApi.save({ allClients: !cfg.allClients });
          return !cfg.allClients ? 'Automatic sending covers every client.' : 'Automatic sending covers only the listed clients.';
        }))}
        <span>
          <b>Every client’s patients</b>
          <span className="muted wa__note">Off: only the clients listed below get automatic sends. Manual sends work for anyone.</span>
        </span>
      </div>

      <div className="wa__grid">
        <label className="wa__field">
          <span>Clients on automatic sending</span>
          <textarea className="input input--sm" rows={3} value={clients} disabled={cfg.allClients}
                    placeholder="MDCARE, HR0121 …" onChange={(e) => setClients(e.target.value)} />
        </label>
        <label className="wa__field">
          <span>Allowlist {data.requiresAllowlist ? '(required here)' : '(optional)'}</span>
          <textarea className="input input--sm" rows={3} value={allow} inputMode="tel"
                    placeholder="98xxxxxxxx, one per line" onChange={(e) => setAllow(e.target.value)} />
          <small className="muted">
            {data.requiresAllowlist
              ? 'This server reads real patients’ numbers, so it sends only to these.'
              : 'Leave empty to send to patients. Put your own number here for a first run.'}
          </small>
        </label>
        <label className="wa__field wa__field--wide">
          <span>Message with the report</span>
          <textarea className="input input--sm" rows={4} value={draft.caption} maxLength={1000}
                    onChange={(e) => set({ caption: e.target.value })} />
          <small className="muted">{'{name}'} and {'{pid}'} are filled in.</small>
        </label>
        <label className="wa__field">
          <span>Gap between messages (seconds)</span>
          <span className="wa__row">
            <input className="input input--sm" type="number" min={15} value={draft.minGapSeconds}
                   onChange={(e) => set({ minGapSeconds: Number(e.target.value) })} aria-label="Shortest gap" />
            <span className="muted">to</span>
            <input className="input input--sm" type="number" min={15} value={draft.maxGapSeconds}
                   onChange={(e) => set({ maxGapSeconds: Number(e.target.value) })} aria-label="Longest gap" />
          </span>
        </label>
        <label className="wa__field">
          <span>Daily cap</span>
          <input className="input input--sm" type="number" min={1} max={1000} value={draft.dailyCap}
                 onChange={(e) => set({ dailyCap: Number(e.target.value) })} />
        </label>
        <label className="wa__field">
          <span>Quiet hours (nothing sent)</span>
          <span className="wa__row">
            <input className="input input--sm" type="time" value={draft.quietFrom} onChange={(e) => set({ quietFrom: e.target.value })} aria-label="Quiet from" />
            <span className="muted">to</span>
            <input className="input input--sm" type="time" value={draft.quietTo} onChange={(e) => set({ quietTo: e.target.value })} aria-label="Quiet to" />
          </span>
        </label>
      </div>
      <div className="wa__row" style={{ marginTop: '.8rem' }}>
        <button type="button" className="btn btn--primary btn--sm" disabled={busy} onClick={() => void saveAll()}>Save</button>
      </div>
    </section>
  );
}

/* ---- a test message ---------------------------------------------------------- */

function TestSend({ busy, run }: { busy: boolean; run: Run }) {
  const [phone, setPhone] = useState('');
  const [sid, setSid] = useState('');
  return (
    <section className="card wa__card">
      <h2 className="wa__h">Send a test</h2>
      <p className="muted" style={{ marginTop: 0, fontSize: '.82rem' }}>
        A text message — or, with a sample ID, that report as a PDF — to one number. Goes even while sending is off, after the
        current pacing gap.
      </p>
      <div className="wa__row">
        <input className="input input--sm" style={{ maxWidth: 170 }} placeholder="98xxxxxxxx" inputMode="tel"
               value={phone} onChange={(e) => setPhone(e.target.value)} aria-label="Test number" />
        <input className="input input--sm" style={{ maxWidth: 150 }} placeholder="Sample ID (optional)"
               value={sid} onChange={(e) => setSid(e.target.value.trim())} aria-label="Sample ID" />
        <button type="button" className="btn btn--ghost btn--sm" disabled={busy || !phone.trim()}
                onClick={() => void run(async () => { const r = await whatsappApi.test(phone, sid); return `Test queued to ${r.phone}. Watch the log below.`; })}>
          Send test
        </button>
      </div>
    </section>
  );
}

/* ---- the log --------------------------------------------------------------------- */

function Log() {
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ rows: WaMessageRow[]; total: number; size: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setData(await whatsappApi.messages({ status, q, page })); setErr(null); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Could not load the log.'); }
  }, [status, q, page]);

  useEffect(() => {
    void load();
    const t = window.setInterval(() => void load(), 10000);
    return () => window.clearInterval(t);
  }, [load]);

  const pages = data ? Math.max(1, Math.ceil(data.total / data.size)) : 1;
  return (
    <section className="card wa__card">
      <h2 className="wa__h">Messages</h2>
      <div className="wa__row" style={{ flexWrap: 'wrap', marginBottom: '.6rem' }}>
        <select className="input input--sm" style={{ maxWidth: 160 }} value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} aria-label="Status">
          <option value="">Every status</option>
          {(Object.keys(STATUS_LABEL) as WaStatus[]).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
        </select>
        <input className="input input--sm" style={{ maxWidth: 240 }} placeholder="Search name, PID, SID, client, number"
               value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} aria-label="Search messages" />
        <span className="muted" style={{ fontSize: '.8rem' }}>{data ? `${data.total} message${data.total === 1 ? '' : 's'}` : ''}</span>
      </div>
      {err && <div className="alert alert--error">{err}</div>}
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>When</th><th>Patient</th><th>PID / samples</th><th>Number</th><th>How</th><th>Status</th><th /></tr>
          </thead>
          <tbody>
            {data?.rows.length === 0 && <tr><td colSpan={7} className="muted">Nothing yet.</td></tr>}
            {data?.rows.map((m) => (
              <tr key={m.id}>
                <td className="mono" style={{ whiteSpace: 'nowrap', fontSize: '.78rem' }}>
                  {new Date((m.sentAt ?? m.createdAt) + 'Z').toLocaleString('en-IN', { dateStyle: 'short', timeStyle: 'short' })}
                </td>
                <td>{m.kind === 'test' ? <span className="muted">Test</span> : m.patientName}<span className="muted" style={{ display: 'block', fontSize: '.72rem' }}>{m.clientCode}</span></td>
                <td className="mono" style={{ fontSize: '.78rem' }}>{m.pid ?? '—'}<span className="muted" style={{ display: 'block' }}>{m.sids.join(', ')}</span></td>
                <td className="mono" style={{ fontSize: '.78rem' }}>{m.phone}</td>
                <td style={{ fontSize: '.78rem' }}>{m.trigger === 'auto' ? 'Automatic' : m.trigger === 'manual' ? 'Manual' : 'Test'}</td>
                <td>
                  <span className={STATUS_CLASS[m.status]}>{STATUS_LABEL[m.status]}</span>
                  {m.error && <span className="muted" style={{ display: 'block', fontSize: '.72rem', maxWidth: 260 }}>{m.error}</span>}
                </td>
                <td>
                  {(m.status === 'failed' || m.status === 'skipped') && (
                    <button type="button" className="btn btn--ghost btn--xs"
                            onClick={() => void whatsappApi.retry(m.id).then(load).catch((e) => setErr(e instanceof Error ? e.message : 'Retry failed.'))}>
                      Retry
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pages > 1 && (
        <div className="wa__row" style={{ marginTop: '.6rem' }}>
          <button type="button" className="btn btn--ghost btn--xs" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</button>
          <span className="muted" style={{ fontSize: '.8rem' }}>Page {page} of {pages}</span>
          <button type="button" className="btn btn--ghost btn--xs" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>Next</button>
        </div>
      )}
    </section>
  );
}
