import { useCallback, useEffect, useState } from 'react';
import { api, billingApi, PAYMENT_MODES } from '../api/client';
import { inr, fmtDate, fmtDateTime, fmtAge, fmtGender, plainText } from '../lib/format';
import { InfinityLoader } from '../components/InfinityLoader';
import { useAuth } from '../auth/AuthContext';

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
  const { can } = useAuth();
  const canCapture = can('payment:capture');

  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [canSeeMoney, setCanSeeMoney] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Money actions on this bill.
  const [money, setMoney] = useState<string | null>(null);
  const [moneyError, setMoneyError] = useState<string | null>(null);
  const [takingPayment, setTakingPayment] = useState(false);
  const [discounting, setDiscounting] = useState(false);
  const [voiding, setVoiding] = useState<OrderReceipt | null>(null);
  const [editing, setEditing] = useState<OrderReceipt | null>(null);

  const reload = useCallback(async () => {
    const r = await api.get<{ order: OrderDetail; canSeeMoney: boolean }>(`/api/orders/${billId}`);
    setOrder(r.order);
    setCanSeeMoney(r.canSeeMoney);
  }, [billId]);

  useEffect(() => {
    let live = true;
    api
      .get<{ order: OrderDetail; canSeeMoney: boolean }>(`/api/orders/${billId}`)
      .then((r) => { if (live) { setOrder(r.order); setCanSeeMoney(r.canSeeMoney); } })
      .catch((e) => { if (live) setError(e instanceof Error ? e.message : 'Could not load this order.'); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [billId]);

  /**
   * Run a money action and refresh.
   *
   * Always reloads the bill afterwards, on failure too: these procedures can
   * partially apply nothing OR everything, and showing a stale balance next to
   * an error is how someone re-submits a payment that already landed.
   */
  const runMoney = useCallback(async (fn: () => Promise<string>) => {
    setMoney(null);
    setMoneyError(null);
    try {
      setMoney(await fn());
    } catch (e) {
      setMoneyError(e instanceof Error ? e.message : 'That did not go through.');
    } finally {
      await reload().catch(() => { /* the message above is the useful part */ });
    }
  }, [reload]);

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
                          {plainText(l.testName) || '—'}
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
                {money && <div className="alert alert--ok" style={{ marginBottom: '.6rem' }}>{money}</div>}
                {moneyError && <div className="alert alert--error" style={{ marginBottom: '.6rem' }}>{moneyError}</div>}

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
                            {/* Corrections only on a live receipt. A voided one
                                is already reversed; editing it would move a
                                balance that no longer includes it. */}
                            <td style={{ textAlign: 'right', width: 150, whiteSpace: 'nowrap' }}>
                              {canCapture && !r.voided && (
                                <>
                                  <button className="btn btn--ghost btn--sm"
                                          onClick={() => setEditing(r)}>Correct</button>
                                  <button className="btn btn--ghost btn--sm" style={{ marginLeft: '.3rem' }}
                                          onClick={() => setVoiding(r)}>Void</button>
                                </>
                              )}
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
                  <Kv k="Balance" v={inr(order.balance)} />
                  <Kv k="Payment type" v={order.paymentType} />
                </dl>

                <div className="row" style={{ marginTop: '.8rem', flexWrap: 'wrap' }}>
                  {canCapture && order.balance > 0 && (
                    <button className="btn btn--primary btn--sm" onClick={() => setTakingPayment(true)}>
                      Record payment · {inr(order.balance)} due
                    </button>
                  )}
                  <button className="btn btn--ghost btn--sm" onClick={() => setDiscounting(true)}>
                    {order.discount > 0 ? 'Change discount' : 'Add discount'}
                  </button>
                </div>
              </Section>
            )}

            <div className="modal__actions">
              {/* Invoices open in their own tab rather than replacing the
                  modal: the operator is usually mid-task on this bill, and a
                  document that navigates away from the order loses the
                  payments panel they were about to use. */}
              {canSeeMoney && (
                <>
                  <button
                    className="btn btn--ghost"
                    onClick={() => window.open(`/print/invoice/${order.billId}`, '_blank', 'noopener')}
                  >
                    Invoice
                  </button>
                  <button
                    className="btn btn--ghost"
                    onClick={() => window.open(`/print/invoice/${order.billId}?copy=lab`, '_blank', 'noopener')}
                    title="Same invoice with the sample IDs listed — for the collection envelope and the lab's file."
                  >
                    Lab copy
                  </button>
                </>
              )}
              <button className="btn btn--ghost" onClick={onClose}>Close</button>
            </div>

            {takingPayment && (
              <MoneyPrompt
                title={`Record payment · bill ${order.billNumber ?? order.billId}`}
                lead={`${inr(order.balance)} outstanding.`}
                amountLabel="Amount"
                defaultAmount={String(order.balance)}
                withMode
                withReference
                confirm="Record"
                // Not idempotent without a reference, so the failure text sends
                // the operator to look rather than press again.
                warning="This is recorded against the bill immediately. If it fails, check the payments list before retrying — a repeat could take the money twice."
                onCancel={() => setTakingPayment(false)}
                onSubmit={async (v) => {
                  setTakingPayment(false);
                  await runMoney(async () => {
                    const r = await billingApi.receipt(order.billId, {
                      amount: v.amount, payMode: v.mode, reference: v.reference || null,
                    });
                    return r.alreadyRecorded
                      ? 'That reference was already recorded — nothing changed.'
                      : `${inr(v.amount)} recorded.`;
                  });
                }}
              />
            )}

            {discounting && (
              <MoneyPrompt
                title={`Discount · bill ${order.billNumber ?? order.billId}`}
                lead={`Bill is ${inr(order.amount)}. Setting a discount changes what the client owes.`}
                amountLabel="Discount"
                defaultAmount={String(order.discount)}
                confirm="Set discount"
                // Absolute, not additive — worth saying, since "add discount"
                // in the button implies otherwise.
                warning="This SETS the discount rather than adding to it. Enter the total discount you want on this bill."
                onCancel={() => setDiscounting(false)}
                onSubmit={async (v) => {
                  setDiscounting(false);
                  await runMoney(async () => {
                    await billingApi.discount(order.billId, v.amount);
                    return v.amount > 0 ? `Discount set to ${inr(v.amount)}.` : 'Discount removed.';
                  });
                }}
              />
            )}

            {voiding && (
              <MoneyPrompt
                title="Void receipt"
                lead={`${inr(voiding.amount)} received ${fmtDateTime(voiding.date)}.`}
                reasonOnly
                confirm="Void it"
                warning="Voiding reverses the receipt and puts the amount back onto the balance. It cannot be undone here."
                onCancel={() => setVoiding(null)}
                onSubmit={async (v) => {
                  const target = voiding;
                  setVoiding(null);
                  await runMoney(async () => {
                    const r = await billingApi.voidReceipt(order.billId, target.receiptId, v.reason || null);
                    return r.alreadyVoided
                      ? 'That receipt was already voided.'
                      : `${inr(target.amount)} voided.`;
                  });
                }}
              />
            )}

            {editing && (
              <MoneyPrompt
                title="Correct receipt amount"
                lead={`Currently ${inr(editing.amount)}, received ${fmtDateTime(editing.date)}.`}
                amountLabel="Corrected amount"
                defaultAmount={String(editing.amount)}
                withReason
                confirm="Correct it"
                warning="The balance moves by the difference. Use this for a mis-keyed amount, not to reverse a payment — void it instead."
                onCancel={() => setEditing(null)}
                onSubmit={async (v) => {
                  const target = editing;
                  setEditing(null);
                  await runMoney(async () => {
                    const r = await billingApi.editReceipt(
                      order.billId, target.receiptId, v.amount, v.reason || null);
                    return r.unchanged
                      ? 'That was already the amount — nothing changed.'
                      : `Corrected ${inr(r.oldAmount ?? target.amount)} to ${inr(v.amount)}.`;
                  });
                }}
              />
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}

/**
 * One dialog for all four money actions.
 *
 * They differ only in which fields they need and what they warn about, and four
 * near-identical components would drift — the warning text is the part that
 * matters most and the part most likely to be edited in only one copy.
 *
 * Every one of them states its consequence before the button, because none can
 * be undone from this screen.
 */
function MoneyPrompt({
  title, lead, warning, confirm,
  amountLabel, defaultAmount, withMode = false, withReference = false,
  withReason = false, reasonOnly = false,
  onCancel, onSubmit,
}: {
  title: string;
  lead: string;
  warning: string;
  confirm: string;
  amountLabel?: string;
  defaultAmount?: string;
  withMode?: boolean;
  withReference?: boolean;
  withReason?: boolean;
  reasonOnly?: boolean;
  onCancel: () => void;
  onSubmit: (v: { amount: number; mode: string; reference: string; reason: string }) => Promise<void>;
}) {
  const [amount, setAmount] = useState(defaultAmount ?? '');
  const [mode, setMode] = useState('Cash');
  const [reference, setReference] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel, busy]);

  const value = Number(amount);
  // A discount of zero is meaningful (it removes one), so only require a
  // parseable non-negative number rather than a positive one.
  const valid = reasonOnly || (Number.isFinite(value) && value >= 0 && amount !== '');

  return (
    <div className="modal-backdrop" style={{ zIndex: 70 }} onClick={() => { if (!busy) onCancel(); }}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true"
           aria-label={title}>
        <h2 className="modal__title">{title}</h2>
        <p className="muted" style={{ fontSize: '.82rem' }}>{lead}</p>

        {!reasonOnly && (
          <div className="field">
            <label htmlFor="mp-amount">{amountLabel}</label>
            <input id="mp-amount" className="input mono" inputMode="numeric" autoFocus
                   value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ''))} />
          </div>
        )}

        {withMode && (
          <div className="field">
            <label htmlFor="mp-mode">Mode</label>
            <select id="mp-mode" className="input" value={mode} onChange={(e) => setMode(e.target.value)}>
              {PAYMENT_MODES.map((m) => <option key={m.id} value={m.label}>{m.label}</option>)}
            </select>
          </div>
        )}

        {withReference && (
          <div className="field">
            <label htmlFor="mp-ref">Reference</label>
            <input id="mp-ref" className="input mono" value={reference} maxLength={100}
                   onChange={(e) => setReference(e.target.value)} />
            <span className="muted" style={{ fontSize: '.7rem' }}>
              A reference makes this safe to repeat — without one, a retry records the money again.
            </span>
          </div>
        )}

        {(withReason || reasonOnly) && (
          <div className="field">
            <label htmlFor="mp-reason">Reason</label>
            <input id="mp-reason" className="input" value={reason} maxLength={200} autoFocus={reasonOnly}
                   onChange={(e) => setReason(e.target.value)} />
          </div>
        )}

        <div className="alert alert--info" style={{ fontSize: '.76rem' }}>{warning}</div>

        <div className="modal__actions">
          <button className="btn btn--ghost" disabled={busy} onClick={onCancel}>Cancel</button>
          <button className="btn btn--primary" disabled={!valid || busy}
                  onClick={() => { setBusy(true); void onSubmit({ amount: value, mode, reference, reason }); }}>
            {busy ? 'Working…' : confirm}
          </button>
        </div>
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
