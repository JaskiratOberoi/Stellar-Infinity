import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { fmtDateTime } from '../lib/format';
import { InfinityLoader } from '../components/InfinityLoader';
import { Pager } from '../components/Pager';

/**
 * The unified audit trail — Telo's Audit tab, over MORE than Telo can see.
 *
 * One feed across four sources: Infinity's business events, its sign-in and
 * account-admin trail, its field-level result trail, and Telo's whole audit
 * log, each row badged with the platform that recorded it. Telo's own viewer
 * reads only its own table; the point of this page is that the lab stops
 * needing to know which system did a thing before it can ask what happened.
 *
 * The vocabulary is shared: the server maps every source onto Telo's dotted
 * kinds, so one label table covers all of it, and an operator who knows
 * Telo's audit tab already reads this one.
 */

interface AuditRow {
  at: string | null;
  origin: 'infinity' | 'telo' | 'lis';
  kind: string;
  actorId: number | null;
  actorName: string | null;
  username: string | null;
  billId: number | null;
  sid: string | null;
  ip: string | null;
  details: string | null;
}

interface AuditResponse {
  rows: AuditRow[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

const CATEGORIES = [
  { value: '', label: 'All activity' },
  { value: 'orders', label: 'Orders & billing' },
  { value: 'payments', label: 'Payments & receipts' },
  { value: 'reports', label: 'Reports' },
  { value: 'results', label: 'Results' },
  { value: 'samples', label: 'Samples' },
  { value: 'users', label: 'Users & admin' },
  { value: 'auth', label: 'Sign-ins & sessions' },
] as const;

/** Category of a kind — mirrors the server's prefix sets. */
function categoryOf(kind: string): string {
  if (kind.startsWith('lis.')) return 'lis';
  if (kind.startsWith('report.')) return 'reports';
  if (kind.startsWith('result.')) return 'results';
  if (kind.startsWith('admin.')) return 'users';
  if (kind.startsWith('login.') || kind.startsWith('session.')) return 'auth';
  if (kind.startsWith('order.') || kind.startsWith('bill.') || kind.startsWith('patient.')) return 'orders';
  if (kind.startsWith('payment.') || kind.startsWith('receipt.') || kind.startsWith('mcc.')) return 'payments';
  if (kind.startsWith('sample.')) return 'samples';
  return 'other';
}

/** Friendly one-line label per kind — Telo's table, extended for the sources
 *  Telo does not have. Falls back to the raw kind. */
const KIND_LABEL: Record<string, string> = {
  'login.success': 'Signed in',
  'login.failure': 'Sign-in failed',
  'login.rate_limited': 'Sign-in rate-limited',
  'session.logout': 'Signed out',
  'session.revoked': 'Session revoked',
  'order.placed': 'Order placed',
  'payment.recorded': 'Payment recorded',
  'payment.refunded': 'Payment refunded',
  'admin.user.create': 'User created',
  'admin.user.update': 'User scope updated',
  'admin.user.scope.partial': 'User scope partially applied',
  'admin.user.role': 'Role changed',
  'admin.user.password': 'Password reset',
  'admin.user.active': 'Account activated/deactivated',
  'admin.user.lis_access': 'LIS access changed',
  'admin.user.mrp_only': 'MRP-only flag changed',
  'admin.user.prepared_by': 'Prepared-by override changed',
  'admin.user.profile': 'User profile changed',
  'admin.profile_interpretation.save': 'Profile interpretation saved',
  'patient.info.update': 'Patient info edited',
  'bill.discount.set': 'Bill discount set',
  'receipt.voided': 'Receipt voided',
  'receipt.amount.edited': 'Receipt amount edited',
  'bill.test.cancelled': 'Test cancelled',
  'bill.booking.cancelled': 'Booking cancelled',
  'bill.booking.cancel.blocked': 'Booking cancel blocked',
  'bill.tests.edited': 'Bill tests edited',
  'mcc.payment.recorded': 'Client payment recorded',
  'mcc.online_payment.initiated': 'Online payment started',
  'mcc.online_payment.result': 'Online payment result',
  'sample.accessioned': 'Samples registered to worksheet',
  'sample.sids_attached': 'Barcodes attached',
  'report.viewed': 'Report viewed',
  'report.pdf': 'Report PDF downloaded',
  'report.pdf_bulk': 'Bulk report PDFs downloaded',
  'report.smart_pdf': 'Smart Report downloaded',
  'result.enter': 'Result entered',
  'result.amend': 'Result amended',
  'result.authorize': 'Result authorised',
  'result.unauthorize': 'Result authorisation withdrawn',
  'result.reopen': 'Result reopened',
  'result.reject': 'Result rejected',
  'result.import': 'Result imported',
};

/** Known detail keys → short display labels; ₹-prefix for money fields. */
const DETAIL_LABEL: Record<string, string> = {
  receiptId: 'receipt', mcc: 'MCC', target: 'user', role: 'role',
  reason: 'reason', status: 'status', count: 'count', requested: 'requested',
  registered: 'registered', skipped: 'skipped', sids: 'SIDs',
  lineId: 'line', cancelled: 'cancelled', refunded: 'refunded',
  items: 'items', custom: 'custom', mode: 'mode', channel: 'channel',
  orderId: 'order', instrument: 'via', reference: 'ref', detail: '',
  test: 'test', field: 'field', source: 'source', patientId: 'PID',
  pid: 'PID', info: 'info',
};
const MONEY_KEYS = new Set(['total', 'amount', 'discount', 'paid', 'refunded', 'newAmount', 'oldAmount']);

/** The LIS trail's free-text FUNCTION_PERFORMED, printed verbatim as the
 *  event — the legacy log has prose where the platforms have kinds. */
function lisAction(row: AuditRow): string {
  try {
    const a = row.details ? (JSON.parse(row.details) as { action?: string }).action : null;
    return a?.trim() || 'LIS activity';
  } catch {
    return 'LIS activity';
  }
}

function chips(row: AuditRow): { k: string; v: string }[] {
  if (!row.details) return [];
  try {
    const obj = JSON.parse(row.details) as Record<string, unknown>;
    return Object.entries(obj)
      // billId/sid already stand as their own chips, extracted server-side —
      // Telo's payloads still carry them inside the JSON too.
      .filter(([k]) => k !== 'billId' && k !== 'sid')
      // 'action' is the LIS row's event text, already printed as the event.
      .filter(([k]) => !(row.kind === 'lis.activity' && k === 'action'))
      .filter(([, v]) => v !== null && v !== undefined && v !== '' && v !== false)
      .map(([k, v]) => ({
        k: DETAIL_LABEL[k] ?? k,
        v: v === true ? 'yes'
          : MONEY_KEYS.has(k) ? `₹${Number(v).toLocaleString('en-IN')}`
          : String(v),
      }));
  } catch {
    return [{ k: 'details', v: row.details.slice(0, 120) }];
  }
}

function todayIso(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function daysAgoIso(days: number): string {
  const d = new Date(Date.now() - days * 86400000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function AuditTrail() {
  const [params] = useSearchParams();

  const [from, setFrom] = useState(daysAgoIso(7));
  const [to, setTo] = useState(todayIso());
  const [category, setCategory] = useState('');
  const [origin, setOrigin] = useState('');
  const [qLive, setQLive] = useState(params.get('bill') ?? params.get('sid') ?? '');
  const [q, setQ] = useState(qLive);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [data, setData] = useState<AuditResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => { setQ(qLive); setPage(1); }, 300);
    return () => clearTimeout(t);
  }, [qLive]);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    const p = new URLSearchParams({ from, to, page: String(page), pageSize: String(pageSize) });
    if (category) p.set('category', category);
    if (origin) p.set('origin', origin);
    const trimmed = q.trim();
    if (trimmed) {
      // A number is far more often a bill than a word in a payload — send it
      // as both, and the bill filter wins where it matches.
      if (/^\d{3,}$/.test(trimmed)) p.set('bill', trimmed);
      p.set('q', trimmed);
    }
    void api.get<AuditResponse>(`/api/audit?${p}`)
      .then((r) => { if (live) setData(r); })
      .catch((e) => { if (live) setError(e instanceof Error ? e.message : 'Could not load the trail.'); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [from, to, category, origin, q, page, pageSize]);

  return (
    <div className="page">
      <div className="page__head">
        <div>
          <h1 className="page__title">Audit trail</h1>
          <p className="page__sub">
            Every consequential action, across Infinity, Telo and the legacy LIS — sign-ins, orders,
            money, reports, results, samples and admin.
          </p>
        </div>
      </div>

      <div className="row" style={{ gap: '.4rem', marginBottom: '.55rem', flexWrap: 'wrap' }}>
        {CATEGORIES.map((c) => (
          <button key={c.value} type="button"
                  className={`btn btn--sm ${category === c.value ? 'btn--primary' : 'btn--ghost'}`}
                  onClick={() => { setCategory(c.value); setPage(1); }}>
            {c.label}
          </button>
        ))}
      </div>

      <div className="row" style={{ gap: '.6rem', marginBottom: '.7rem', flexWrap: 'wrap', alignItems: 'center' }}>
        <input className="input" type="date" style={{ width: 'auto', minWidth: '9.5rem' }}
               value={from} max={to} onChange={(e) => { setFrom(e.target.value); setPage(1); }} />
        <span className="muted">→</span>
        <input className="input" type="date" style={{ width: 'auto', minWidth: '9.5rem' }}
               value={to} min={from} onChange={(e) => { setTo(e.target.value); setPage(1); }} />
        <select className="input" style={{ width: 'auto' }} value={origin}
                onChange={(e) => { setOrigin(e.target.value); setPage(1); }}>
          <option value="">All sources</option>
          <option value="infinity">Infinity only</option>
          <option value="telo">Telo only</option>
          <option value="lis">LIS only</option>
        </select>
        <input className="input" style={{ flex: 1, minWidth: '14rem', maxWidth: 420 }}
               placeholder="Search — bill no., SID, username, anything in an event…"
               value={qLive} onChange={(e) => setQLive(e.target.value)} />
      </div>

      {error && <div className="alert alert--error">{error}</div>}
      {loading && !data && <div className="center"><InfinityLoader /></div>}

      {data && (
        <>
          <div className="table-wrap table-wrap--cards">
            <table>
              <thead>
                <tr>
                  <th style={{ width: '11rem' }}>When</th>
                  <th style={{ width: '5rem' }}>Source</th>
                  <th>Event</th>
                  <th style={{ width: '13rem' }}>Who</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r, i) => {
                  const cat = categoryOf(r.kind);
                  return (
                    <tr key={`${r.origin}-${r.at}-${i}`}>
                      <td className="mono cell--meta" data-label="When">{fmtDateTime(r.at)}</td>
                      <td className="cell--tag">
                        <span className={`audit__origin audit__origin--${r.origin}`}>{r.origin}</span>
                      </td>
                      <td className="cell--lead">
                        <span className={`audit__cat audit__cat--${cat}`}>{cat}</span>{' '}
                        {r.kind === 'lis.activity' ? lisAction(r) : (KIND_LABEL[r.kind] ?? r.kind)}
                      </td>
                      <td className="cell--head">
                        {r.actorName ?? r.username ?? (r.actorId != null ? `#${r.actorId}` : '—')}
                        {r.ip && <span className="muted audit__ip"> · {r.ip}</span>}
                      </td>
                      <td className="cell--body">
                        <span className="audit__chips">
                          {r.billId != null && <span className="audit__chip"><b>bill</b> {r.billId}</span>}
                          {r.sid && <span className="audit__chip"><b>SID</b> {r.sid}</span>}
                          {chips(r).map((c, n) => (
                            <span key={n} className="audit__chip">
                              {c.k && <b>{c.k}</b>} {c.v}
                            </span>
                          ))}
                        </span>
                      </td>
                    </tr>
                  );
                })}
                {data.rows.length === 0 && (
                  <tr><td colSpan={5} className="muted">No activity matches these filters.</td></tr>
                )}
              </tbody>
            </table>
          </div>

          <Pager page={data.page} pageSize={data.pageSize} total={data.total}
                 onPage={setPage} onPageSize={(s) => { setPageSize(s); setPage(1); }}
                 sizes={[50, 100]} noun="event" />
        </>
      )}
    </div>
  );
}
