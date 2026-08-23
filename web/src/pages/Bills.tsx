import { useEffect, useState } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import { api, accountsApi } from '../api/client';
import { inr } from '../lib/format';
import { isB2cClientCode } from '../lib/discountPolicy';
import { InfinityLoader } from '../components/InfinityLoader';
import { Pager } from '../components/Pager';
import { OrderDetailModal } from './OrderDetail';
import { useAuth } from '../auth/AuthContext';

/**
 * The Bills page — Telo's balances screen, ported for the B2C franchise
 * brands and ONLY them. A B2B client's money lives on its running ledger and
 * has the Accounts page; a B2C client's money lives on per-patient bills,
 * paid at the counter, and this is where those bills are reconciled: the
 * period's totals, the collection split, and every bill with its own paid /
 * balance state. The server refuses non-B2C codes with the same reasoning.
 *
 * The View button opens the SAME order dialog the lab uses, which is where
 * the super-admin corrections live (cancel a test, cancel the booking,
 * refund, void or correct a receipt, change the discount) — those controls
 * show only for the super admin, exactly as Telo scopes them.
 */

interface BillRow {
  billId: number;
  billNumber: number | null;
  billDate: string | null;
  patientName: string | null;
  patientId: number | null;
  amount: number;
  amountPaid: number;
  balance: number;
  discount: number;
  doctorName: string | null;
  customerName: string | null;
  paymentType: string | null;
  age: number | null;
  ageType: string | null;
}

interface BillsResponse {
  clientCode: string | null;
  totals: {
    count: number; balance: number; amount: number; amountPaid: number;
    discount: number; pendingCount: number;
  };
  collected: {
    collected: number; cashCollected: number; otherCollected: number;
    refunded: number; receiptCount: number; cashCount: number; otherCount: number;
  };
  rows: BillRow[];
  page: number;
  pageSize: number;
  pageCount: number;
  from: string;
  to: string;
}

