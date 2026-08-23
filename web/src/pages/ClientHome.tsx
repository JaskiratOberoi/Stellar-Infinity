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
 * Pay Noble online goes through CCAvenue, and only when the deployment has
 * credentials - /api/payments/config says so, and the card renders as an
 * explanation rather than a button when it does not.
 *
 * The amount this page sends is a REQUEST, not the figure that gets charged.
 * The server mints an intent, and the callback credits the wallet from that
 * intent rather than from anything the gateway or the browser says. The legacy
 * razor_update.asmx credits from three caller-supplied strings with no
 * verification at all; none of that shape is repeated here.
 */

interface AccountRow {
  mccId: number;
  clientCode: string | null;
  clientName: string | null;
  balance: number;
  owed: number;
  totalDeposited: number;
  /** The LIS allowance, stored NEGATIVE: -5000 = may owe up to ₹5,000. */
  creditLimit: number;
  /** Computed server-side, honouring the limit and any unlock. */
  reportsLocked: boolean;
  /** The admin override — reports released regardless of balance. */
  unlocked?: boolean;
  tempUnlocked?: boolean;
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
  const { user, can } = useAuth();
  /*
   * A walk-in-only client (client_b2c / client_reporting — no order:b2b)
   * settles nothing itself: its patients pay at the counter, so a balance
   * demanding payment and a pay-online box are someone else's page. The
   * capability is the discriminator because it IS the fact in question —
   * whether this client ever raises bills that land on its ledger.
   */
  const b2cOnly = !can('order:b2b');
  const [account, setAccount] = useState<AccountRow | null>(null);
  const [ledger, setLedger] = useState<LedgerRow[]>([]);
  const [loading, setLoading] = useState(true);
  // Pre-filled with what is owed, because that is the amount a centre almost
  // always means. Editable, because part-payment is normal.
  const [payAmount, setPayAmount] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [gateway, setGateway] = useState<{ enabled: boolean; maxAmount: number; test: boolean } | null>(null);
  const [paying, setPaying] = useState(false);
  // The outcome of a payment we have just come back from, read from the query
  // string the callback redirected to. Held in state so clearing the URL does
  // not clear the message.
  const [outcome, setOutcome] = useState<string | null>(null);

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

  // Whether to offer the button at all. A failure here is not surfaced: it
  // just means no gateway, which is the same as not being configured.
  useEffect(() => {
    let live = true;
    void api.get<{ enabled: boolean; maxAmount: number; test: boolean }>('/api/payments/config')
      .then((c) => { if (live) setGateway(c); })
      .catch(() => { if (live) setGateway({ enabled: false, maxAmount: 0, test: false }); });
    return () => { live = false; };
  }, []);

  /*
   * Coming back from CCAvenue.
   *
   * The callback redirects here with a single status word - never an amount or
   * a client code, which would put a payment detail into a URL, a browser
   * history and every proxy log in between. The word is taken, the balance is
   * re-read from the server, and the query string is scrubbed so a refresh
   * does not re-announce a payment that happened once.
   */
  useEffect(() => {
    const pay = new URLSearchParams(window.location.search).get('pay');
    if (!pay) return;
    setOutcome(pay);
    window.history.replaceState({}, '', window.location.pathname);
    if (pay === 'success') void load();
  }, [load]);

  /*
   * Hand the customer to CCAvenue.
   *
   * The server mints the intent and returns an ENCRYPTED request; this builds
   * a form around it and submits it. A real form post rather than fetch: the
   * customer has to end up ON the gateway, in their own address bar, where
   * they can see whose page they are typing a card into. That is also why
   * nothing here is in an iframe.
   *
   * The browser never sees the working key - the blob is encrypted server-side
   * - and never decides the amount. It cannot alter what will be charged,
   * only which already-authorised request it submits.
   */
  async function pay() {
    if (!account || paying) return;
    const amount = Number(payAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      setError('Enter an amount to pay.');
      return;
    }

    setPaying(true);
    setError(null);
    try {
      const r = await api.post<{ gatewayUrl: string; accessCode: string; encRequest: string }>(
        '/api/payments/checkout', { mcc: account.mccId, amount: Math.round(amount) });

      const form = document.createElement('form');
      form.method = 'POST';
      form.action = r.gatewayUrl;
      for (const [name, value] of Object.entries({
        encRequest: r.encRequest,
        access_code: r.accessCode,
      })) {
        const input = document.createElement('input');
        input.type = 'hidden';
        input.name = name;
        input.value = value;
        form.appendChild(input);
      }
      document.body.appendChild(form);
      form.submit();
      // Deliberately no setPaying(false): the page is navigating away, and
      // re-enabling the button would invite a second click that mints a
      // second intent for the same money.
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The payment could not be started.');
      setPaying(false);
    }
  }

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

