import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { InfinityLoader } from '../components/InfinityLoader';
import { fmtDateTime } from '../lib/format';

/**
 * The home page a COLLECTION CENTRE sees.
 *
 * The lab's Dashboard is an operational one — day counts, turnaround, workload
 * — and it is gated on analytics:view, which the client role deliberately does
 * not hold. So a centre signing in was shown "No analytics access", which is
 * accurate and useless: it explains a permission rather than answering the two
 * questions a centre actually opens Infinity for. What do I owe, and did my
 * reports come through.
 *
 * So clients get their own landing page instead of a locked one. Everything
 * here comes from endpoints that were already client-scoped — the account list
 * returns exactly one row for a centre, and the ledger is their own — so this
 * screen adds a view, not an access path.
 *
 * Deliberately NOT here: a "pay now" button. Online payment is a money-moving
 * integration, the legacy Razorpay pages are excluded from the deployed LIS
 * build, and the one endpoint that credits a wallet does so with no payment
 * verification at all. Until a gateway is chosen, this page tells a centre what
 * is owed and how to settle it rather than pretending to take the money.
 */

interface AccountRow {
  mccId: number;
  clientCode: string | null;
  clientName: string | null;
  balance: number;
  owed: number;
  totalDeposited: number;
}

interface LedgerRow {
  id: number;
  occurredAt: string | null;
  amount: number;
  direction: string;
  note: string | null;
  reference: string | null;
}

const inr = (n: number) =>
  '₹' + Math.abs(Math.round(n)).toLocaleString('en-IN');

