import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { inr, fmtDate, fmtDateTime, fmtAge, fmtGender, plainText } from '../lib/format';

/**
 * The invoice for one bill, in two copies.
 *
 *   costing — what the payer owes. Tests and money, no sample ids. This is the
 *             copy that leaves the lab with the patient or goes to the client's
 *             accounts department.
 *   lab     — the same document plus the sample ids, for the collection
 *             envelope and the lab's own file.
 *
 * One component rather than two, which is a deliberate change from Telo. There
 * the two copies are separate files (bill-invoice.tsx and lab-invoice.tsx) and
 * they have already drifted — the same bill can print two different addresses
 * depending on which button you pressed. Here the difference is one section.
 *
 * Like the printed report this is a ROUTE, not a modal: what prints is what is
 * on screen, so there is one description of the document rather than a preview
 * and a printable version that agree until someone edits one of them.
 *
 * Theme-free by construction — it inherits `.print`, whose colours are all
 * literal. An invoice must not come out different because the operator had
 * dark mode on.
 */

interface OrderLine {
  lineId: number;
  testCode: string | null;
  testName: string | null;
  amount: number;
  cancelled: boolean;
}

interface OrderSample {
  vailid: string;
  sampleTypeName: string;
  testCodes: string | null;
}

interface Order {
  billId: number;
  billNumber: number | null;
  billDate: string | null;
  patientName: string | null;
  clientCode: string | null;
  mccCode: number | null;
  amount: number;
  balance: number;
  age: number | null;
  ageType: number | null;
  gender: number | null;
  mobile: string | null;
  refDoctorName: string | null;
  paymentType: string | null;
  discount: number;
  amountPaid: number;
  patientId: number | null;
  registeredBy: string | null;
  lines: OrderLine[];
  samples: OrderSample[];
}

interface InvoiceConfig {
  clientCode: string | null;
  clientName: string | null;
  heading: string;
  address: string | null;
  city: string | null;
  state: string | null;
  pincode: string | null;
  phone: string | null;
  email: string | null;
  preparedBy: string | null;
  hasConfig: boolean;
  flags: { onBehalf: 'client' | 'qugen'; showDisclaimer: boolean; showSignatory: boolean };
}

const LAB_NAME = 'Noble Diagnostics';

/**
 * The company a bill is raised by when it is not raised in the centre's own
 * name. Verbatim from Telo — it appears on a document that goes to a client's
 * accounts department, so the legal name has to match to the character.
 */
const BILLING_ENTITY = 'Qugen Pathlabs Pvt. Ltd.';

