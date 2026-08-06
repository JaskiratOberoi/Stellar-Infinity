import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { OrderDetailModal } from './OrderDetail';
import { inr, fmtDate } from '../lib/format';
import { InfinityLoader } from '../components/InfinityLoader';

export interface OrderSummary {
  billId: number;
  billNumber: number | null;
  billDate: string | null;
  patientName: string | null;
  mccCode: number | null;
  clientCode: string | null;
  amount: number;
  balance: number;
}

export function Orders() {
  const [rows, setRows] = useState<OrderSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [canSeeMoney, setCanSeeMoney] = useState(true);
  const [search, setSearch] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);

  const pageSize = 50;

  const load = useCallback(async (q: string, f: string, t: string, p: number) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ page: String(p), pageSize: String(pageSize) });
      if (q.trim()) params.set('search', q.trim());
      if (f) params.set('from', f);
      if (t) params.set('to', t);
      const r = await api.get<{ orders: OrderSummary[]; totalCount: number; canSeeMoney: boolean }>(
        `/api/orders/?${params}`,
      );
      setRows(r.orders);
      setTotal(r.totalCount);
      setCanSeeMoney(r.canSeeMoney);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load orders.');
    } finally {
      setLoading(false);
    }
  }, []);

  // Debounced: the patient-name search uses a leading wildcard, so one query
  // per keystroke would be a table scan per keystroke.
  useEffect(() => {
    const id = setTimeout(() => void load(search, from, to, page), 300);
    return () => clearTimeout(id);
  }, [search, from, to, page, load]);

  const pages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="page">
      <div className="page__head">
        <div>
          <h1 className="page__title">Orders</h1>
          <p className="page__sub">
            {total.toLocaleString('en-IN')} bill{total === 1 ? '' : 's'} in your scope
          </p>
        </div>

        <div className="row" style={{ marginLeft: 'auto', flexWrap: 'wrap' }}>
          <input
            className="input"
            placeholder="Patient, mobile or bill no…"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            style={{ minWidth: 230 }}
          />
          <input className="input" type="date" value={from} max={to || undefined}
                 onChange={(e) => { setFrom(e.target.value); setPage(1); }} title="From date" />
          <input className="input" type="date" value={to} min={from || undefined}
                 onChange={(e) => { setTo(e.target.value); setPage(1); }} title="To date" />
          {(search || from || to) && (
            <button className="btn btn--ghost btn--sm"
                    onClick={() => { setSearch(''); setFrom(''); setTo(''); setPage(1); }}>
              Clear
            </button>
          )}
        </div>
      </div>

      {!canSeeMoney && (
        <div className="alert alert--info" style={{ marginBottom: '.9rem' }}>
          Your role does not include <code>billing:view</code>, so amounts are hidden.
        </div>
      )}

      {error && <div className="alert alert--error" style={{ marginBottom: '.9rem' }}>{error}</div>}

      {loading ? (
        <div className="center"><InfinityLoader /><span className="muted">Loading orders…</span></div>
      ) : (
        <>
          <div className="table-wrap table-wrap--cards">
            <table>
              <thead>
                <tr>
                  <th>Bill</th>
                  <th>Date</th>
                  <th>Patient</th>
                  <th>Client</th>
                  {canSeeMoney && <th style={{ textAlign: 'right' }}>Amount</th>}
                  {canSeeMoney && <th style={{ textAlign: 'right' }}>Balance</th>}
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((o) => (
                  <tr key={o.billId} style={{ cursor: 'pointer' }} onClick={() => setOpenId(o.billId)}>
                    <td className="mono cell--lead"><b>{o.billNumber ?? o.billId}</b></td>
                    <td className="muted cell--meta" data-label="Date">{fmtDate(o.billDate)}</td>
                    <td className="cell--head">{o.patientName ?? <span className="muted">—</span>}</td>
                    <td className="muted cell--meta" data-label="Client">{o.clientCode ?? o.mccCode ?? '—'}</td>
                    {/* The billed total rides beside the bill number: inr()
                        prints the rupee sign, so it needs no label to be read
                        as money on a card. The balance keeps its label,
                        because an unlabelled second figure would not be. */}
                    {canSeeMoney && <td className="mono cell--tag">{inr(o.amount)}</td>}
                    {canSeeMoney && (
                      <td className="mono cell--meta" data-label="Balance"
                          style={{ textAlign: 'right', color: o.balance > 0 ? 'var(--danger)' : undefined }}>
                        {inr(o.balance)}
                      </td>
                    )}
                    <td className="cell--action">
                      <button className="btn btn--ghost btn--sm" onClick={(e) => { e.stopPropagation(); setOpenId(o.billId); }}>
                        Open
                      </button>
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={canSeeMoney ? 7 : 5} className="muted" style={{ textAlign: 'center', padding: '2rem' }}>
                      No orders match these filters.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {pages > 1 && (
            <div className="row" style={{ justifyContent: 'center', marginTop: '1rem' }}>
              <button className="btn btn--ghost btn--sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                Previous
              </button>
              <span className="muted" style={{ fontSize: '.78rem' }}>Page {page} of {pages}</span>
              <button className="btn btn--ghost btn--sm" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
                Next
              </button>
            </div>
          )}
        </>
      )}

      {openId !== null && <OrderDetailModal billId={openId} onClose={() => setOpenId(null)} />}
    </div>
  );
}
