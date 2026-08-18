import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { fmtDateTime } from '../lib/format';

/**
 * The receipt as a printed page — what the render sidecar turns into the PDF.
 *
 * A render surface, so it holds no session and no chrome: the headless browser
 * arrives with the signed token in the URL and nothing else, exactly as the
 * customer's browser does. See PaymentReceiptLink.
 *
 * Deliberately plain. This is a document someone files against a bank
 * statement, so it needs the payer, the amount, the reference and the date to
 * be findable at a glance and to survive being printed in black and white —
 * not the colour and iconography of the on-screen page.
 */

interface Receipt {
  orderRef: string;
  status: string;
  amount: number;
  reference: string | null;
  instrument: string | null;
  card: string | null;
  paidAt: string | null;
  clientCode: string | null;
  clientName: string | null;
}

const inr = (n: number) => '₹' + Math.abs(Math.round(n)).toLocaleString('en-IN');

export function PrintPaymentReceipt() {
  const { orderRef } = useParams<{ orderRef: string }>();
  const [params] = useSearchParams();
  const token = params.get('t');

  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!orderRef || !token) { setFailed(true); return; }
    let live = true;
    fetch(`/api/payments/receipt/${encodeURIComponent(orderRef)}?t=${encodeURIComponent(token)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('not found'))))
      .then((r: Receipt) => { if (live) setReceipt(r); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [orderRef, token]);

  /* The renderer blocks on [data-print-ready="true"] - see render/server.mjs.
     The exact attribute and the string "true" both matter: without the marker
     it waits out the navigation timeout and the whole render fails. */
  const ready = receipt != null || failed;

  if (!ready) return <div className="rcpt" />;
  if (!receipt) return <div className="rcpt" data-print-ready="true"><p>This receipt is not available.</p></div>;

  return (
    <div className="rcpt" data-print-ready="true">
      <header className="rcpt__head">
        <div>
          <h1 className="rcpt__title">Payment receipt</h1>
          <p className="rcpt__sub">Noble Diagnostics</p>
        </div>
        <div className="rcpt__amount">
          <span className="rcpt__amount-label">Amount received</span>
          <b>{inr(receipt.amount)}</b>
        </div>
      </header>

      <table className="rcpt__table">
        <tbody>
          <tr>
            <th>Received from</th>
            <td>
              {receipt.clientName ?? '—'}
              {receipt.clientCode ? ` (${receipt.clientCode})` : ''}
            </td>
          </tr>
          <tr><th>Date</th><td>{receipt.paidAt ? fmtDateTime(receipt.paidAt) : '—'}</td></tr>
          <tr>
            <th>Paid by</th>
            <td>
              {receipt.instrument ?? 'Online'}
              {receipt.card ? ` · ${receipt.card}` : ''}
            </td>
          </tr>
          {/* The gateway's id, which is what a bank statement will show —
              the pair of references is how a query gets resolved. */}
          <tr><th>Gateway reference</th><td className="mono">{receipt.reference ?? '—'}</td></tr>
          <tr><th>Our reference</th><td className="mono">{receipt.orderRef}</td></tr>
        </tbody>
      </table>

      <p className="rcpt__note">
        This payment has been credited to the account above. No card details are held by Noble
        Diagnostics — the payment was taken by CCAvenue.
      </p>

      <p className="rcpt__foot">
        Computer-generated receipt · no signature required
      </p>
    </div>
  );
}
