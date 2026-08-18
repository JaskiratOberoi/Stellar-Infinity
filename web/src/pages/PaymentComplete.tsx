import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { InfinityLoader } from '../components/InfinityLoader';
import { fmtDateTime } from '../lib/format';

/**
 * Where a customer lands after paying.
 *
 * ── WHY THIS PAGE IS PUBLIC ────────────────────────────────────────────────
 * The old redirect went to /client, which is behind the session guard. The
 * return from CCAvenue is a cross-site navigation, and the session cookie is
 * SameSite=Strict, so the browser sent nothing — the SPA saw no session and
 * bounced the customer to the login screen seconds after taking their money.
 * The worst possible moment to look broken.
 *
 * Loosening the cookie to Lax would fix the symptom and give back CSRF
 * resistance that moving the JWT into a cookie was meant to buy. So this page
 * needs no session at all: the callback signs the order reference and the
 * token in the URL is what opens the receipt. See PaymentReceiptLink.
 *
 * ── WHAT IT SAYS ───────────────────────────────────────────────────────────
 * The outcome first, in a sentence, because that is the only thing anyone
 * standing here wants. Then the detail worth keeping — reference, instrument,
 * time — then a PDF and a way back. A failed payment says plainly that nothing
 * was charged; a mismatch deliberately does NOT, because we do not know.
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

/** The headline, keyed on what the callback decided. */
const OUTCOME: Record<string, { title: string; body: string; tone: string }> = {
  success: {
    title: 'Payment received',
    body: 'Thank you — your account has been credited.',
    tone: 'ok',
  },
  cancelled: {
    title: 'Payment cancelled',
    body: 'Nothing has been charged.',
    tone: 'warn',
  },
  failed: {
    title: 'Payment not completed',
    body: 'Nothing has been charged. You can try again from your account page.',
    tone: 'error',
  },
  invalid: {
    title: 'We could not read that response',
    body: 'If money has left your account, contact the lab with the time and amount — do not pay again.',
    tone: 'error',
  },
  /* Deliberately not worded as a failure. A mismatch means the gateway
     reported an amount we did not ask for: we have credited nothing, but we
     cannot promise they were not charged, and saying "nothing was charged"
     would be a guess about someone's money. */
  mismatch: {
    title: 'We could not confirm that payment',
    body: 'Nothing has been credited to your account. If your bank shows a charge, '
        + 'contact the lab with the time and amount and it will be traced — do not pay again.',
    tone: 'error',
  },
  error: {
    title: 'Something went wrong recording that payment',
    body: 'Please contact the lab before trying again.',
    tone: 'error',
  },
  unavailable: {
    title: 'Online payment is not available',
    body: 'This deployment has no payment gateway configured.',
    tone: 'warn',
  },
};

export function PaymentComplete() {
  const [params] = useSearchParams();
  const pay = params.get('pay') ?? 'error';
  const ref = params.get('ref');
  const token = params.get('t');

  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [loading, setLoading] = useState(ref != null && token != null);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const outcome = OUTCOME[pay] ?? OUTCOME.error;

  useEffect(() => {
    if (!ref || !token) return;
    let live = true;
    // Plain fetch, not the api client: that one attaches CSRF headers and
    // handles 401 by bouncing to login, which is exactly what must not happen
    // on this page.
    fetch(`/api/payments/receipt/${encodeURIComponent(ref)}?t=${encodeURIComponent(token)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((r: Receipt | null) => { if (live) { setReceipt(r); setLoading(false); } })
      .catch(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [ref, token]);

  /* The PDF arrives as a blob so the browser saves it under the name the
     server chose, rather than navigating away from this page to a URL that
     would then need the token again. */
  const download = useCallback(async () => {
    if (!ref || !token) return;
    setDownloading(true);
    setError(null);
    try {
      const r = await fetch(
        `/api/payments/receipt/${encodeURIComponent(ref)}/pdf?t=${encodeURIComponent(token)}`);
      if (!r.ok) throw new Error('The receipt could not be produced.');
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Receipt_${ref}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The receipt could not be produced.');
    } finally {
      setDownloading(false);
    }
  }, [ref, token]);

  return (
    <div className="paydone">
      <section className={`card paydone__card paydone__card--${outcome.tone}`}>
        <div className={`paydone__mark paydone__mark--${outcome.tone}`} aria-hidden="true">
          {outcome.tone === 'ok' ? '✓' : outcome.tone === 'warn' ? '!' : '×'}
        </div>

        <h1 className="paydone__title">{outcome.title}</h1>
        <p className="paydone__body">{outcome.body}</p>

        {loading && <div className="center" style={{ padding: '1.2rem 0' }}><InfinityLoader /></div>}

        {receipt && (
          <dl className="paydone__facts">
            <div><dt>Amount</dt><dd className="paydone__amount">{inr(receipt.amount)}</dd></div>
            {receipt.clientName && (
              <div>
                <dt>Account</dt>
                <dd>
                  {receipt.clientName}
                  {receipt.clientCode && <span className="muted"> · {receipt.clientCode}</span>}
                </dd>
              </div>
            )}
            {receipt.instrument && (
              <div>
                <dt>Paid by</dt>
                <dd>{receipt.instrument}{receipt.card ? ` · ${receipt.card}` : ''}</dd>
              </div>
            )}
            {receipt.reference && (
              <div><dt>Reference</dt><dd className="mono">{receipt.reference}</dd></div>
            )}
            {receipt.paidAt && <div><dt>When</dt><dd>{fmtDateTime(receipt.paidAt)}</dd></div>}
          </dl>
        )}

        {error && <div className="alert alert--error" style={{ marginTop: '.8rem' }}>{error}</div>}

        <div className="paydone__actions">
          {/* Only a settled payment has a receipt to download — offering the
              button on a failure would produce a document saying money moved
              when it did not. */}
          {receipt?.status === 'success' && (
            <button className="btn btn--primary" disabled={downloading} onClick={() => void download()}>
              {downloading ? 'Preparing…' : 'Download receipt (PDF)'}
            </button>
          )}
          {/* A plain link, so it works for someone whose session did expire
              while they were away paying — they land on login and carry on. */}
          <Link className="btn btn--ghost" to="/">Back to home</Link>
        </div>
      </section>
    </div>
  );
}