  /*
   * The credit limit, as a centre reads it.
   *
   * The LIS stores it NEGATIVE — -5000 means "may owe up to ₹5,000" — and only
   * a negative value is an allowance; zero or positive mean none, exactly as
   * the report lock treats it. The floor is that same negative number, and the
   * raw balance (also negative when owing) sits above or below it. Headroom is
   * the gap between them: how much more the centre may run up before reports
   * hold. reportsLocked is the server's authoritative answer — it already
   * accounts for permanent and temporary unlocks — so it, not this arithmetic,
   * decides whether to show the hold.
   */
  const creditLimit = account?.creditLimit ?? 0;
  const allowance = creditLimit < 0 ? Math.round(-creditLimit) : 0;
  const floor = creditLimit < 0 ? creditLimit : 0;
  const headroom = Math.round((account?.balance ?? 0) - floor);

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

      {/* The DAY, before the account — the same operational dashboard Telo
          shows a client login: today's revenue, collections and sample
          movement, resolved server-side inside this centre's scope. The
          account below answers "where do I stand"; this answers "how is
          today going", which is what a reception desk opens the page for. */}
      <ClientDayStats />

      {!account ? (
        <div className="card">
          <p className="muted" style={{ margin: 0 }}>
            No account is linked to this login yet. The lab can attach one.
          </p>
        </div>
      ) : (
        <div className="clienthome" style={b2cOnly ? { gridTemplateColumns: 'minmax(0, 1fr)' } : undefined}>
          {/* Left: what the account IS. Right: what to do about it.

              Two columns rather than one long scroll, because the balance and
              the payment belong side by side - a centre reading what it owes
              is one glance from acting on it. Collapses to a single column
              below 900px, balance first. */}
          <div className="clienthome__main">
            {b2cOnly ? (
              <section className="card">
                <p className="clienthome__label">Reports</p>
                <p className="clienthome__sub" style={{ marginTop: '.2rem' }}>
                  <Link to="/reports">Open reporting →</Link>
                </p>
              </section>
            ) : (
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
                  <p className="clienthome__label">Credit limit</p>
                  <p className="clienthome__sub">{allowance > 0 ? inr(allowance) : 'None'}</p>
                  {/* The lock is what a centre actually cares about here: are
                      their reports about to hold, and how much room is left.
                      reportsLocked overrides the headroom line — once held, the
                      gap to the floor is beside the point. */}
                  {account.reportsLocked ? (
                    <p className="clienthome__hint clienthome__hint--warn">Reports on hold</p>
                  ) : account.unlocked || account.tempUnlocked ? (
                    /* The admin override outranks every warning below — telling
                       a RELEASED client to clear the balance is the exact
                       confusion this branch order used to cause. */
                    <p className="clienthome__hint">
                      Reports released{account.tempUnlocked && !account.unlocked ? ' (temporary)' : ''} — override active
                    </p>
                  ) : allowance > 0 ? (
                    <p className="clienthome__hint">
                      {headroom > 0 ? `${inr(headroom)} before reports hold` : 'At your limit'}
                    </p>
                  ) : owes ? (
                    <p className="clienthome__hint clienthome__hint--warn">Clear the balance to release reports</p>
                  ) : null}
                </div>
                <div>
                  <p className="clienthome__label">Reports</p>
                  <p className="clienthome__sub">
                    <Link to="/reports">Open reporting →</Link>
                  </p>
                </div>
              </div>
            </section>
            )}
  
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

          {!b2cOnly && (
          <div className="clienthome__side">
            {/* Pay Noble online.

                Rendered three ways, and which one you get is decided by the
                server, not by this file. No gateway configured on the
                deployment means the card explains that instead of showing a
                control that fails on click - a live-looking button that does
                nothing is worse than an honest absence. */}
            <section className="card">
              <h2 className="clienthome__title">Pay Noble online</h2>
              <p className="muted" style={{ fontSize: '.78rem', margin: '.25rem 0 .8rem' }}>
                Instant, secure settlement to your account
              </p>

              {/* The result of the trip we have just returned from. Placed
                  above the amount box so it is the first thing read. */}
              {outcome === 'success' && (
                <div className="alert alert--ok" style={{ marginBottom: '.7rem' }}>
                  Payment received — your balance below is up to date.
                </div>
              )}
              {outcome === 'cancelled' && (
                <div className="alert" style={{ marginBottom: '.7rem' }}>
                  Payment cancelled. Nothing has been charged.
                </div>
              )}
              {(outcome === 'failed' || outcome === 'invalid') && (
                <div className="alert alert--error" style={{ marginBottom: '.7rem' }}>
                  That payment did not go through. Nothing has been charged — please try again.
                </div>
              )}
              {/* A mismatch means the gateway reported an amount we did not ask
                  for. Nothing was credited, and this deliberately does NOT say
                  "failed": if money did leave their account, telling them it
                  failed would be wrong. It says what we know and who to ask. */}
              {outcome === 'mismatch' && (
                <div className="alert alert--error" style={{ marginBottom: '.7rem' }}>
                  We could not confirm that payment and have not credited it. If your
                  bank shows a charge, contact the lab with the time and amount and it
                  will be traced — do not pay again.
                </div>
              )}
              {outcome === 'error' && (
                <div className="alert alert--error" style={{ marginBottom: '.7rem' }}>
                  Something went wrong recording that payment. Please contact the lab
                  before trying again.
                </div>
              )}

              {gateway?.enabled ? (
                <>
                  <label className="field">
                    <span>Amount to pay</span>
                    <input
                      className="input mono"
                      inputMode="numeric"
                      value={payAmount}
                      onChange={(e) => setPayAmount(e.target.value.replace(/[^0-9]/g, ''))}
                      aria-label="Amount to pay"
                      disabled={paying}
                    />
                  </label>

                  <p className="muted" style={{ fontSize: '.76rem', margin: '.5rem 0 .7rem' }}>
                    {owes
                      ? inr(account.owed) + ' is currently outstanding.'
                      : 'Your account is settled — anything paid now is held as advance credit.'}
                  </p>

                  <button className="btn btn--primary" style={{ width: '100%' }}
                          disabled={paying || !payAmount}
                          onClick={() => void pay()}>
                    {paying ? 'Taking you to CCAvenue…' : 'Pay securely'}
                  </button>

                  {/* Said plainly, because a customer about to type a card
                      number should know they are leaving. */}
                  <p className="muted" style={{ fontSize: '.72rem', marginTop: '.55rem' }}>
                    You will be taken to CCAvenue to pay. Noble never sees your card details.
                  </p>

                  {/* A test gateway takes no real money, and someone will
                      eventually try to settle a real bill through one. */}
                  {gateway.test && (
                    <p className="alert alert--warn" style={{ fontSize: '.72rem', marginTop: '.55rem' }}>
                      Test gateway — no real payment will be taken.
                    </p>
                  )}
                </>
              ) : (
                <p className="muted" style={{ fontSize: '.8rem' }}>
                  Online payment is not available yet. Payments are settled with the lab
                  directly and appear here once recorded.
                </p>
              )}
            </section>
          </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ---- the day's numbers, Telo's client-dashboard shape ---------------- */

interface DayStats {
  date: string;
  bills: number;
  patients: number;
  registrations: number;
  revenue: number;
  collected: number;
  outstanding: number;
  discount: number;
  byStatus: { status: string; count: number }[];
  trend: { date: string; revenue: number }[];
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

function ClientDayStats() {
  const [date, setDate] = useState(todayIso());
  const [stats, setStats] = useState<DayStats | null>(null);
  const [busy, setBusy] = useState(true);

  useEffect(() => {
    let live = true;
    setBusy(true);
    void api.get<{ stats: DayStats }>(`/api/dashboard/my-day?date=${date}`)
      .then((r) => { if (live) setStats(r.stats); })
      .catch(() => { if (live) setStats(null); })
      .finally(() => { if (live) setBusy(false); });
    return () => { live = false; };
  }, [date]);

  // A quiet failure shows nothing rather than an error card: the account
  // below is the page's core, and the day section is an addition to it.
  if (!busy && !stats) return null;

  const t = stats;
  const chip = (label: string, value: string, accent = false) => (
    <div className="card" style={{ padding: '.7rem .9rem', minWidth: '9.5rem', flex: '1 1 9.5rem' }}>
      <p className="clienthome__label" style={{ margin: 0 }}>{label}</p>
      <p style={{ margin: '.15rem 0 0', fontSize: '1.15rem', fontWeight: 600,
                  color: accent ? 'var(--teal)' : undefined }}>{value}</p>
    </div>
  );

  const max = Math.max(1, ...(t?.trend ?? []).map((p) => p.revenue));
  const points = (t?.trend ?? []).map((p, i, arr) =>
    `${(i / Math.max(1, arr.length - 1)) * 100},${34 - (p.revenue / max) * 30}`).join(' ');

  return (
    <section className="card" style={{ marginBottom: '.9rem' }}>
      <div className="row" style={{ flexWrap: 'wrap', gap: '.6rem', alignItems: 'center' }}>
        <h2 style={{ fontSize: '.95rem', fontWeight: 500, margin: 0 }}>Your day</h2>
        <div className="row" style={{ marginLeft: 'auto', gap: '.35rem' }}>
          <button className="btn btn--ghost btn--sm" onClick={() => setDate((d) => shiftIso(d, -1))}>‹</button>
          <input className="input input--sm" type="date" value={date} max={todayIso()}
                 onChange={(e) => e.target.value && setDate(e.target.value)} />
          <button className="btn btn--ghost btn--sm" disabled={date >= todayIso()}
                  onClick={() => setDate((d) => shiftIso(d, 1))}>›</button>
          <button className="btn btn--ghost btn--sm" disabled={date === todayIso()}
                  onClick={() => setDate(todayIso())}>Today</button>
        </div>
      </div>

      {t && (
        <>
          <div className="row" style={{ flexWrap: 'wrap', gap: '.6rem', marginTop: '.7rem' }}>
            {chip('Revenue', `${inr(t.revenue)} · ${t.bills} bill${t.bills === 1 ? '' : 's'}`, true)}
            {chip('Collected', inr(t.collected))}
            {chip('Outstanding', `${inr(t.outstanding)}${t.discount > 0 ? ` · ${inr(t.discount)} off` : ''}`)}
            {chip('Patients billed', String(t.patients))}
            {chip('Registrations', String(t.registrations))}
          </div>

          {t.byStatus.length > 0 && (
            <div className="row" style={{ flexWrap: 'wrap', gap: '.35rem', marginTop: '.7rem' }}>
              {t.byStatus.map((b) => (
                <span key={b.status} className="badge badge--lis">
                  {b.status}: <b>{b.count}</b>
                </span>
              ))}
            </div>
          )}

          {t.trend.length > 1 && (
            <div style={{ marginTop: '.7rem' }}>
              <p className="clienthome__label" style={{ marginBottom: '.25rem' }}>
                Revenue · 7 days
              </p>
              <svg viewBox="0 0 100 36" preserveAspectRatio="none"
                   style={{ width: '100%', height: 54, display: 'block' }} aria-hidden="true">
                <polyline points={points} fill="none" stroke="var(--teal)"
                          strokeWidth="1.6" vectorEffect="non-scaling-stroke"
                          strokeLinejoin="round" strokeLinecap="round" />
              </svg>
              <div className="row" style={{ justifyContent: 'space-between', fontSize: '.62rem' }}>
                <span className="muted">{t.trend[0]?.date?.slice(5)}</span>
                <span className="muted">{t.trend[t.trend.length - 1]?.date?.slice(5)}</span>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
