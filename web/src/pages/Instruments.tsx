import { useCallback, useEffect, useState } from 'react';
import { Pager } from '../components/Pager';
import { api, ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { fmtDateTime } from '../lib/format';
import { ImportResults } from './ImportResults';

interface Instrument {
  id: number;
  code: string;
  name: string;
  isActive: boolean;
  apiKeyHint: string | null;
  lastSeenAt: string | null;
  pending: number;
  applied24H: number;
}

interface InboxMessage {
  id: number;
  instrumentCode: string | null;
  sid: string | null;
  testCode: string | null;
  value: string | null;
  unit: string | null;
  parseStatus: string;
  matchStatus: string;
  failureReason: string | null;
  receivedAt: string;
  attempts: number;
  source: string;
  sourceName: string | null;
}

const STATUSES = ['needs attention', 'applied', 'unmatched', 'rejected', 'duplicate'] as const;

export function Instruments() {
  const { can } = useAuth();
  const [instruments, setInstruments] = useState<Instrument[]>([]);
  const [inbox, setInbox] = useState<InboxMessage[]>([]);
  const [status, setStatus] = useState<string>('needs attention');
  const [instrumentId, setInstrumentId] = useState<number | ''>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(100);
  const [total, setTotal] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const p = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
      // The default (no status) is the "needs attention" set the procedure
      // defines — pending, unmatched and rejected.
      if (status !== 'needs attention') p.set('status', status);
      if (instrumentId !== '') p.set('instrumentId', String(instrumentId));

      const [list, result] = await Promise.all([
        api.get<Instrument[]>('/api/instruments/'),
        api.get<{ messages: InboxMessage[]; totalCount: number; pageCount: number }>(
          `/api/instruments/inbox?${p}`),
      ]);
      setInstruments(list);
      setInbox(result.messages);
      setTotal(result.totalCount);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the instrument inbox.');
    } finally {
      setLoading(false);
    }
  }, [status, instrumentId, page, pageSize]);

  useEffect(() => { void load(); }, [load]);

  // Changing the status filter changes how many pages exist.
  useEffect(() => { setPage(1); }, [status, instrumentId, pageSize]);

  async function replay(id: number) {
    setBusyId(id); setError(null); setNotice(null);
    try {
      const r = await api.post<{ matchStatus: string; failureReason: string | null }>(
        `/api/instruments/inbox/${id}/replay`);
      setNotice(r.matchStatus === 'applied'
        ? 'Replayed and applied to the result.'
        : `Replayed, still ${r.matchStatus}${r.failureReason ? `: ${r.failureReason}` : ''}.`);
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Replay failed.');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="page">
      <div className="page__head">
        <div>
          <h1 className="page__title">Instruments</h1>
          <p className="page__sub">Analyser results awaiting a match, and the benches that sent them</p>
        </div>
        <div className="row" style={{ marginLeft: 'auto' }}>
          <button className="btn btn--primary btn--sm" onClick={() => setShowImport(true)}>
            Import from file
          </button>
          {can('user:manage') && (
            <button className="btn btn--ghost btn--sm" onClick={() => setShowAdd(true)}>
              Register analyser
            </button>
          )}
        </div>
      </div>

      {error && <div className="alert alert--error" style={{ marginBottom: '.8rem' }}>{error}</div>}
      {notice && <div className="alert alert--ok" style={{ marginBottom: '.8rem' }}>{notice}</div>}

      <div className="grid2" style={{ marginBottom: '1.1rem' }}>
        {instruments.map((i) => (
          <div key={i.id} className="card" style={{ padding: '.8rem 1rem' }}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <div>
                <b className="mono" style={{ fontSize: '.86rem' }}>{i.code}</b>
                <div className="muted" style={{ fontSize: '.74rem' }}>{i.name}</div>
              </div>
              <span className={`badge ${i.isActive ? 'badge--infinity' : 'badge--lis'}`}>
                {i.isActive ? 'active' : 'disabled'}
              </span>
            </div>
            <div className="row" style={{ gap: '.9rem', marginTop: '.5rem', fontSize: '.74rem' }}>
              <span className={i.pending > 0 ? '' : 'muted'} style={i.pending > 0 ? { color: 'var(--danger)' } : undefined}>
                <b>{i.pending}</b> need attention
              </span>
              <span className="muted"><b>{i.applied24H}</b> applied 24h</span>
              <span className="muted" style={{ marginLeft: 'auto' }}>
                {i.lastSeenAt ? `seen ${fmtDateTime(i.lastSeenAt)}` : 'never seen'}
              </span>
            </div>
          </div>
        ))}
        {instruments.length === 0 && !loading && (
          <div className="card">
            <p className="muted" style={{ fontSize: '.84rem', lineHeight: 1.6 }}>
              No analysers registered yet. Register one to get an API key, then point a driver at{' '}
              <code>POST /api/instruments/results</code>.
            </p>
          </div>
        )}
      </div>

      <div className="row" style={{ marginBottom: '.7rem', flexWrap: 'wrap' }}>
        <select className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
          {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select className="input" value={instrumentId}
                onChange={(e) => setInstrumentId(e.target.value === '' ? '' : Number(e.target.value))}>
          <option value="">All analysers</option>
          {instruments.map((i) => <option key={i.id} value={i.id}>{i.code}</option>)}
        </select>
        <button className="btn btn--ghost btn--sm" onClick={() => void load()}>Refresh</button>
      </div>

      {loading ? (
        <div className="center"><div className="spinner" /><span className="muted">Loading inbox…</span></div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Received</th>
                <th>Analyser</th>
                <th>SID</th>
                <th>Test</th>
                <th>Value</th>
                <th>Status</th>
                <th>Reason</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {inbox.map((m) => (
                <tr key={m.id}>
                  <td className="muted" style={{ fontSize: '.76rem', whiteSpace: 'nowrap' }}>{fmtDateTime(m.receivedAt)}</td>
                  <td style={{ fontSize: '.78rem' }}>
                    {m.source === 'import'
                      ? <span title={m.sourceName ?? 'file import'}>
                          <span className="badge badge--role">file</span>
                        </span>
                      : <span className="mono">{m.instrumentCode ?? '—'}</span>}
                  </td>
                  <td className="mono">{m.sid ?? <span className="muted">—</span>}</td>
                  <td className="mono" style={{ fontSize: '.78rem' }}>{m.testCode ?? '—'}</td>
                  <td className="mono">{m.value ?? '—'} <span className="muted">{m.unit}</span></td>
                  <td><MatchBadge status={m.matchStatus} /></td>
                  <td className="muted" style={{ fontSize: '.76rem', maxWidth: 280 }}>{m.failureReason ?? '—'}</td>
                  <td style={{ textAlign: 'right' }}>
                    {m.matchStatus !== 'applied' && m.matchStatus !== 'duplicate' && (
                      <button className="btn btn--ghost btn--sm" disabled={busyId === m.id} onClick={() => void replay(m.id)}>
                        {busyId === m.id ? '…' : 'Replay'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {inbox.length === 0 && (
                <tr>
                  <td colSpan={8} className="muted" style={{ textAlign: 'center', padding: '2rem' }}>
                    {status === 'needs attention' ? 'Nothing needs attention.' : 'No messages with this status.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>

          <Pager page={page} pageSize={pageSize} total={total} noun="message"
                 sizes={[50, 100, 250, 500]} onPage={setPage} onPageSize={setPageSize} />
        </div>
      )}

      <p className="muted" style={{ fontSize: '.72rem', marginTop: '1rem', lineHeight: 1.6 }}>
        Instrument results are never auto-authorised. A matched reading is written with the value set and
        authorisation left off, awaiting a human on the worksheet. Unmatched messages stay here and can be
        replayed once the sample is registered or the test added to the order.
      </p>

      {showAdd && <RegisterInstrument onClose={() => setShowAdd(false)} onDone={() => { setShowAdd(false); void load(); }} />}
      {showImport && <ImportResults onClose={() => setShowImport(false)} onApplied={() => void load()} />}
    </div>
  );
}

function MatchBadge({ status }: { status: string }) {
  const kind = status === 'applied' ? 'infinity'
    : status === 'unmatched' || status === 'rejected' ? 'telo'
    : 'lis';
  return <span className={`badge badge--${kind}`}>{status}</span>;
}

/** Generates the key client-side and shows it exactly once — the API stores only a hash. */
function RegisterInstrument({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [apiKey] = useState(() => {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    return btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, '').slice(0, 32);
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function submit() {
    setBusy(true); setError(null);
    try {
      await api.post('/api/instruments/', { code: code.trim(), name: name.trim(), apiKey, isActive: true });
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not register the analyser.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={saved ? onDone : onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal__title">{saved ? 'Analyser registered' : 'Register an analyser'}</h2>

        {error && <div className="alert alert--error">{error}</div>}

        {saved ? (
          <>
            <div className="alert alert--ok">
              Copy this key now. Only a hash is stored, so it cannot be shown again — losing it means rotating
              the key, not recovering it.
            </div>
            <div className="field">
              <label htmlFor="k">API key for {code}</label>
              <input id="k" className="input mono" readOnly value={apiKey} onFocus={(e) => e.currentTarget.select()} />
            </div>
            <p className="muted" style={{ fontSize: '.74rem', lineHeight: 1.6 }}>
              The driver sends it as <code>X-Instrument-Key</code>, with <code>X-Instrument-Code: {code}</code>,
              to <code>POST /api/instruments/results</code>.
            </p>
            <div className="modal__actions"><button className="btn btn--primary" onClick={onDone}>Done</button></div>
          </>
        ) : (
          <>
            <div className="field">
              <label htmlFor="i-code">Code</label>
              <input id="i-code" value={code} maxLength={20} onChange={(e) => setCode(e.target.value)}
                     placeholder="COBAS-C311-1" autoFocus />
              <span className="muted" style={{ fontSize: '.7rem' }}>
                Max 20 characters — it is written into the LIS machine_name column, which is that wide.
              </span>
            </div>
            <div className="field">
              <label htmlFor="i-name">Name</label>
              <input id="i-name" value={name} maxLength={200} onChange={(e) => setName(e.target.value)}
                     placeholder="Roche Cobas c311 — Biochemistry" />
            </div>
            <div className="modal__actions">
              <button className="btn btn--ghost" onClick={onClose} disabled={busy}>Cancel</button>
              <button className="btn btn--primary" onClick={() => void submit()} disabled={busy || !code.trim() || !name.trim()}>
                {busy ? 'Registering…' : 'Register'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