function todayIso(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function shiftIso(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const t = new Date(y, m - 1, d + days);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`;
}

/** first-of-month for the month containing iso, shifted by `months`. */
function monthStart(iso: string, months = 0): string {
  const [y, m] = iso.split('-').map(Number);
  const t = new Date(y, m - 1 + months, 1);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-01`;
}

/** last day of the month containing iso. */
function monthEnd(iso: string): string {
  const [y, m] = iso.split('-').map(Number);
  const t = new Date(y, m, 0);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`;
}

/**
 * /bills with no client: a B2C client login forwards to its own; the super
 * admin picks from the B2C brands.
 */
export function BillsHome() {
  const { user } = useAuth();
  const [targets, setTargets] = useState<{ mccId: number; code: string; name: string | null }[] | null>(null);

  useEffect(() => {
    let live = true;
    void accountsApi.list('', false, 1, 100)
      .then((r) => {
        if (!live) return;
        setTargets(r.rows
          .filter((a) => isB2cClientCode(a.clientCode))
          .map((a) => ({ mccId: a.mccId, code: a.clientCode ?? '', name: a.clientName })));
      })
      .catch(() => { if (live) setTargets([]); });
    return () => { live = false; };
  }, []);

  if (targets === null) {
    return <div className="page"><div className="center"><InfinityLoader /></div></div>;
  }
  if (targets.length === 1 && user?.role !== 'super_admin') {
    return <Navigate to={`/bills/${targets[0].mccId}`} replace />;
  }
  if (targets.length === 1) return <Navigate to={`/bills/${targets[0].mccId}`} replace />;

  return (
    <div className="page">
      <div className="page__head">
        <div>
          <h1 className="page__title">Bills</h1>
          <p className="page__sub">Per-patient billing — the B2C franchise brands.</p>
        </div>
      </div>
      {targets.length === 0 ? (
        <div className="card">
          <p className="muted" style={{ margin: 0 }}>
            No B2C client is in your scope. Bills exist for walk-in franchise clients
            (MDCARE, MEDICARE); ledger clients live under Accounts.
          </p>
        </div>
      ) : (
        <div className="row" style={{ flexWrap: 'wrap', gap: '.6rem' }}>
          {targets.map((t) => (
            <a key={t.mccId} className="card" href={`/bills/${t.mccId}`}
               style={{ padding: '.8rem 1rem', textDecoration: 'none' }}>
              <b className="mono">{t.code}</b>
              <div className="muted" style={{ fontSize: '.76rem' }}>{t.name ?? ''}</div>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

export function Bills() {
  const { mcc = '' } = useParams();
  const mccId = Number(mcc);

  const today = todayIso();
  const [from, setFrom] = useState(monthStart(today));
  const [to, setTo] = useState(today);
  const [q, setQ] = useState('');
  const [qLive, setQLive] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<BillsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewing, setViewing] = useState<number | null>(null);

  // The search debounces itself; everything else refetches immediately.
  useEffect(() => {
    const t = setTimeout(() => { setQ(qLive); setPage(1); }, 300);
    return () => clearTimeout(t);
  }, [qLive]);

  useEffect(() => {
    if (!Number.isInteger(mccId) || mccId <= 0) return;
    let live = true;
    setLoading(true);
    setError(null);
    const p = new URLSearchParams({ from, to, page: String(page) });
    if (q.trim()) p.set('q', q.trim());
    void api.get<BillsResponse>(`/api/bills/${mccId}?${p}`)
      .then((r) => { if (live) setData(r); })
      .catch((e) => { if (live) setError(e instanceof Error ? e.message : 'Could not load bills.'); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [mccId, from, to, q, page, viewing === null]);

  const pick = (f: string, t: string) => { setFrom(f); setTo(t); setPage(1); };
  const firstOfWeek = () => {
    const d = new Date();
    const day = d.getDay();
    return shiftIso(today, day === 0 ? -6 : 1 - day);
  };
  const presets: { label: string; from: string; to: string }[] = [
    { label: 'Today', from: today, to: today },
    { label: 'This week', from: firstOfWeek(), to: today },
    { label: 'This month', from: monthStart(today), to: today },
    // The month that CLOSED — the range a reconciliation actually reaches
    // for, and the one every other preset makes the operator type by hand.
    { label: 'Last month', from: monthStart(today, -1), to: monthEnd(monthStart(today, -1)) },
    { label: 'This year', from: `${today.slice(0, 4)}-01-01`, to: today },
  ];

  if (!Number.isInteger(mccId) || mccId <= 0) {
    return <div className="page"><div className="alert alert--error">No such client.</div></div>;
  }

  const t = data?.totals;
  const c = data?.collected;
  const avg = t && t.count > 0 ? Math.round(t.amount / t.count) : 0;

  const tile = (label: string, body: React.ReactNode) => (
    <div className="card" style={{ padding: '.9rem 1rem', flex: '1 1 12rem', minWidth: '12rem' }}>
      <p className="clienthome__label" style={{ margin: 0 }}>{label}</p>
      {body}
    </div>
  );

  return (
    <div className="page">
      <div className="page__head">
        <div>
          <h1 className="page__title">
            Bills{data?.clientCode && <span className="mono muted" style={{ fontSize: '1rem' }}> {data.clientCode}</span>}
          </h1>
          <p className="page__sub">
            {t ? `${t.count.toLocaleString('en-IN')} bills · ${inr(t.balance)} balance · ` : ''}
            {data ? `${data.from} → ${data.to}` : ''}
            {data && data.pageCount > 1 ? ` · page ${data.page} of ${data.pageCount}` : ''}
          </p>
        </div>
      </div>

      <div className="row" style={{ flexWrap: 'wrap', gap: '.4rem', marginBottom: '.7rem', alignItems: 'center' }}>
        <input className="input input--sm" type="date" value={from} max={to}
               onChange={(e) => e.target.value && pick(e.target.value, to)} aria-label="From date" />
        <span className="muted">to</span>
        <input className="input input--sm" type="date" value={to} min={from} max={today}
               onChange={(e) => e.target.value && pick(from, e.target.value)} aria-label="To date" />
        {presets.map((p) => (
          <button key={p.label} type="button"
                  className={`btn btn--sm ${from === p.from && to === p.to ? 'btn--primary' : 'btn--ghost'}`}
                  onClick={() => pick(p.from, p.to)}>
            {p.label}
          </button>
        ))}
      </div>

      {error && <div className="alert alert--error" style={{ marginBottom: '.8rem' }}>{error}</div>}

      <div className="row" style={{ flexWrap: 'wrap', gap: '.6rem', marginBottom: '.8rem' }}>
        {tile('Total billed', (
          <>
            <p style={{ margin: '.15rem 0 0', fontSize: '1.3rem', fontWeight: 600 }}>{t ? inr(t.amount) : '—'}</p>
            <p className="muted" style={{ margin: 0, fontSize: '.72rem' }}>
              {t ? `${t.count.toLocaleString('en-IN')} bills` : ''}
              {t && t.discount > 0 ? ` · ${inr(t.discount)} discount` : ''}
            </p>
          </>
        ))}
        {tile('Collected in period', (
          <>
            <p style={{ margin: '.15rem 0 0', fontSize: '1.3rem', fontWeight: 600, color: 'var(--teal)' }}>
              {c ? inr(c.collected) : '—'}
            </p>
            <p className="muted" style={{ margin: 0, fontSize: '.72rem' }}>
              {c ? `${c.receiptCount.toLocaleString('en-IN')} payments · keyed by receipt date` : ''}
            </p>
            {c && (
              <dl style={{ margin: '.5rem 0 0', fontSize: '.74rem', display: 'grid', gap: '.15rem' }}>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <span className="muted">Cash</span>
                  <span className="mono">{inr(c.cashCollected)} <span className="muted">· {c.cashCount}</span></span>
                </div>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <span className="muted">Others</span>
                  <span className="mono">{inr(c.otherCollected)} <span className="muted">· {c.otherCount}</span></span>
                </div>
                {c.refunded > 0 && (
                  <div className="row" style={{ justifyContent: 'space-between' }}>
                    <span className="muted">Refunded</span>
                    <span className="mono" style={{ color: 'var(--danger)' }}>−{inr(c.refunded)}</span>
                  </div>
                )}
              </dl>
            )}
          </>
        ))}
        {tile('Balance due', (
          <>
            <p style={{
              margin: '.15rem 0 0', fontSize: '1.3rem', fontWeight: 600,
              color: t && t.balance > 0 ? 'var(--danger)' : undefined,
            }}>{t ? inr(t.balance) : '—'}</p>
            <p className="muted" style={{ margin: 0, fontSize: '.72rem' }}>
              {t ? `${t.pendingCount.toLocaleString('en-IN')} bills pending` : ''}
            </p>
          </>
        ))}
        {tile('Avg bill', (
          <>
            <p style={{ margin: '.15rem 0 0', fontSize: '1.3rem', fontWeight: 600 }}>{t ? inr(avg) : '—'}</p>
            <p className="muted" style={{ margin: 0, fontSize: '.72rem' }}>{data ? `${data.from} → ${data.to}` : ''}</p>
          </>
        ))}
      </div>

      <input className="input" style={{ marginBottom: '.7rem', maxWidth: 480 }}
             placeholder="Search all bills in this period — bill #, name, PID, SID, mobile…"
             value={qLive} onChange={(e) => setQLive(e.target.value)} />

      {loading && !data ? (
        <div className="center"><InfinityLoader /><span className="muted">Loading bills…</span></div>
      ) : (
        <>
          <div className="table-wrap table-wrap--cards">
            <table>
              <thead>
                <tr>
                  <th>Bill #</th><th>Date</th><th>Patient</th><th>Ref. doctor / customer</th>
                  <th>Payment</th><th>Age</th>
                  <th style={{ textAlign: 'right' }}>Amount</th>
                  <th style={{ textAlign: 'right' }}>Discount</th>
                  <th style={{ textAlign: 'right' }}>Paid</th>
                  <th style={{ textAlign: 'right' }}>Balance</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {(data?.rows ?? []).map((b) => {
                  const off = b.balance !== 0;
                  return (
                    <tr key={b.billId} style={off ? { background: 'color-mix(in srgb, var(--danger) 6%, transparent)' } : undefined}>
                      <td className="mono cell--lead">
                        <button type="button" className="pidlink" onClick={() => setViewing(b.billId)}>
                          <b>{b.billNumber ?? b.billId}</b>
                        </button>
                      </td>
                      <td className="muted cell--meta" data-label="Date" style={{ whiteSpace: 'nowrap', fontSize: '.78rem' }}>
                        {b.billDate ? b.billDate.slice(0, 10) : '—'}
                      </td>
                      <td className="cell--head">{b.patientName ?? '—'}</td>
                      <td className="muted cell--body" data-label="Ref" style={{ fontSize: '.76rem' }}>
                        {[b.doctorName, b.customerName].filter(Boolean).join(' · ') || '—'}
                      </td>
                      <td className="cell--tag">{b.paymentType ?? '—'}</td>
                      <td className="muted cell--meta" data-label="Age">{b.age != null ? `${b.age}${(b.ageType ?? 'Y')[0]}` : '—'}</td>
                      <td className="mono cell--meta" data-label="Amount" style={{ textAlign: 'right' }}>{inr(b.amount)}</td>
                      <td className="mono muted cell--meta" data-label="Disc" style={{ textAlign: 'right' }}>
                        {b.discount > 0 ? `− ${inr(b.discount)}` : '—'}
                      </td>
                      <td className="mono cell--meta" data-label="Paid" style={{ textAlign: 'right' }}>{inr(b.amountPaid)}</td>
                      <td className="mono cell--meta" data-label="Balance" style={{
                        textAlign: 'right', fontWeight: 600,
                        color: off ? 'var(--danger)' : undefined,
                      }}>
                        {b.balance < 0 ? `−${inr(-b.balance)}` : inr(b.balance)}
                      </td>
                      <td className="cell--action" style={{ textAlign: 'right' }}>
                        <button className="btn btn--ghost btn--sm" onClick={() => setViewing(b.billId)}>
                          View →
                        </button>
                      </td>
                    </tr>
                  );
                })}
                {(data?.rows ?? []).length === 0 && (
                  <tr>
                    <td colSpan={11} className="muted" style={{ textAlign: 'center', padding: '2.5rem' }}>
                      No bills in this period{q ? ' match the search' : ''}.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div style={{ marginTop: '.8rem' }}>
            <Pager page={data?.page ?? 1} pageSize={data?.pageSize ?? 50}
                   total={t?.count ?? 0} noun="bill" onPage={setPage} />
          </div>
        </>
      )}

      {viewing != null && <OrderDetailModal billId={viewing} onClose={() => setViewing(null)} />}
    </div>
  );
}
