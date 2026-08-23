import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { plainText } from '../lib/format';

/**
 * The invoice for one bill, in two copies.
 *
 *   costing — what the payer owes. Tests and money, no sample ids. This is the
 *             copy that leaves the lab with the patient or goes to the client's
 *             accounts department.
 *   lab     — the same document plus the sample ids, for the collection
 *             envelope and the lab's own file.
 *
 * The document is Telo's bill-invoice.tsx, transcribed band for band — both
 * systems print bills against the same database, often for the same client on
 * the same day, and two documents for one bill must not look like two vendors.
 * Where Telo writes a Tailwind class this writes the same measurements into
 * .bill rules in styles.css; the section order, labels, casing and column
 * widths are Telo's, not a redesign. If a band changes there, change it here.
 *
 * One component rather than Telo's two files (bill-invoice / lab-invoice, which
 * have already drifted apart there): the lab copy is the same document plus one
 * samples band.
 *
 * Like the printed report this is a ROUTE, not a modal: what prints is what is
 * on screen, so there is one description of the document rather than a preview
 * and a printable version that agree until someone edits one of them.
 */

interface OrderLine {
  lineId: number;
  testCode: string | null;
  testName: string | null;
  amount: number;
  cancelled: boolean;
  isExternal: boolean;
}

interface OrderReceipt {
  receiptId: number;
  date: string | null;
  amount: number;
  method: string | null;
  reference: string | null;
  kind: 'payment' | 'refund';
  voided: boolean;
  txnId: string | null;
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
  email: string | null;
  refDoctorName: string | null;
  refCustomerName: string | null;
  clinicalHistory: string | null;
  paymentType: string | null;
  discount: number;
  amountPaid: number;
  patientId: number | null;
  registeredBy: string | null;
  preparedByOverride: string | null;
  lines: OrderLine[];
  samples: OrderSample[];
  receipts: OrderReceipt[];
}

interface InvoiceLogo {
  hasCustom: boolean;
  customVisible: boolean;
  nobleVisible: boolean;
  position: string;
}

interface InvoiceConfig {
  clientCode: string | null;
  clientName: string | null;
  heading: string;
  address: string | null;
  city: string | null;
  phone: string | null;
  email: string | null;
  preparedBy: string | null;
  hasConfig: boolean;
  flags: { onBehalf: 'client' | 'qugen'; showDisclaimer: boolean; showSignatory: boolean };
  /** The row as stored, no centre fallback. The header's state/pincode read
   *  from HERE: Telo's does (config-only for those two, fallback for the
   *  rest), and MDCARE's header owes its exact text to that asymmetry. */
  stored: { state: string | null; pincode: string | null } | null;
}

const LAB_NAME = 'Noble Diagnostics';

/**
 * The company a bill is raised by when it is not raised in the centre's own
 * name. Verbatim from Telo — it appears on a document that goes to a client's
 * accounts department, so the legal name has to match to the character.
 */
const BILLING_ENTITY = 'Qugen Pathlabs Pvt. Ltd.';

/** Telo's inr(): two decimals always, en-IN grouping — "₹250.00". */
const inr = (n: number) =>
  '₹' + n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Telo's fmtIST(): "23/08/2026, 04:37:43 pm", pinned to IST. */
const fmtIST = (iso: string | null | undefined) => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true,
  });
};

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="bill__row">
      <span className="bill__row-label">{label}</span>
      <span className={mono ? 'bill__mono' : undefined}>{value}</span>
    </div>
  );
}

