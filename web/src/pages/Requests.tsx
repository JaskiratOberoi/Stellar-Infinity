import { useEffect, useMemo, useState } from 'react';
import { api, csrfHeader } from '../api/client';
import { inr, fmtDateTime } from '../lib/format';
import { InfinityLoader } from '../components/InfinityLoader';
import { useAuth } from '../auth/AuthContext';

/**
 * Requests — the two channels the legacy LIS grants a centre, rebuilt:
 *
 *   Materials — the MRF. A request raised here lands in the LIS's own
 *   inventory tables (status OPEN) and the lab's storekeeper approves and
 *   dispatches it in the legacy app exactly as before; this page then shows
 *   the approved and issued quantities and the docket as they fill in.
 *
 *   Help — a clean ticket: category, subject, detail; the lab's answer comes
 *   back on the same card.
 *
 * The improvements over the legacy forms are deliberate: a searchable
 * catalogue with quantities and a running estimate instead of a bare
 * dropdown; status as a chip on the card instead of a grid column; the whole
 * request's lifecycle readable in one place.
 */

interface CatalogueItem { id: number; name: string; price: number; unit: string | null }
interface MrfLine {
  itemName: string; orderQty: number; approvedQty: number | null; issuedQty: number | null;
  rate: number; docketNumber: string | null; issuedAt: string | null;
}
interface MrfRequest {
  id: number; orderedAt: string | null; status: number; approvedBy: string | null; lines: MrfLine[];
}
interface HelpRequest {
  id: number; mcc: number; clientCode: string | null; category: string; subject: string;
  detail: string | null; status: string; response: string | null; respondedBy: string | null;
  raisedBy: string | null; createdAt: string | null; updatedAt: string | null;
}

/** The LIS's own MRF vocabulary — shown with its spelling corrected. */
const MRF_STATUS: Record<number, { label: string; tone: string }> = {
  1: { label: 'Open', tone: 'open' },
  2: { label: 'Approved', tone: 'progress' },
  3: { label: 'Dispatched', tone: 'done' },
  4: { label: 'Cancelled', tone: 'dead' },
};
const HELP_STATUS: Record<string, { label: string; tone: string }> = {
  open: { label: 'Open', tone: 'open' },
  in_progress: { label: 'In progress', tone: 'progress' },
  closed: { label: 'Closed', tone: 'done' },
};