export function PrintInvoice() {
  const { billId = '' } = useParams();
  const [params] = useSearchParams();
  // Unknown values fall back to the costing copy: it is the strictly smaller
  // document, so a typo in the query string cannot leak sample ids onto a
  // patient's invoice.
  const isLabCopy = params.get('copy') === 'lab';

  const [order, setOrder] = useState<Order | null>(null);
  const [config, setConfig] = useState<InvoiceConfig | null>(null);
  const [disclaimer, setDisclaimer] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    // Sequential, not Promise.all: MARS is off on the Noble connection and
    // these two calls hit the same pool. The pair is fast enough that the
    // round trip is not worth the risk of reintroducing that bug.
    (async () => {
      try {
        const o = await api.get<{ order: Order }>(`/api/orders/${billId}`);
        if (!live) return;
        setOrder(o.order);
        const i = await api.get<{ config: InvoiceConfig | null; disclaimer: string }>(
          `/api/orders/${billId}/invoice`,
        );
        if (!live) return;
        setConfig(i.config);
        setDisclaimer(i.disclaimer);
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : 'Could not load this invoice.');
      }
    })();
    return () => { live = false; };
  }, [billId]);

  if (error) {
    return <div className="print"><p style={{ color: '#b00' }}>{error}</p></div>;
  }
  if (!order) {
    return <div className="print"><p>Loading…</p></div>;
  }

  const flags = config?.flags ?? { onBehalf: 'client' as const, showDisclaimer: true, showSignatory: false };
  const heading = config?.heading?.trim() || order.clientCode || LAB_NAME;

  /**
   * Who the bill is raised on behalf of.
   *
   * NOT a letterhead switch. The header stays the centre's throughout — this
   * is one attribution line under the totals, which is exactly where Telo puts
   * it. Making it swap the letterhead (as an earlier draft here did) would
   * have printed a different document from Telo for the same bill, and the two
   * systems are live against the same database.
   */
  const onBehalfName = flags.onBehalf === 'qugen' ? BILLING_ENTITY : heading;

  const addressLine = [config?.address, config?.city, config?.state, config?.pincode]
    .map((s) => s?.trim())
    .filter(Boolean)
    .join(', ');

  /*
   * The LIS's own total, not a sum of the lines.
   *
   * `amount` is gross and `balance = amount − discount − paid` holds on every
   * bill in the database. Re-adding the lines here would usually agree, but
   * where it did not the invoice would state a total that does not reconcile
   * with the balance printed three rows below it — and the balance is the
   * number someone pays against.
   */
  const gross = order.amount;
  const net = gross - order.discount;

  return (
    <div className="print print--invoice">
      {/* Screen-only. The one control on the page, and it removes itself from
          the thing it produces. */}
      <div className="print__toolbar">
        <button className="btn btn--primary btn--sm" onClick={() => window.print()}>Print</button>
        <span className="muted" style={{ fontSize: '.78rem' }}>
          {isLabCopy ? 'Lab copy — includes sample IDs' : 'Costing copy — no sample IDs'}
        </span>
      </div>

      <header className="print__head">
        <div>
          <div className="inv__lab">{heading}</div>
          {addressLine && <div className="inv__addr">{addressLine}</div>}
          {(config?.phone || config?.email) && (
            <div className="inv__addr">
              {[config?.phone, config?.email].filter(Boolean).join(' · ')}
            </div>
          )}
        </div>
        <div style={{ textAlign: 'right' }}>
          <div className="inv__title">{isLabCopy ? 'Lab Invoice' : 'Invoice'}</div>
          <dl className="print__meta print__meta--right">
            <div><dt>Bill no.</dt><dd>{order.billNumber ?? order.billId}</dd></div>
            <div><dt>Date</dt><dd>{fmtDate(order.billDate)}</dd></div>
            {order.clientCode && <div><dt>Client</dt><dd>{order.clientCode}</dd></div>}
          </dl>
        </div>
      </header>

      <section className="inv__party">
        <dl className="print__meta">
          <div><dt>Patient</dt><dd>{order.patientName || '—'}</dd></div>
          <div><dt>Age / Sex</dt><dd>{fmtAge(order.age, order.ageType)} · {fmtGender(order.gender)}</dd></div>
          {order.patientId != null && <div><dt>Patient ID</dt><dd>{order.patientId}</dd></div>}
          {order.mobile && <div><dt>Mobile</dt><dd>{order.mobile}</dd></div>}
          {order.refDoctorName && <div><dt>Ref. doctor</dt><dd>{order.refDoctorName}</dd></div>}
        </dl>
      </section>

      <table className="print__table inv__lines">
        <thead>
          <tr>
            <th style={{ width: '3rem' }}>#</th>
            <th>Test</th>
            <th style={{ width: '6rem' }}>Code</th>
            <th style={{ width: '7rem', textAlign: 'right' }}>Amount</th>
          </tr>
        </thead>
        <tbody>
          {order.lines.map((l, i) => (
            <tr key={l.lineId} className={l.cancelled ? 'inv__cancelled' : undefined}>
              <td>{i + 1}</td>
              <td>
                {plainText(l.testName) || l.testCode || '—'}
                {l.cancelled && <span className="inv__note"> (cancelled)</span>}
              </td>
              <td>{l.testCode ?? '—'}</td>
              <td style={{ textAlign: 'right' }}>{l.cancelled ? '—' : inr(l.amount)}</td>
            </tr>
          ))}
          {order.lines.length === 0 && (
            <tr><td colSpan={4}>No tests on this bill.</td></tr>
          )}
        </tbody>
      </table>

      <div className="inv__totals">
        <dl>
          <div><dt>Gross</dt><dd>{inr(gross)}</dd></div>
          {order.discount > 0 && <div><dt>Discount</dt><dd>−{inr(order.discount)}</dd></div>}
          <div className="inv__totals-net"><dt>Net payable</dt><dd>{inr(net)}</dd></div>
          <div><dt>Paid</dt><dd>{inr(order.amountPaid)}</dd></div>
          <div className={order.balance > 0 ? 'inv__totals-due' : undefined}>
            <dt>{order.balance < 0 ? 'Credit' : 'Balance due'}</dt>
            <dd>{inr(Math.abs(order.balance))}</dd>
          </div>
        </dl>
      </div>
      <p className="inv__behalf">On behalf of {onBehalfName}</p>

      {/* Sample ids are the whole difference between the two copies. */}
      {isLabCopy && order.samples.length > 0 && (
        <section className="inv__samples">
          <h2>Samples</h2>
          <table className="print__table">
            <thead>
              <tr>
                <th style={{ width: '9rem' }}>Sample ID</th>
                <th style={{ width: '9rem' }}>Type</th>
                <th>Tests</th>
              </tr>
            </thead>
            <tbody>
              {order.samples.map((s) => (
                <tr key={s.vailid}>
                  <td>{s.vailid}</td>
                  <td>{s.sampleTypeName}</td>
                  <td>{s.testCodes ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {flags.showDisclaimer && disclaimer && (
        <p className="inv__disclaimer">{disclaimer}</p>
      )}

      <footer className="inv__foot">
        <div>
          {order.paymentType && <div>Payment: {order.paymentType}</div>}
          <div>
            Prepared by {config?.preparedBy?.trim() || order.registeredBy || '—'}
            {' · '}
            {fmtDateTime(order.billDate)}
          </div>
          <div>This is a computer-generated bill.</div>
        </div>
        {flags.showSignatory && (
          <div className="inv__sign">
            <div className="inv__sign-line" />
            <div><b>Authorised Signatory</b></div>
            <div>{heading}</div>
          </div>
        )}
      </footer>
    </div>
  );
}