function SummaryRow({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className={`bill__sumrow${bold ? ' bill__sumrow--bold' : ''}`}>
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}

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
  const [logo, setLogo] = useState<InvoiceLogo | null>(null);
  const [mccId, setMccId] = useState<number | null>(null);
  /** Both fetches settled — the render service waits on this attribute, and
   *  before it the page is a loading state that must never become a PDF. */
  const [ready, setReady] = useState(false);
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
        const i = await api.get<{ config: InvoiceConfig | null; disclaimer: string; logo: InvoiceLogo | null; mccId: number | null }>(
          `/api/orders/${billId}/invoice`,
        );
        if (!live) return;
        setConfig(i.config);
        setDisclaimer(i.disclaimer);
        setLogo(i.logo);
        setMccId(i.mccId);
        setReady(true);
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
  const labName = config?.heading?.trim() || order.clientCode || LAB_NAME;
  const onBehalfName = flags.onBehalf === 'qugen' ? BILLING_ENTITY : labName;

  // Header line 2 — Telo's asymmetry, kept: address/city fall back to the
  // centre master, state/pincode come from the stored config alone.
  const addressLine = [config?.address, config?.city, config?.stored?.state, config?.stored?.pincode]
    .map((s) => s?.trim())
    .filter(Boolean)
    .join(', ');

  // Prepared-by precedence, Telo's exactly: the registering account's own
  // printed name wins; else MDCARE-style clients use the config free text
  // (several desks share the code, so a user's name would be wrong more often
  // than right), everyone else the registering user's name.
  const preparedBy =
    order.preparedByOverride?.trim() ||
    (flags.onBehalf === 'qugen'
      ? config?.preparedBy?.trim() || null
      : order.registeredBy ?? config?.preparedBy?.trim() ?? null);

  // The printed bill is a clean financial document: voided transactions are
  // dropped entirely (the on-screen receipt keeps them, struck through, for
  // audit). The header totals already net out voids.
  const billReceipts = order.receipts.filter((r) => !r.voided);

  const genderLabel = order.gender === 1 ? 'M' : order.gender === 2 ? 'F' : '—';
  const subTotal = order.lines.reduce((s, l) => s + (l.cancelled ? 0 : l.amount), 0);
  const hasExternal = order.lines.some((l) => l.isExternal);

  // Logo panes: the custom mark always renders opposite Noble's, and either
  // can be switched off — layout per telo_mcc_invoice_config. MDCARE stores
  // noble on the RIGHT (hidden), which is why Medicare's mark prints top-LEFT.
  const nobleVisible = logo?.nobleVisible !== false;
  const customVisible = logo?.customVisible !== false;
  const noblePane = nobleVisible ? (
    <img className="bill__logo bill__logo--noble" src="/branding/noble-logo.png" alt="Noble Diagnostics" />
  ) : null;
  const customPane = customVisible && logo?.hasCustom && mccId != null ? (
    <img className="bill__logo bill__logo--custom" src={`/api/invoice-branding/${mccId}/logo`} alt="Partner logo" />
  ) : null;
  const nobleLeft = (logo?.position ?? 'left') === 'left';
  const leftPane = nobleLeft ? noblePane : customPane;
  const rightPane = nobleLeft ? customPane : noblePane;

  return (
    <div className="print print--invoice" data-print-ready={ready ? 'true' : undefined}>
      {/* Screen-only. The one control on the page, and it removes itself from
          the thing it produces. */}
      <div className="print__toolbar">
        <button className="btn btn--primary btn--sm" onClick={() => window.print()}>Print</button>
        <span className="muted" style={{ fontSize: '.78rem' }}>
          {isLabCopy ? 'Lab copy — includes sample IDs' : 'Costing copy — no sample IDs'}
        </span>
      </div>

      <div className="bill">
        {/* ── Header: [left logo] | lab name block | [right logo] ── */}
        <div className="bill__band bill__head">
          <div className="bill__head-side bill__head-side--left">{leftPane}</div>
          <div className="bill__head-centre">
            <p className="bill__labname">{labName}</p>
            {addressLine && <p className="bill__headline">{addressLine}</p>}
            {(config?.phone || config?.email) && (
              <p className="bill__headline">
                {config?.phone && <>Ph: {config.phone}</>}
                {config?.phone && config?.email && <span className="bill__sep">|</span>}
                {config?.email && <>Email: {config.email}</>}
              </p>
            )}
          </div>
          <div className="bill__head-side bill__head-side--right">{rightPane}</div>
        </div>

        {/* ── Bill meta ── */}
        <div className="bill__band bill__meta">
          <div className="bill__meta-item">
            <span className="bill__label">Bill No.</span>
            <span className="bill__meta-no">{order.billNumber ?? order.billId}</span>
          </div>
          <div className="bill__meta-item">
            <span className="bill__label">Date</span>
            <span>{fmtIST(order.billDate)}</span>
          </div>
        </div>

        {/* ── Patient details ── */}
        <div className="bill__band">
          <p className="bill__label bill__section-label">Patient Details</p>
          <div className="bill__rows">
            <Row label="Name" value={order.patientName ?? '—'} />
            {order.patientId != null && <Row label="PID" value={String(order.patientId)} mono />}
            <Row label="Age / Sex" value={`${order.age ?? '—'} / ${genderLabel}`} />
            <Row label="Mobile" value={order.mobile ?? '—'} />
            {order.email && <Row label="Email" value={order.email} />}
            {order.refCustomerName && <Row label="MRD / Visit" value={order.refCustomerName} />}
            {order.refDoctorName && <Row label="Ref. doctor" value={order.refDoctorName} />}
            {order.paymentType && <Row label="Payment" value={order.paymentType} />}
          </div>
          {order.clinicalHistory && (
            <div className="bill__history">
              <span className="bill__label">Clinical history</span>
              <p>{order.clinicalHistory}</p>
            </div>
          )}
        </div>

        {/* ── Line items ── */}
        <div className="bill__band">
          <p className="bill__label bill__section-label">Services</p>
          <table className="bill__table">
            <thead>
              <tr>
                <th className="bill__th-idx">#</th>
                <th>Description</th>
                <th className="bill__th-amt">Amount (₹)</th>
              </tr>
            </thead>
            <tbody>
              {order.lines.map((l, idx) => (
                <tr key={l.lineId}>
                  <td className="bill__td-idx">{idx + 1}</td>
                  <td>
                    {plainText(l.testName) || l.testCode || '—'}
                    {l.isExternal && <sup className="bill__ext">*</sup>}
                    {l.cancelled && <span className="bill__cancelled"> (cancelled)</span>}
                  </td>
                  <td className="bill__td-amt">{l.cancelled ? '—' : inr(l.amount)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={2} className="bill__subtotal-label">Sub-total</td>
                <td className="bill__td-amt bill__subtotal-amt">{inr(subTotal)}</td>
              </tr>
            </tfoot>
          </table>
        </div>

        {/* ── Samples: the whole difference between the two copies ── */}
        {isLabCopy && order.samples.length > 0 && (
          <div className="bill__band">
            <p className="bill__label bill__section-label">Samples</p>
            <table className="bill__table">
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
                    <td className="bill__mono">{s.vailid}</td>
                    <td>{s.sampleTypeName}</td>
                    <td>{s.testCodes ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* ── Payment history ── */}
        {billReceipts.length > 0 && (
          <div className="bill__band">
            <p className="bill__label bill__section-label">
              Payments &amp; Refunds · {billReceipts.length}
            </p>
            <table className="bill__table">
              <thead>
                <tr>
                  <th className="bill__th-idx">#</th>
                  <th style={{ width: '6rem' }}>Date</th>
                  <th style={{ width: '5rem' }}>Method</th>
                  <th>Reference</th>
                  <th style={{ width: '6rem' }}>Txn ID</th>
                  <th className="bill__th-amt" style={{ width: '6rem' }}>Amount (₹)</th>
                </tr>
              </thead>
              <tbody>
                {billReceipts.map((rcpt, idx) => {
                  const isRefund = rcpt.kind === 'refund';
                  return (
                    <tr key={rcpt.receiptId}>
                      <td className="bill__td-idx">{idx + 1}</td>
                      <td>{rcpt.date ? fmtIST(rcpt.date) : '—'}</td>
                      <td>
                        {rcpt.method ?? 'Cash'}
                        {isRefund && <span className="bill__refund-badge">refund</span>}
                      </td>
                      <td className="bill__mono bill__mono--dim">{rcpt.reference ?? '—'}</td>
                      <td className="bill__mono">{rcpt.txnId ?? '—'}</td>
                      <td className={`bill__td-amt${isRefund ? ' bill__td-amt--refund' : ''}`}>
                        {isRefund ? '− ' : ''}
                        {inr(rcpt.amount)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* ── Summary ── */}
        <div className="bill__band">
          <div className="bill__summary">
            <SummaryRow label="Amount" value={inr(order.amount)} />
            {order.discount > 0 && <SummaryRow label="Discount" value={`− ${inr(order.discount)}`} />}
            <SummaryRow label="Net paid" value={inr(order.amountPaid)} />
            <div className="bill__sumdue">
              <SummaryRow label="Balance Due" value={inr(order.balance)} bold />
            </div>
            <p className="bill__behalf">On behalf of {onBehalfName}</p>
          </div>
        </div>

        {/* ── Prepared by ── */}
        {preparedBy && (
          <div className="bill__band bill__band--slim">
            <p className="bill__prepared">
              <span className="bill__prepared-label">Prepared By:</span> {preparedBy}
            </p>
          </div>
        )}

        {/* ── Notes ── */}
        <div className="bill__band">
          <p className="bill__notes-label">Note:</p>
          <ol className="bill__notes">
            <li>Not Valid for medico legal use.</li>
            <li>Non refundable, subject to realization of cheque.</li>
            <li>All above services are exempted under GST.</li>
            {hasExternal && (
              <li>
                Service(s) marked <b>*</b> are performed by the referring
                facility, not by Noble Diagnostics. Noble has billed them on
                the facility&rsquo;s behalf and is not responsible for their
                conduct, results or interpretation.
              </li>
            )}
          </ol>
        </div>

        {/* ── Disclaimer (toggle: default on, MDCARE off) ── */}
        {flags.showDisclaimer && disclaimer && (
          <div className="bill__band bill__band--slim">
            <p className="bill__disclaimer">{disclaimer}</p>
          </div>
        )}

        {/* ── Footer ── */}
        <div className="bill__foot">
          <p className="bill__generated">This is a computer-generated bill.</p>
          {flags.showSignatory && (
            <div className="bill__sign">
              <div className="bill__sign-line" />
              <p className="bill__sign-title">Authorised Signatory</p>
              <p className="bill__sign-name">{labName}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
