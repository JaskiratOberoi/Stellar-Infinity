import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { inr, fmtDate, fmtDateTime, fmtAge, fmtGender } from '../lib/format';
import { InfinityLoader } from '../components/InfinityLoader';

interface OrderLine {
  lineId: number;
  testCode: string | null;
  testName: string | null;
  testType: string | null;
  amount: number;
  cancelled: boolean;
}

interface OrderSample {
  vailid: string;
  sampleTypeName: string;
  testCodes: string | null;
  status: string | null;
}

interface OrderReceipt {
  receiptId: number;
  date: string | null;
  amount: number;
  method: string | null;
  reference: string | null;
  kind: 'payment' | 'refund';
  voided: boolean;
}

interface OrderDetail {
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
  paymentType: string | null;
  clinicalHistory: string | null;
  discount: number;
  amountPaid: number;
  patientId: number | null;
  registeredBy: string | null;
  lines: OrderLine[];
  samples: OrderSample[];
  receipts: OrderReceipt[];
}

export function OrderDetailModal({ billId, onClose }: { billId: number; onClose: () => void }) {
  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [canSeeMoney, setCanSeeMoney] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    api
      .get<{ order: OrderDetail; canSeeMoney: boolean }>(`/api/orders/${billId}`)
      .then((r) => { if (live) { setOrder(r.order); setCanSeeMoney(r.canSeeMoney); } })
      .catch((e) => { if (live) setError(e instanceof Error ? e.message : 'Could not load this order.'); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [billId]);

  // Escape closes, matching every other modal convention.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        style={{ width: 'min(860px, 100%)' }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`Order ${billId}`}
      >
        {loading ? (
          <div className="center" style={{ minHeight: 160 }}><InfinityLoader /></div>
        ) : error ? (
          <>
            <div className="alert alert--error">{error}</div>
            <div className="modal__actions"><button className="btn btn--ghost" onClick={onClose}>Close</button></div>
          </>
        ) : order ? (
          <>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <h2 className="modal__title">Bill {order.billNumber ?? order.billId}</h2>
                <p className="muted" style={{ fontSize: '.8rem', marginTop: '.15rem' }}>
                  {fmtDate(order.billDate)} · {order.clientCode ?? order.mccCode ?? '—'}
                  {order.registeredBy && ` · registered by ${order.registeredBy}`}
                </p>
              </div>
              {canSeeMoney && (
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: '1.3rem', fontWeight: 300 }}>{inr(order.amount)}</div>
                  {order.balance !== 0 && (
                    <div style={{ fontSize: '.8rem', color: order.balance > 0 ? 'var(--danger)' : 'var(--teal)' }}>
                      {order.balance > 0 ? `${inr(order.balance)} due` : `${inr(-order.balance)} credit`}
                    </div>
                  )}
                </div>
              )}
            </div>

            <Section title="Patient">
              <dl className="kv">
                <Kv k="Name" v={order.patientName} />
                <Kv k="Age / Sex" v={`${fmtAge(order.age, order.ageType)} · ${fmtGender(order.gender)}`} />
                <Kv k="Mobile" v={order.mobile} />
                <Kv k="Email" v={order.email} />
                <Kv k="Ref. doctor" v={order.refDoctorName} />
                <Kv k="Ref. customer" v={order.refCustomerName} />
              </dl>
              {order.clinicalHistory && (
                <p className="muted" style={{ fontSize: '.8rem', marginTop: '.6rem', lineHeight: 1.6 }}>
                  <b>Clinical history:</b> {order.clinicalHistory}
                </p>
              )}
            </Section>

            <Section title={`Tests (${order.lines.length})`}>
              <div className="table-wrap" style={{ maxHeight: 220, overflowY: 'auto' }}>
                <table>
                  <tbody>
                    {order.lines.map((l) => (
                      <tr key={l.lineId}>
                        <td className="mono muted" style={{ width: 90 }}>{l.testCode ?? '—'}</td>
                        <td style={l.cancelled ? { textDecoration: 'line-through', opacity: 0.55 } : undefined}>
                          {l.testName ?? '—'}
                          {l.cancelled && <span className="badge badge--lis" style={{ marginLeft: '.5rem' }}>cancelled</span>}
                        </td>
                        {canSeeMoney && <td className="mono" style={{ textAlign: 'right', width: 100 }}>{inr(l.amount)}</td>}
                      </tr>
                    ))}
                    {order.lines.length === 0 && <tr><td className="muted" style={{ padding: '1rem' }}>No test lines.</td></tr>}
                  </tbody>
                </table>
              </div>
            </Section>

            {order.samples.length > 0 && (
              <Section title={`Samples (${order.samples.length})`}>
                <div className="row" style={{ flexWrap: 'wrap', gap: '.5rem' }}>
                  {order.samples.map((s) => (
                    <div key={s.vailid} className="card" style={{ padding: '.5rem .8rem', flex: '0 0 auto' }}>
                      <div className="mono" style={{ fontSize: '.82rem', fontWeight: 600 }}>{s.vailid}</div>
                      <div className="muted" style={{ fontSize: '.7rem' }}>
                        {s.sampleTypeName}{s.status ? ` · ${s.status}` : ''}
                      </div>
                    </div>
                  ))}
                </div>
              </Section>
            )}

            {canSeeMoney && (
              <Section title="Payments">
                {order.receipts.length === 0 ? (
                  <p className="muted" style={{ fontSize: '.82rem' }}>Nothing received against this bill.</p>
                ) : (
                  <div className="table-wrap">
                    <table>
                      <tbody>
                        {order.receipts.map((r) => (
                          <tr key={r.receiptId} style={r.voided ? { opacity: 0.5 } : undefined}>
                            <td className="muted" style={{ width: 150 }}>{fmtDateTime(r.date)}</td>
                            <td>
                              {r.method ?? '—'}
                              {r.reference && <span className="muted"> · {r.reference}</span>}
                              {r.voided && <span className="badge badge--lis" style={{ marginLeft: '.5rem' }}>voided</span>}
                            </td>
                            <td className="mono" style={{
                              textAlign: 'right', width: 110,
                              color: r.kind === 'refund' ? 'var(--danger)' : undefined,
                              textDecoration: r.voided ? 'line-through' : undefined,
                            }}>
                              {r.kind === 'refund' ? `−${inr(r.amount)}` : inr(r.amount)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                <dl className="kv" style={{ marginTop: '.7rem' }}>
                  {order.discount > 0 && <Kv k="Discount" v={inr(order.discount)} />}
                  <Kv k="Paid" v={inr(order.amountPaid)} />
                  <Kv k="Payment type" v={order.paymentType} />
                </dl>
              </Section>
            )}

            <div className="modal__actions">
              <button className="btn btn--ghost" onClick={onClose}>Close</button>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 style={{
        fontSize: '.66rem', fontWeight: 600, letterSpacing: '.14em', textTransform: 'uppercase',
        color: 'var(--ink-dim)', marginBottom: '.5rem',
      }}>
        {title}
      </h3>
      {children}
    </section>
  );
}

function Kv({ k, v }: { k: string; v: string | number | null | undefined }) {
  if (v === null || v === undefined || v === '') return null;
  return (
    <>
      <dt>{k}</dt>
      <dd>{v}</dd>
    </>
  );
}
