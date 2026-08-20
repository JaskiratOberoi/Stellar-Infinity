import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  accountsApi, PAYMENT_MODES,
  type ClientAccount, type LedgerEntry,
} from '../api/client';
import { fmtDateTime, inr } from '../lib/format';
import { Pager } from '../components/Pager';
import { InfinityLoader } from '../components/InfinityLoader';
import { useAuth } from '../auth/AuthContext';

/**
 * What each client owes, and the movements behind it.
 *
 * THE SIGN IS THE WHOLE POINT. The underlying account is DEBITED when an order
 * is placed and CREDITED when the client pays, so a negative balance means they
 * owe the lab. The API returns both `balance` (raw, for reconciling against the
 * LIS) and `owed` (positive when money is due); this screen shows `owed`,
 * because "₹-1,450" for a debt is how a reader gets it backwards.
 */
export function ClientAccounts() {
  const { can } = useAuth();
  const [rows, setRows] = useState<ClientAccount[]>([]);
  const [total, setTotal] = useState(0);
  const [pageOwed, setPageOwed] = useState(0);
  const [search, setSearch] = useState('');
  /*
   * Off by default: the screen opens on every account, not just the debtors.
   *
   * It defaulted on, which reads as a working list for the lab chasing money —
   * and lands a CLIENT account, who has exactly one account and usually owes
   * nothing, on "No client owes anything here" with an empty table and no clue
   * that a filter is doing it. Opening on everything and letting the operator
   * narrow is the way round that cannot show an empty screen for a full set.
   */
  const [onlyOwing, setOnlyOwing] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(100);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [ledgerFor, setLedgerFor] = useState<ClientAccount | null>(null);
  const [payFor, setPayFor] = useState<ClientAccount | null>(null);
  const [unlockFor, setUnlockFor] = useState<ClientAccount | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await accountsApi.list(search, onlyOwing, page, pageSize);
      setRows(r.rows);
      setTotal(r.total);
      setPageOwed(r.pageOwed);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load accounts.');
    } finally {
      setLoading(false);
    }
  }, [search, onlyOwing, page, pageSize]);

  useEffect(() => {
    const t = setTimeout(() => void load(), 300);
    return () => clearTimeout(t);
  }, [load]);

  useEffect(() => { setPage(1); }, [search, onlyOwing, pageSize]);

  /*
   * A client whose scope holds ONE tagged code is not browsing a list — the
   * account IS their page, so it renders as one: balance and report standing
   * in the header, the ledger inline, Sales one click away. No modal, no
   * one-row table whose only affordance is a button. Derived, not stored:
   * the pristine unfiltered set having exactly one row is the whole test, and
   * an operator whose search narrows to one row never qualifies because the
   * single view has no search box to narrow with.
   *
   * Accounts holding several codes keep the Telo shape — the list, the
   * ledger dialog, Sales links per row.
   */
  const single = !search.trim() && !onlyOwing && page === 1
    && total === 1 && rows.length === 1 ? rows[0] : null;

  if (loading && rows.length === 0 && !error) {
    return (
      <div className="page">
        <div className="center"><InfinityLoader /><span className="muted">Loading accounts…</span></div>
      </div>
    );
  }

  if (single) {
    return (
      <div className="page">
        <div className="page__head">
          <div>
            <h1 className="page__title">
              <span className="mono">{single.clientCode}</span>
              <span className="muted" style={{ fontWeight: 400 }}> · {single.clientName ?? ''}</span>
            </h1>
            <p className="page__sub">
              {single.owed > 0
                ? <>Currently owes <b style={{ color: 'var(--danger)' }}>{inr(single.owed)}</b></>
                : single.owed < 0
                  ? <>In credit by <b>{inr(-single.owed)}</b></>
                  : 'Square'}
              {' · reports '}
              {single.unlocked ? 'released'
                : single.tempUnlocked ? 'released (temporary)'
                : single.reportsLocked ? <b style={{ color: 'var(--danger)' }}>held</b>
                : 'going out'}
              {single.creditLimit < 0 && <> · allowed up to {inr(-single.creditLimit)}</>}
            </p>
          </div>
          <div className="row" style={{ marginLeft: 'auto', flexWrap: 'wrap' }}>
            <Link to={`/sales/${single.mccId}`} className="btn btn--ghost btn--sm">
              Sales →
            </Link>
            {can('report:release') && (
              <button className="btn btn--ghost btn--sm" onClick={() => setUnlockFor(single)}>
                {single.unlocked ? 'Re-lock' : 'Release'}
              </button>
            )}
            {can('payment:capture') && (
              <button className="btn btn--primary btn--sm" onClick={() => setPayFor(single)}>
                Record payment
              </button>
            )}
          </div>
        </div>

        {error && <div className="alert alert--error" style={{ marginBottom: '.8rem' }}>{error}</div>}
        {notice && <div className="alert alert--ok" style={{ marginBottom: '.8rem' }}>{notice}</div>}

        <LedgerPanel mccId={single.mccId} />

        {unlockFor && (
          <UnlockModal
            account={unlockFor}
            onClose={() => setUnlockFor(null)}
            onDone={(msg) => { setUnlockFor(null); setNotice(msg); void load(); }}
          />
        )}
        {payFor && (
          <PaymentModal
            account={payFor}
            onClose={() => setPayFor(null)}
            onDone={async (msg) => { setPayFor(null); setNotice(msg); await load(); }}
          />
        )}
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page__head">
        <div>
          <h1 className="page__title">Client accounts</h1>
          <p className="page__sub">
            {/* "owing" is an adjective, so the plural goes on the noun — the
                first version pluralised the wrong word and read "1,806 owings". */}
            {onlyOwing
              ? `${total.toLocaleString()} client${total === 1 ? '' : 's'} owing`
              : `${total.toLocaleString()} account${total === 1 ? '' : 's'}`}
            {/* Explicitly "on this page". Summing the whole filtered set would
                need a second query, and an unqualified total here would be
                read as the lab's entire receivable. */}
            {pageOwed > 0 && ` · ${inr(pageOwed)} owed on this page`}
          </p>
        </div>

        <div className="row" style={{ marginLeft: 'auto', flexWrap: 'wrap' }}>
          <input className="input" placeholder="Search code or name…" value={search}
                 onChange={(e) => setSearch(e.target.value)} style={{ minWidth: 200 }} />
          <label className="row" style={{ gap: '.4rem', fontSize: '.8rem', cursor: 'pointer' }}>
            <input type="checkbox" checked={onlyOwing}
                   onChange={(e) => setOnlyOwing(e.target.checked)} />
            Owing only
          </label>
        </div>
      </div>

      {error && <div className="alert alert--error" style={{ marginBottom: '.8rem' }}>{error}</div>}
      {notice && <div className="alert alert--ok" style={{ marginBottom: '.8rem' }}>{notice}</div>}

      {loading ? (
        <div className="center"><InfinityLoader /><span className="muted">Loading accounts…</span></div>
      ) : (
        <div className="table-wrap table-wrap--cards">
          <table>
            <thead>
              <tr>
                <th>Client</th>
                <th style={{ textAlign: 'right' }}>Owed</th>
                <th style={{ textAlign: 'right' }}>Deposited</th>
                <th>Last movement</th>
                <th>Reports</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.mccId}>
                  <td className="cell--lead">
                    <b className="mono">{a.clientCode}</b>
                    {!a.isActive && <span className="muted" style={{ fontSize: '.7rem' }}> · inactive</span>}
                    <div className="muted" style={{ fontSize: '.74rem' }}>{a.clientName ?? '—'}</div>
                  </td>

                  <td className="mono cell--tag" style={{ textAlign: 'right', fontWeight: 600 }}>
                    {a.owed > 0
                      ? <span style={{ color: 'var(--danger)' }}>{inr(a.owed)}</span>
                      : a.owed < 0
                        // Negative owed = they are in credit. Said in words,
                        // because a minus sign in a column headed "Owed" is
                        // exactly the ambiguity this screen exists to remove.
                        ? <span className="muted">{inr(-a.owed)} in credit</span>
                        : <span className="muted">—</span>}
                  </td>

                  <td className="mono muted cell--meta" data-label="Deposited" style={{ textAlign: 'right' }}>
                    {a.totalDeposited > 0 ? inr(a.totalDeposited) : '—'}
                  </td>

                  <td className="muted cell--meta" data-label="Last movement" style={{ fontSize: '.76rem' }}>
                    {fmtDateTime(a.lastUpdatedAt)}
                  </td>

                  {/* Whether results actually go out for this client, and why.
                      The balance column says what they owe; this says what that
                      is currently costing them, which is the question an
                      operator on the phone is being asked. */}
                  <td className="cell--meta" data-label="Reports" style={{ fontSize: '.74rem' }}>
                    {a.unlocked ? (
                      <span style={{ color: 'var(--warn)', fontWeight: 600 }}>Released</span>
                    ) : a.tempUnlocked ? (
                      <span style={{ color: 'var(--warn)' }}>Released (temporary)</span>
                    ) : a.reportsLocked ? (
                      <span style={{ color: 'var(--danger)', fontWeight: 600 }}>Held</span>
                    ) : (
                      <span className="muted">Going out</span>
                    )}
                    {a.creditLimit < 0 && (
                      <div className="muted" style={{ fontSize: '.68rem' }}>
                        limit {inr(-a.creditLimit)}
                      </div>
                    )}
                  </td>

                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button className="btn btn--ghost btn--sm" onClick={() => setLedgerFor(a)}>
                      Ledger
                    </button>
                    <Link className="btn btn--ghost btn--sm" to={`/sales/${a.mccId}`}>
                      Sales
                    </Link>
                    {can('report:release') && (
                      <button className="btn btn--ghost btn--sm" style={{ marginLeft: '.4rem' }}
                              onClick={() => setUnlockFor(a)}
                              title={a.unlocked
                                ? 'Put this client back under the balance rule'
                                : 'Release this client’s reports regardless of balance'}>
                        {a.unlocked ? 'Re-lock' : 'Release'}
                      </button>
                    )}
                    {can('payment:capture') && (
                      <button className="btn btn--primary btn--sm" style={{ marginLeft: '.4rem' }}
                              onClick={() => setPayFor(a)}>
                        Record payment
                      </button>
                    )}
                  </td>
                </tr>
              ))}

              {rows.length === 0 && (
                <tr>
                  <td colSpan={6} className="muted" style={{ textAlign: 'center', padding: '2rem' }}>
                    {onlyOwing ? 'No client owes anything here.' : 'No accounts match.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>

          <Pager page={page} pageSize={pageSize} total={total} noun="account"
                 onPage={setPage} onPageSize={setPageSize} />
        </div>
      )}

      {ledgerFor && <LedgerModal account={ledgerFor} onClose={() => setLedgerFor(null)} />}

      {unlockFor && (
        <UnlockModal
          account={unlockFor}
          onClose={() => setUnlockFor(null)}
          onDone={(msg) => { setUnlockFor(null); setNotice(msg); void load(); }}
        />
      )}

      {payFor && (
        <PaymentModal
          account={payFor}
          onClose={() => setPayFor(null)}
          onDone={async (msg) => { setPayFor(null); setNotice(msg); await load(); }}
        />
      )}
    </div>
  );
}

