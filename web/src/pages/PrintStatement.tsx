import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';

/**
 * The account statement — every bill in the period, under the CLIENT's own
 * letterhead.
 *
 * Telo's balances screen prints the same document, and for MDCARE it comes out
 * under Medicare's mark rather than Noble's: the branding row already says so
 * (custom logo stored, Noble's hidden), and this reads the same row. A client
 * with no branding prints under the lab's own name, which is what every other
 * client has always had.
 *
 * It loads the WHOLE period (`all=true`), never the page the operator was looking
 * at: a statement that silently held fifty of two thousand bills is worse than
 * no statement. The row cap is stated on the document itself if it is ever hit.
 *
 * Printed by the browser, not the render service — the operator asks for it and
 * their session is already the thing that authorises the numbers on it.
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
}

interface Payload {
  clientCode: string | null;
  totals: {
    count: number; balance: number; amount: number; amountPaid: number;
    discount: number; pendingCount: number;
  };
  collected: {
    collected: number; cashCollected: number; otherCollected: number;
    refunded: number; receiptCount: number;
  };
  rows: BillRow[];
  truncated?: boolean;
  from: string;
  to: string;
}

interface Branding {
  config: {
    clientName: string | null;
    heading?: string | null;
    labName: string | null;
    address: string | null;
    city: string | null;
    state: string | null;
    pincode: string | null;
    phone: string | null;
    email: string | null;
  } | null;
  logo: {
    hasCustom: boolean; customVisible: boolean; nobleVisible: boolean; position: string;
  } | null;
}

const inr = (n: number) => '₹' + Math.round(Math.abs(n)).toLocaleString('en-IN');
const signed = (n: number) => (n < 0 ? `−${inr(n)}` : inr(n));

export function PrintStatement() {
  const { mcc = '' } = useParams();
  const [params] = useSearchParams();
  const mccId = Number(mcc);

  const [data, setData] = useState<Payload | null>(null);
  const [brand, setBrand] = useState<Branding | null>(null);
  const [error, setError] = useState<string | null>(null);

  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
  // Written as 'true' by the Bills page; '1' accepted too, because this URL
  // is short enough that someone will eventually type one by hand.
  const mine = ['1', 'true'].includes(params.get('mine') ?? '');
  const q = params.get('q') ?? '';

  useEffect(() => {
    if (!Number.isInteger(mccId) || mccId <= 0) return;
    let live = true;
    const p = new URLSearchParams({ from, to, all: 'true' });
    if (mine) p.set('mine', 'true');
    if (q) p.set('q', q);

    void Promise.all([
      api.get<Payload>(`/api/bills/${mccId}?${p}`),
      // Branding is best-effort: a statement without a logo is still a
      // statement, and a client with no row simply has none.
      api.get<Branding>(`/api/invoice-branding/${mccId}`).catch(() => null),
    ])
      .then(([bills, branding]) => {
        if (!live) return;
        setData(bills);
        setBrand(branding);
      })
      .catch((e) => { if (live) setError(e instanceof Error ? e.message : 'Could not load the statement.'); });
    return () => { live = false; };
  }, [mccId, from, to, mine, q]);

  // Print once the rows are actually on the page — printing earlier hands the
  // operator a sheet of loading state.
  useEffect(() => {
    if (!data) return;
    const t = setTimeout(() => window.print(), 350);
    return () => clearTimeout(t);
  }, [data]);

  if (error) return <div className="print"><p>{error}</p></div>;
  if (!data) return <div className="print"><p>Preparing the statement…</p></div>;

  const cfg = brand?.config ?? null;
  const logo = brand?.logo ?? null;
  const heading = cfg?.labName?.trim() || cfg?.clientName?.trim() || data.clientCode || 'Noble Diagnostics';
  const addressLine = [cfg?.address, cfg?.city, cfg?.state, cfg?.pincode]
    .map((x) => x?.trim()).filter(Boolean).join(', ');
  const showCustom = !!logo?.hasCustom && logo.customVisible !== false;

  return (
    <div className="print" data-print-ready="true">
      <header className="print__head">
        <div>
          <div className="inv__lab">{heading}</div>
          {addressLine && <div className="inv__addr">{addressLine}</div>}
          {(cfg?.phone || cfg?.email) && (
            <div className="inv__addr">{[cfg?.phone, cfg?.email].filter(Boolean).join(' · ')}</div>
          )}
        </div>
        <div style={{ textAlign: 'right' }}>
          {showCustom && (
            <img className="inv__logo" alt=""
                 src={`/api/invoice-branding/${mccId}/logo`} />
          )}
          <div className="inv__title">Account statement</div>
          <dl className="print__meta print__meta--right">
            <div><dt>Period</dt><dd>{data.from} → {data.to}</dd></div>
            {data.clientCode && <div><dt>Client</dt><dd>{data.clientCode}</dd></div>}
            {mine && <div><dt>Scope</dt><dd>My registrations</dd></div>}
            {q && <div><dt>Search</dt><dd>{q}</dd></div>}
          </dl>
        </div>
      </header>

      <section className="stmt__totals">
        <div><span>Total billed</span><b>{inr(data.totals.amount)}</b>
          <em>{data.totals.count.toLocaleString('en-IN')} bills · {inr(data.totals.discount)} discount</em></div>
        <div><span>Collected in period</span><b>{inr(data.collected.collected)}</b>
          <em>{data.collected.receiptCount.toLocaleString('en-IN')} payments · cash {inr(data.collected.cashCollected)} · other {inr(data.collected.otherCollected)}
            {data.collected.refunded > 0 ? ` · refunded ${inr(data.collected.refunded)}` : ''}</em></div>
        <div><span>Balance due</span><b>{signed(data.totals.balance)}</b>
          <em>{data.totals.pendingCount.toLocaleString('en-IN')} bills pending</em></div>
      </section>

      <table className="print__table stmt__table">
        <thead>
          <tr>
            <th>Bill #</th><th>Date</th><th>Patient</th><th>PID</th>
            <th>Ref. doctor / customer</th><th>Payment</th>
            <th className="num">Amount</th><th className="num">Discount</th>
            <th className="num">Paid</th><th className="num">Balance</th>
          </tr>
        </thead>
        <tbody>
          {data.rows.map((b) => (
            <tr key={b.billId}>
              <td>{b.billNumber ?? b.billId}</td>
              <td>{b.billDate ? b.billDate.slice(0, 10) : ''}</td>
              <td>{b.patientName ?? ''}</td>
              <td>{b.patientId ?? ''}</td>
              <td>{[b.doctorName, b.customerName].filter(Boolean).join(' · ')}</td>
              <td>{b.paymentType ?? ''}</td>
              <td className="num">{inr(b.amount)}</td>
              <td className="num">{b.discount > 0 ? inr(b.discount) : ''}</td>
              <td className="num">{inr(b.amountPaid)}</td>
              <td className="num">{b.balance === 0 ? '—' : signed(b.balance)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={6}>Total · {data.rows.length.toLocaleString('en-IN')} bills</td>
            <td className="num">{inr(data.totals.amount)}</td>
            <td className="num">{inr(data.totals.discount)}</td>
            <td className="num">{inr(data.totals.amountPaid)}</td>
            <td className="num">{signed(data.totals.balance)}</td>
          </tr>
        </tfoot>
      </table>

      {data.truncated && (
        <p className="inv__addr">
          This statement lists the first {data.rows.length.toLocaleString('en-IN')} bills of the
          period. Narrow the dates for a complete one.
        </p>
      )}
      <p className="inv__addr">
        Printed {new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST · figures cover the whole period stated above,
        not a page of it. Collections are keyed by receipt date.
      </p>
    </div>
  );
}