export function ClientHome() {
  const { user } = useAuth();
  const [account, setAccount] = useState<AccountRow | null>(null);
  const [ledger, setLedger] = useState<LedgerRow[]>([]);
  const [loading, setLoading] = useState(true);
  // Pre-filled with what is owed, because that is the amount a centre almost
  // always means. Editable, because part-payment is normal.
  const [payAmount, setPayAmount] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const a = await api.get<{ rows: AccountRow[] }>('/api/accounts/');
      const mine = a.rows?.[0] ?? null;
      setAccount(mine);

      if (mine) {
        const l = await api.get<{ rows: LedgerRow[] }>(
          `/api/accounts/${mine.mccId}/ledger?page=1&pageSize=8`);
        // Payments only. A centre's question is "what have I paid", and the
        // debit side is every test ever ordered — thousands of rows that would
        // bury it.
        setLedger((l.rows ?? []).filter((r) => r.direction === 'credit'));
        if (mine.owed > 0) setPayAmount(String(Math.round(mine.owed)));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load your account.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (loading) {
    return <div className="center" style={{ minHeight: 300 }}><InfinityLoader /></div>;
  }

  /*
   * The sign convention, said once and in words.
   *
   * currentbalance is stored NEGATIVE when a centre owes the lab, which reads
   * backwards to everyone who is not looking at the table. `owed` is the
   * repository's already-flipped figure; this page never does arithmetic on the
   * raw balance so the flip cannot happen twice.
   */
  const owes = (account?.owed ?? 0) > 0;

  return (
    <div className="page clienthome-page">
      <div className="page__head">
        <div>
          <h1 className="page__title">
            {account?.clientName?.trim() || user?.displayName || user?.username}
          </h1>
          <p className="page__sub">
            {account?.clientCode ? <span className="mono">{account.clientCode}</span> : null}
            {account?.clientCode ? ' · ' : ''}Your account with Noble
          </p>
        </div>
        <button className="btn btn--ghost btn--sm" style={{ marginLeft: 'auto' }}
                onClick={() => void load()}>Refresh</button>
      </div>

      {error && <div className="alert alert--error">{error}</div>}

      {!account ? (
        <div className="card">
          <p className="muted" style={{ margin: 0 }}>
            No account is linked to this login yet. The lab can attach one.
          </p>
        </div>
      ) : (
        <div className="clienthome">
          {/* Left: what the account IS. Right: what to do about it.

              Two columns rather than one long scroll, because the balance and
              the payment belong side by side - a centre reading what it owes
              is one glance from acting on it. Collapses to a single column
              below 900px, balance first. */}
          <div className="clienthome__main">
            <section className={`card clienthome__balance${owes ? ' clienthome__balance--owing' : ''}`}>
              <p className="clienthome__label">Account balance</p>
              <p className="clienthome__amount">{inr(account.owed || account.balance)}</p>
              <p className="clienthome__note">
                {owes
                  ? 'Outstanding — payable to Noble'
                  : 'In credit — advance balance with Noble'}
              </p>
  
              <div className="clienthome__split">
                <div>
                  <p className="clienthome__label">Total paid</p>
                  <p className="clienthome__sub">{inr(account.totalDeposited)}</p>
                </div>
                <div>
                  <p className="clienthome__label">Reports</p>
                  <p className="clienthome__sub">
                    <Link to="/reports">Open reporting →</Link>
                  </p>
                </div>
              </div>
            </section>
  
            <section className="card">
              <div className="row" style={{ alignItems: 'baseline', gap: '.6rem' }}>
                <h2 className="clienthome__title">Recent payments</h2>
                <Link to="/accounts" className="muted" style={{ marginLeft: 'auto', fontSize: '.78rem' }}>
                  Full account →
                </Link>
              </div>
  
              {ledger.length === 0 ? (
                <p className="muted" style={{ fontSize: '.82rem', marginTop: '.6rem' }}>
                  No payments recorded yet.
                </p>
              ) : (
                <ul className="clienthome__pay">
                  {ledger.map((r) => (
                    <li key={r.id}>
                      <span>
                        {r.occurredAt ? fmtDateTime(r.occurredAt) : '—'}
                        {r.note && <span className="muted"> · {r.note}</span>}
                      </span>
                      <b>{inr(r.amount)}</b>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>

          <div className="clienthome__side">
            {/* Pay Noble online.
  
                Shown even though the gateway is not connected yet: a centre needs
                to know online payment is coming and where it will be. The button
                is disabled and SAYS why - a live-looking control that silently
                does nothing is worse than an honest one.
  
                It will not become live by editing this file. Crediting a wallet
                needs a CCAvenue response decrypted and matched server-side
                against an intent minted before the customer left - see
                111_table_inf_payment_intent.sql. The legacy razor_update.asmx
                credits from caller-supplied values with no verification at all;
                the intent record exists so that shape is never repeated. */}
            <section className="card">
              <h2 className="clienthome__title">Pay Noble online</h2>
              <p className="muted" style={{ fontSize: '.78rem', margin: '.25rem 0 .8rem' }}>
                Instant, secure settlement to your account
              </p>
  
              <label className="field">
                <span>Amount to pay</span>
                <input
                  className="input mono"
                  inputMode="numeric"
                  value={payAmount}
                  onChange={(e) => setPayAmount(e.target.value.replace(/[^0-9]/g, ''))}
                  aria-label="Amount to pay"
                />
              </label>
  
              <p className="muted" style={{ fontSize: '.76rem', margin: '.5rem 0 .7rem' }}>
                {owes
                  ? inr(account.owed) + ' is currently outstanding.'
                  : 'Your account is settled — anything paid now is held as advance credit.'}
              </p>
  
              <button className="btn btn--primary" disabled style={{ width: '100%' }}>
                Pay securely
              </button>
              <p className="clienthome__pending">
                Online payments are being set up — please check back shortly.
              </p>
            </section>
  
            <section className="card">
              <h2 className="clienthome__title">Settling your account</h2>
              <p className="muted" style={{ fontSize: '.82rem', marginTop: '.4rem' }}>
                {owes
                  ? `${inr(account.owed)} is outstanding. Payments are settled with the lab
                     directly and appear here once recorded.`
                  : `Your account is settled. Anything paid now is held as advance credit.`}
              </p>
              {/* No pay button until a verified gateway exists — see the file
                  remarks. Saying how to pay beats a control that cannot. */}
            </section>
          </div>
        </div>
      )}
    </div>
  );
}