/**
 * The movements behind one client's balance — the table alone, so the ledger
 * dialog (multi-account operators) and the single-account page can render
 * exactly the same rows. `viewport` caps the height for the dialog; the page
 * lets it run.
 */
function LedgerPanel({ mccId, viewport }: { mccId: number; viewport?: boolean }) {
  const [rows, setRows] = useState<LedgerEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const pageSize = 100;

  useEffect(() => {
    let live = true;
    setLoading(true);
    accountsApi.ledger(mccId, page, pageSize)
      .then((r) => { if (live) { setRows(r.rows); setTotal(r.total); } })
      .catch(() => { if (live) setRows([]); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [mccId, page]);

  if (loading) {
    return <div className="center" style={{ minHeight: 140 }}><InfinityLoader /></div>;
  }

  return (
    <div className="table-wrap table-wrap--cards"
         style={viewport ? { maxHeight: '52vh', overflowY: 'auto' } : undefined}>
      <table>
        <thead>
          <tr>
            <th>When</th>
            <th>Movement</th>
            <th style={{ textAlign: 'right' }}>Amount</th>
            <th>Note</th>
            <th>Posted by</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((e) => (
            <tr key={e.id}>
              <td className="muted cell--meta" data-label="When" style={{ fontSize: '.76rem', whiteSpace: 'nowrap' }}>
                {fmtDateTime(e.occurredAt)}
              </td>
              <td className="cell--tag">
                {/* An order consuming credit vs money arriving. Coloured
                    only for the debit, which is the one that increases
                    what they owe. */}
                <span className={`badge badge--lis-status ${e.direction === 'credit' ? 'status--green' : 'status--amber'}`}>
                  {e.direction === 'credit' ? 'payment in' : 'order'}
                </span>
              </td>
              <td className="mono cell--lead" style={{ textAlign: 'right', fontWeight: 600 }}>
                {inr(e.amount)}
              </td>
              <td className="muted cell--body" data-label="Note" style={{ fontSize: '.76rem' }}>
                {e.note ?? '—'}
                {e.reference && <div className="mono" style={{ fontSize: '.7rem' }}>{e.reference}</div>}
              </td>
              <td className="cell--meta" data-label="Posted by">
                {/* A known origin gets its own colour; anything new
                    falls back to the neutral LIS chip rather than to no
                    chip, so an unrecognised value is still legible. */}
                <span className={`badge badge--${
                  ['infinity', 'telo', 'online'].includes(e.origin) ? e.origin : 'lis'}`}>
                  {e.origin}
                </span>
              </td>
            </tr>
          ))}

          {rows.length === 0 && (
            <tr>
              <td colSpan={5} className="muted" style={{ textAlign: 'center', padding: '2rem' }}>
                No movements recorded.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <Pager page={page} pageSize={pageSize} total={total} noun="movement" onPage={setPage} />
    </div>
  );
}

/** The ledger as a dialog, for the multi-account list. */
function LedgerModal({ account, onClose }: { account: ClientAccount; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal--wide" onClick={(e) => e.stopPropagation()}
           role="dialog" aria-modal="true" aria-label={`Ledger for ${account.clientCode}`}>
        <h2 className="modal__title">
          <span className="mono">{account.clientCode}</span>
          <span className="muted" style={{ fontWeight: 400 }}> · {account.clientName ?? ''}</span>
        </h2>
        <p className="muted" style={{ fontSize: '.8rem' }}>
          {account.owed > 0
            ? <>Currently owes <b>{inr(account.owed)}</b></>
            : account.owed < 0
              ? <>In credit by <b>{inr(-account.owed)}</b></>
              : 'Square'}
        </p>

        {/* Sales lives on its own page now — nine columns of itemised lines
            never fit a dialog. The link keeps it one click from where the
            money questions start. */}
        <div className="row" style={{ gap: '.4rem', margin: '.4rem 0 .7rem' }}>
          <Link to={`/sales/${account.mccId}`} className="btn btn--ghost btn--sm">
            Sales →
          </Link>
        </div>

        <LedgerPanel mccId={account.mccId} viewport />

        <div className="modal__actions">
          <button className="btn btn--ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

/**
 * Record a payment from a client.
 *
 * Real money, and the procedure is not idempotent, so the submit button
 * disables on click and the error path says to CHECK the ledger rather than
 * offering a retry — pressing it twice after a timeout would credit them twice.
 */
function PaymentModal({
  account, onClose, onDone,
}: {
  account: ClientAccount;
  onClose: () => void;
  onDone: (message: string) => Promise<void>;
}) {
  const [amount, setAmount] = useState('');
  const [mode, setMode] = useState<number>(3);
  const [reference, setReference] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  const value = Number(amount);
  const valid = Number.isFinite(value) && value > 0;

  async function submit() {
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      const r = await accountsApi.pay(account.mccId, {
        amount: value,
        mode,
        chequeNo: reference.trim() || null,
        reason: reason.trim() || null,
      });
      await onDone(
        `${inr(value)} recorded for ${account.clientCode}.`
        + (r.newBalance != null ? ` Balance is now ${inr(-r.newBalance)} owed.` : ''));
    } catch (e) {
      setError((e instanceof Error ? e.message : 'The payment was not recorded.')
        + ' Check the ledger before trying again — a repeat could credit them twice.');
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={() => { if (!busy) onClose(); }}>
      <div className="modal" onClick={(e) => e.stopPropagation()}
           role="dialog" aria-modal="true" aria-label="Record a payment">
        <h2 className="modal__title">
          Record payment · <span className="mono">{account.clientCode}</span>
        </h2>
        <p className="muted" style={{ fontSize: '.8rem' }}>
          {account.owed > 0 ? <>Currently owes <b>{inr(account.owed)}</b></> : 'Currently square or in credit'}
        </p>

        {error && <div className="alert alert--error">{error}</div>}

        <div className="field">
          <label htmlFor="pay-amount">Amount</label>
          <input id="pay-amount" className="input mono" inputMode="numeric" autoFocus
                 value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ''))} />
        </div>

        <div className="field">
          <label htmlFor="pay-mode">Mode</label>
          <select id="pay-mode" className="input" value={mode}
                  onChange={(e) => setMode(Number(e.target.value))}>
            {PAYMENT_MODES.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        </div>

        <div className="field">
          <label htmlFor="pay-ref">Reference</label>
          <input id="pay-ref" className="input mono" placeholder="Cheque or transaction number"
                 value={reference} onChange={(e) => setReference(e.target.value)} maxLength={50} />
        </div>

        <div className="field">
          <label htmlFor="pay-note">Note</label>
          <input id="pay-note" className="input" value={reason}
                 onChange={(e) => setReason(e.target.value)} maxLength={200} />
        </div>

        <p className="muted" style={{ fontSize: '.72rem', lineHeight: 1.6 }}>
          This credits the client's running account immediately and cannot be undone from here.
        </p>

        <div className="modal__actions">
          <button className="btn btn--ghost" disabled={busy} onClick={onClose}>Cancel</button>
          <button className="btn btn--primary" disabled={!valid || busy} onClick={() => void submit()}>
            {busy ? 'Recording…' : `Record ${valid ? inr(value) : 'payment'}`}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Release a client's reports against the money rule — or put them back.
 *
 * This is the one control on this screen that lets results leave the building
 * unpaid, so it says plainly what it is about to do, shows the debt it is
 * overriding, and will not grant without a reason. Revoking asks for none:
 * putting a client back under the rule is the default state, not a decision
 * that needs defending.
 *
 * It writes the LIS's own flag, so the release also applies in Telo and the
 * legacy LIS — said in the dialog, because someone clicking here is entitled to
 * know the blast radius.
 */
function UnlockModal({
  account, onClose, onDone,
}: {
  account: ClientAccount;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const granting = !account.unlocked;
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  const valid = !granting || reason.trim().length > 0;

  async function submit() {
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      const r = await accountsApi.setUnlock(account.mccId, {
        unlocked: granting,
        reason: reason.trim() || null,
      });
      onDone(
        r.changed
          ? `${r.clientCode} — reports ${granting ? 'released' : 'back under the balance rule'}. ${r.note}`
          : `${r.clientCode} was already ${granting ? 'released' : 'locked'}; nothing changed.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That did not go through.');
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={() => { if (!busy) onClose(); }}>
      <div className="modal" onClick={(e) => e.stopPropagation()}
           role="dialog" aria-modal="true"
           aria-label={granting ? 'Release reports' : 'Re-lock reports'}>
        <h2 className="modal__title">
          {granting ? 'Release reports' : 'Back under the balance rule'} ·{' '}
          <span className="mono">{account.clientCode}</span>
        </h2>

        <p className="muted" style={{ fontSize: '.8rem' }}>
          {account.owed > 0
            ? <>Currently owes <b style={{ color: 'var(--danger)' }}>{inr(account.owed)}</b></>
            : 'Currently square or in credit'}
          {account.creditLimit < 0 && <> · allowed up to {inr(-account.creditLimit)}</>}
        </p>

        {error && <div className="alert alert--error">{error}</div>}

        {granting ? (
          <>
            <p style={{ fontSize: '.82rem', lineHeight: 1.6 }}>
              Their reports will go out however much they owe, until someone puts this back.
            </p>
            <div className="field">
              <label htmlFor="unlock-reason">Why (kept on record)</label>
              <input id="unlock-reason" className="input" autoFocus
                     placeholder="e.g. Director approved — settles monthly"
                     value={reason} onChange={(e) => setReason(e.target.value)} maxLength={400} />
            </div>
          </>
        ) : (
          <p style={{ fontSize: '.82rem', lineHeight: 1.6 }}>
            Their reports will be held again whenever the balance sits below the allowance.
          </p>
        )}

        <p className="muted" style={{ fontSize: '.72rem', lineHeight: 1.6 }}>
          This sets the LIS's own release flag, so it applies in Telo and the legacy LIS too — not
          only here. Reports already opened may take up to a minute to catch up.
        </p>

        <div className="modal__actions">
          <button className="btn btn--ghost" disabled={busy} onClick={onClose}>Cancel</button>
          <button className={granting ? 'btn btn--primary' : 'btn btn--ghost'}
                  disabled={!valid || busy} onClick={() => void submit()}>
            {busy ? 'Saving…' : granting ? 'Release reports' : 'Re-lock'}
          </button>
        </div>
      </div>
    </div>
  );
}