export function Requests() {
  const { can } = useAuth();
  const isLabAdmin = can('user:manage');

  // The centre this page acts for. A client resolves to its own; a parent
  // with sub-franchises picks among them.
  const [centres, setCentres] = useState<{ id: number; code: string }[]>([]);
  const [mcc, setMcc] = useState<number | null>(null);

  const [catalogue, setCatalogue] = useState<CatalogueItem[]>([]);
  const [basket, setBasket] = useState<Map<number, number>>(new Map());
  const [itemQuery, setItemQuery] = useState('');
  const [mrfs, setMrfs] = useState<MrfRequest[]>([]);
  const [helps, setHelps] = useState<HelpRequest[]>([]);
  const [subject, setSubject] = useState('');
  const [category, setCategory] = useState<'general' | 'technical'>('general');
  const [detail, setDetail] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void api.get<{ rows: { id: number; code: string }[] }>('/api/reports/clients/search')
      .then((r) => {
        if (!live) return;
        const rows = (r.rows ?? []).map((c) => ({ id: c.id, code: c.code }));
        setCentres(rows);
        if (!isLabAdmin && rows.length > 0) setMcc(rows[0].id);
        if (isLabAdmin) setLoading(false);
      })
      .catch(() => { if (live) setError('Could not resolve your centre.'); });
    return () => { live = false; };
  }, [isLabAdmin]);

  async function reload(m: number | null) {
    setLoading(true);
    setError(null);
    try {
      if (m != null) {
        const [cat, list, help] = await Promise.all([
          api.get<{ items: CatalogueItem[] }>('/api/requests/mrf/items'),
          api.get<{ rows: MrfRequest[] }>(`/api/requests/mrf?mcc=${m}`),
          api.get<{ rows: HelpRequest[] }>(`/api/requests/help?mcc=${m}`),
        ]);
        setCatalogue(cat.items);
        setMrfs(list.rows);
        setHelps(help.rows);
      } else if (isLabAdmin) {
        const help = await api.get<{ rows: HelpRequest[] }>('/api/requests/help');
        setHelps(help.rows);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load requests.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void reload(mcc); }, [mcc]); // eslint-disable-line react-hooks/exhaustive-deps

  const filtered = useMemo(() => {
    const q = itemQuery.trim().toLowerCase();
    return q ? catalogue.filter((i) => i.name.toLowerCase().includes(q)) : catalogue;
  }, [catalogue, itemQuery]);

  const estimate = useMemo(() => {
    let t = 0;
    for (const [id, qty] of basket) t += (catalogue.find((c) => c.id === id)?.price ?? 0) * qty;
    return t;
  }, [basket, catalogue]);

  function setQty(id: number, qty: number) {
    setBasket((b) => {
      const next = new Map(b);
      if (qty <= 0) next.delete(id); else next.set(id, qty);
      return next;
    });
  }

  async function submitMrf() {
    if (mcc == null || basket.size === 0) return;
    setBusy(true); setError(null);
    try {
      await api.post('/api/requests/mrf', {
        mcc, items: [...basket].map(([itemId, qty]) => ({ itemId, qty })),
      }, csrfHeader());
      setBasket(new Map());
      setNotice('Material request raised — the lab will approve and dispatch it.');
      await reload(mcc);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The request was not raised.');
    } finally { setBusy(false); }
  }

  async function cancelMrf(id: number) {
    if (mcc == null) return;
    setBusy(true); setError(null);
    try {
      await api.post(`/api/requests/mrf/${id}/cancel`, { mcc }, csrfHeader());
      await reload(mcc);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The request was not cancelled.');
    } finally { setBusy(false); }
  }

  async function submitHelp() {
    if (mcc == null || subject.trim() === '') return;
    setBusy(true); setError(null);
    try {
      await api.post('/api/requests/help', {
        mcc, category, subject: subject.trim(), detail: detail.trim() || null,
      }, csrfHeader());
      setSubject(''); setDetail('');
      setNotice('Help request raised — the lab will get back to you here.');
      await reload(mcc);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The request was not raised.');
    } finally { setBusy(false); }
  }

  async function closeHelp(id: number) {
    if (mcc == null) return;
    setBusy(true);
    try { await api.post(`/api/requests/help/${id}/close`, { mcc }, csrfHeader()); await reload(mcc); }
    finally { setBusy(false); }
  }

  async function respondHelp(id: number, status: string, response: string) {
    setBusy(true);
    try {
      await api.post(`/api/requests/help/${id}/respond`, { status, response: response || null }, csrfHeader());
      await reload(mcc);
    } finally { setBusy(false); }
  }

  return (
    <div className="page">
      <div className="page__head">
        <div>
          <h1 className="page__title">Requests</h1>
          <p className="page__sub">
            {isLabAdmin && mcc == null
              ? 'Help requests from every centre — answer them here.'
              : 'Materials from the lab, and help when something is wrong.'}
          </p>
        </div>
        {centres.length > 1 && (
          <select className="input" style={{ width: 'auto' }} value={mcc ?? ''}
                  onChange={(e) => setMcc(e.target.value === '' ? null : Number(e.target.value))}>
            {isLabAdmin && <option value="">All centres (help only)</option>}
            {centres.map((c) => <option key={c.id} value={c.id}>{c.code}</option>)}
          </select>
        )}
      </div>

      {error && <div className="alert alert--error">{error}</div>}
      {notice && !error && (
        <div className="alert" style={{ marginBottom: '.8rem' }}>
          {notice}{' '}
          <button className="btn btn--ghost btn--sm" onClick={() => setNotice(null)}>Dismiss</button>
        </div>
      )}
      {loading && <div className="center"><InfinityLoader /></div>}

      {!loading && mcc != null && (
        <>
          <h2 className="req__h2">Materials</h2>
          <div className="req__grid">
            <div className="card">
              <div className="req__cardhead">
                <b>New request</b>
                <input className="input" placeholder="Search the catalogue…"
                       value={itemQuery} onChange={(e) => setItemQuery(e.target.value)}
                       style={{ maxWidth: '14rem' }} />
              </div>
              <div className="req__items">
                {filtered.map((i) => {
                  const qty = basket.get(i.id) ?? 0;
                  return (
                    <div key={i.id} className={`req__item${qty > 0 ? ' req__item--on' : ''}`}>
                      <span className="req__item-id">
                        <span className="req__item-name">{i.name}</span>
                        <span className="muted req__item-price">
                          {i.price > 0 ? inr(i.price) : 'No charge'}{i.unit && i.unit !== '1' ? ` · ${i.unit}` : ''}
                        </span>
                      </span>
                      {qty === 0 ? (
                        <button className="req__add" type="button"
                                onClick={() => setQty(i.id, 1)} aria-label={`Add ${i.name}`}>
                          Add
                        </button>
                      ) : (
                        <span className="req__qty">
                          <button className="req__step" type="button"
                                  onClick={() => setQty(i.id, qty - 1)} aria-label={`One less ${i.name}`}>−</button>
                          <input className="req__qty-in" inputMode="numeric" value={qty}
                                 aria-label={`Quantity of ${i.name}`}
                                 onChange={(e) => setQty(i.id, Math.max(0, Math.min(9999, Number(e.target.value.replace(/\D/g, '')) || 0)))} />
                          <button className="req__step" type="button"
                                  onClick={() => setQty(i.id, qty + 1)} aria-label={`One more ${i.name}`}>+</button>
                        </span>
                      )}
                    </div>
                  );
                })}
                {filtered.length === 0 && <p className="muted">Nothing in the catalogue matches.</p>}
              </div>
              <div className="req__submit">
                <div className="req__submit-sum">
                  {basket.size === 0
                    ? <span className="muted">Pick items above to build a request.</span>
                    : <>
                        <b>{basket.size} item{basket.size === 1 ? '' : 's'}</b>
                        {estimate > 0 && <span className="muted"> · ≈ {inr(estimate)} at catalogue rates</span>}
                        <span className="muted req__submit-note">The lab confirms quantities and price on approval.</span>
                      </>}
                </div>
                <button className="btn btn--primary req__submit-btn" disabled={busy || basket.size === 0}
                        onClick={() => void submitMrf()}>
                  Raise request
                </button>
              </div>
            </div>

            <div className="req__list">
              {mrfs.map((m) => {
                const st = MRF_STATUS[m.status] ?? MRF_STATUS[1];
                return (
                  <div key={m.id} className="card req__card">
                    <div className="req__cardhead">
                      <b>MRF #{m.id}</b>
                      <span className="muted">{fmtDateTime(m.orderedAt)}</span>
                      <span className={`req__chip req__chip--${st.tone}`}>{st.label}</span>
                      {m.status === 1 && (
                        <button className="btn btn--ghost btn--sm" disabled={busy}
                                onClick={() => void cancelMrf(m.id)}>Cancel</button>
                      )}
                    </div>
                    <div className="req__tablewrap">
                    <table className="req__table">
                      <thead>
                        <tr><th>Item</th><th>Asked</th><th>Approved</th><th>Issued</th><th>Dispatch</th></tr>
                      </thead>
                      <tbody>
                        {m.lines.map((l, n) => (
                          <tr key={n}>
                            <td>{l.itemName}</td>
                            <td className="mono">{l.orderQty}</td>
                            <td className="mono">{l.approvedQty ?? '—'}</td>
                            <td className="mono">{l.issuedQty ?? '—'}</td>
                            <td className="muted">
                              {l.docketNumber ? `${l.docketNumber}` : '—'}
                              {l.issuedAt ? ` · ${fmtDateTime(l.issuedAt)}` : ''}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    </div>
                    {m.approvedBy && <p className="muted req__foot">Approved by {m.approvedBy}</p>}
                  </div>
                );
              })}
              {mrfs.length === 0 && <p className="muted">No material requests yet.</p>}
            </div>
          </div>
        </>
      )}

      {!loading && (mcc != null || isLabAdmin) && (
        <>
          <h2 className="req__h2">Help</h2>
          <div className="req__grid">
            {mcc != null && (
              <div className="card">
                <div className="req__cardhead"><b>New request</b></div>
                <div className="row" style={{ gap: '.6rem', flexWrap: 'wrap' }}>
                  <select className="input" style={{ width: 'auto' }} value={category}
                          onChange={(e) => setCategory(e.target.value as 'general' | 'technical')}>
                    <option value="general">General</option>
                    <option value="technical">Technical</option>
                  </select>
                  <input className="input" style={{ flex: 1, minWidth: '14rem' }} maxLength={200}
                         placeholder="What do you need help with?"
                         value={subject} onChange={(e) => setSubject(e.target.value)} />
                </div>
                <textarea className="input" rows={3} maxLength={2000} style={{ marginTop: '.6rem', width: '100%' }}
                          placeholder="Anything that helps the lab act on it — sample IDs, bill numbers, what happened…"
                          value={detail} onChange={(e) => setDetail(e.target.value)} />
                <div className="row" style={{ marginTop: '.6rem' }}>
                  <button className="btn btn--primary" disabled={busy || subject.trim() === ''}
                          onClick={() => void submitHelp()}>Raise request</button>
                </div>
              </div>
            )}

            <div className="req__list">
              {helps.map((h) => {
                const st = HELP_STATUS[h.status] ?? HELP_STATUS.open;
                return (
                  <div key={h.id} className="card req__card">
                    <div className="req__cardhead">
                      <b>{h.subject}</b>
                      <span className="muted">
                        {isLabAdmin && h.clientCode ? `${h.clientCode} · ` : ''}
                        {h.category === 'technical' ? 'Technical' : 'General'} · {fmtDateTime(h.createdAt)}
                        {h.raisedBy ? ` · ${h.raisedBy}` : ''}
                      </span>
                      <span className={`req__chip req__chip--${st.tone}`}>{st.label}</span>
                      {!isLabAdmin && h.status !== 'closed' && mcc != null && (
                        <button className="btn btn--ghost btn--sm" disabled={busy}
                                onClick={() => void closeHelp(h.id)}>Close</button>
                      )}
                    </div>
                    {h.detail && <p className="req__detail">{h.detail}</p>}
                    {h.response && (
                      <div className="req__response">
                        <span className="muted">Lab{h.respondedBy ? ` · ${h.respondedBy}` : ''}:</span> {h.response}
                      </div>
                    )}
                    {isLabAdmin && h.status !== 'closed' && (
                      <HelpAnswer busy={busy} onSend={(status, resp) => void respondHelp(h.id, status, resp)} />
                    )}
                  </div>
                );
              })}
              {helps.length === 0 && <p className="muted">No help requests.</p>}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function HelpAnswer({ busy, onSend }: { busy: boolean; onSend: (status: string, response: string) => void }) {
  const [text, setText] = useState('');
  return (
    <div className="row" style={{ gap: '.5rem', marginTop: '.6rem', flexWrap: 'wrap' }}>
      <input className="input" style={{ flex: 1, minWidth: '12rem' }} maxLength={2000}
             placeholder="Answer the centre…" value={text} onChange={(e) => setText(e.target.value)} />
      <button className="btn btn--ghost btn--sm" disabled={busy}
              onClick={() => onSend('in_progress', text)}>Reply</button>
      <button className="btn btn--primary btn--sm" disabled={busy}
              onClick={() => onSend('closed', text)}>Reply &amp; close</button>
    </div>
  );
}
