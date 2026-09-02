import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { loadClients, type ClientOption } from '../components/ClientPicker';
import { InfinityLoader } from '../components/InfinityLoader';
import { useAuth } from '../auth/AuthContext';

/**
 * Home for a SUB-FRANCHISE login — a child code under a parent client
 * (UP0014A under UP0014).
 *
 * The LIS gives these accounts three doors and no windows: raise an order,
 * read their own reports, pay Noble. No balance, no ledger, no day figures —
 * the money is the PARENT's business, and the API enforces that (no
 * billing:view on the sub_client role), so this page deliberately fetches
 * none of it rather than rendering 403s. The pay card takes an amount cold,
 * exactly as the LIS offers it.
 */
export function SubClientHome() {
  const { user } = useAuth();
  const [centre, setCentre] = useState<ClientOption | null>(null);
  const [loading, setLoading] = useState(true);
  const [gateway, setGateway] = useState<{ enabled: boolean } | null>(null);
  const [payAmount, setPayAmount] = useState('');
  const [paying, setPaying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void Promise.allSettled([
      loadClients().then((c) => { if (live) setCentre(c[0] ?? null); }),
      api.get<{ enabled: boolean }>('/api/payments/config')
        .then((g) => { if (live) setGateway(g); })
        .catch(() => { /* no gateway configured — the card says so */ }),
    ]).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, []);

  /* The same CCAvenue hand-off ClientHome performs: the server mints the
     encrypted intent, a REAL form post lands the customer on the gateway in
     their own address bar. The browser never decides the amount charged. */
  async function pay() {
    if (!centre || paying) return;
    const amount = Number(payAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      setError('Enter an amount to pay.');
      return;
    }
    setPaying(true);
    setError(null);
    try {
      const r = await api.post<{ gatewayUrl: string; accessCode: string; encRequest: string }>(
        '/api/payments/checkout', { mcc: centre.id, amount: Math.round(amount) });
      const form = document.createElement('form');
      form.method = 'POST';
      form.action = r.gatewayUrl;
      for (const [name, value] of Object.entries({ encRequest: r.encRequest, access_code: r.accessCode })) {
        const input = document.createElement('input');
        input.type = 'hidden';
        input.name = name;
        input.value = value;
        form.appendChild(input);
      }
      document.body.appendChild(form);
      form.submit();
      // No setPaying(false): the page is navigating away, and re-enabling
      // the button invites a second intent for the same money.
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The payment could not be started.');
      setPaying(false);
    }
  }

  if (loading) return <div className="center" style={{ minHeight: 300 }}><InfinityLoader /></div>;

  return (
    <div className="page">
      <h1 className="page__title">{centre?.name ?? user?.displayName ?? 'Your centre'}</h1>
      <p className="muted" style={{ marginTop: '.2rem' }}>
        {centre && <><b className="mono">{centre.code}</b> · </>}Your account with Noble
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
                    gap: '1rem', marginTop: '1.2rem', maxWidth: 980 }}>
        <Link to="/orders/new" className="card" style={{ textDecoration: 'none', color: 'inherit' }}>
          <h2 style={{ fontSize: '1.02rem' }}>Book a patient</h2>
          <p className="muted" style={{ fontSize: '.82rem', marginTop: '.4rem', lineHeight: 1.6 }}>
            Raise an order for your centre — enter the patient, pick the tests, submit.
          </p>
        </Link>

        <Link to="/reports" className="card" style={{ textDecoration: 'none', color: 'inherit' }}>
          <h2 style={{ fontSize: '1.02rem' }}>Reports</h2>
          <p className="muted" style={{ fontSize: '.82rem', marginTop: '.4rem', lineHeight: 1.6 }}>
            Every report for your own centre — view, download, track pending samples.
          </p>
        </Link>

        <div className="card">
          <h2 style={{ fontSize: '1.02rem' }}>Pay Noble online</h2>
          {gateway?.enabled ? (
            <>
              <p className="muted" style={{ fontSize: '.82rem', marginTop: '.4rem' }}>
                Instant, secure settlement through CCAvenue.
              </p>
              <div className="field" style={{ marginTop: '.6rem' }}>
                <label htmlFor="sub-pay">Amount to pay</label>
                <input id="sub-pay" className="input mono" inputMode="numeric" value={payAmount}
                       onChange={(e) => setPayAmount(e.target.value.replace(/\D/g, ''))} />
              </div>
              {error && <p style={{ color: 'var(--danger)', fontSize: '.8rem', marginTop: '.4rem' }}>{error}</p>}
              <button className="btn btn--primary" style={{ marginTop: '.6rem', width: '100%' }}
                      disabled={paying || !centre} onClick={() => void pay()}>
                {paying ? 'Opening the gateway…' : 'Pay securely'}
              </button>
              <p className="muted" style={{ fontSize: '.72rem', marginTop: '.5rem' }}>
                You will be taken to CCAvenue to pay. Noble never sees your card details.
              </p>
            </>
          ) : (
            <p className="muted" style={{ fontSize: '.82rem', marginTop: '.4rem', lineHeight: 1.6 }}>
              Online payment is not enabled right now — contact the lab to settle your account.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
