import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { InfinityLoader } from '../components/InfinityLoader';

interface StatusCount { status: string; count: number }
interface TrendPoint { date: string; revenue: number }

interface LeaderRow { code: string; name: string | null; amount: number; count: number }

interface MonthStats {
  month: string;
  through: string;
  bills: number;
  patients: number;
  registrations: number;
  revenue: number;
  labSalesDay: number;
  labSalesMonth: number;
  collected: number;
  refunded: number;
  outstanding: number;
  discount: number;
  activeClients: number;
  referringDoctors: number;
  topClients: LeaderRow[];
  topTests: LeaderRow[];
  topPayers: LeaderRow[];
}

interface DayStats {
  date: string;
  bills: number;
  patients: number;
  registrations: number;
  revenue: number;
  collected: number;
  cashCollected: number;
  otherCollected: number;
  refunded: number;
  outstanding: number;
  discount: number;
  byStatus: StatusCount[];
  trend: TrendPoint[];
}

const inr = (n: number) =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(n);

/** Today on the IST calendar — the lab's day, not the browser's. */
/**
 * "2026-08-06" -> "6 Aug". Parsed as parts, not handed to `new Date(iso)`:
 * that reads a bare date as UTC and shifts it a day back for anyone west of
 * Greenwich, which would print the wrong month boundary.
 */
function fmtDay(iso: string) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

function todayIst() {
  const now = new Date();
  const ist = new Date(now.getTime() + (330 + now.getTimezoneOffset()) * 60_000);
  return ist.toISOString().slice(0, 10);
}

export function Dashboard() {
  const { user, can } = useAuth();
  const [date, setDate] = useState(todayIst());
  const [stats, setStats] = useState<DayStats | null>(null);
  const [centres, setCentres] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // The month block loads on its own. It aggregates a month of bills and their
  // test lines against the live LIS database, and the day KPIs are the part
  // somebody is actually waiting for — so a slow month must not hold them up.
  const [month, setMonth] = useState<MonthStats | null>(null);
  const [monthError, setMonthError] = useState<string | null>(null);
  const [monthLoading, setMonthLoading] = useState(true);

  const mayView = can('analytics:view');

  useEffect(() => {
    if (!mayView) { setLoading(false); return; }
    let live = true;
    setLoading(true);
    setError(null);
    api
      .get<{ stats: DayStats; centres: number }>(`/api/dashboard/stats?date=${date}`)
      .then((r) => { if (live) { setStats(r.stats); setCentres(r.centres); } })
      .catch((e) => { if (live) setError(e instanceof Error ? e.message : 'Could not load statistics.'); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [date, mayView]);

  // Takes the selected DAY and derives its month server-side, so the two
  // halves of the screen can never end up describing different periods.
  useEffect(() => {
    if (!mayView) { setMonthLoading(false); return; }
    let live = true;
    setMonthLoading(true);
    setMonthError(null);
    api
      .get<{ month: MonthStats }>(`/api/dashboard/month?date=${date}`)
      .then((r) => { if (live) setMonth(r.month); })
      .catch((e) => { if (live) setMonthError(e instanceof Error ? e.message : 'Could not load the month.'); })
      .finally(() => { if (live) setMonthLoading(false); });
    return () => { live = false; };
  }, [date, mayView]);

  if (!user) return null;

  return (
    <div className="page">
      <div className="page__head">
        <div>
          <h1 className="page__title">Welcome, {user.displayName ?? user.username}</h1>
          <p className="page__sub">
            {centres === null
              ? 'Signed in with your LIS credentials'
              : `${centres.toLocaleString('en-IN')} collection centre${centres === 1 ? '' : 's'} in your scope`}
          </p>
        </div>

        {mayView && (
          <div className="row" style={{ marginLeft: 'auto' }}>
            <label htmlFor="d" className="muted" style={{ fontSize: '.72rem', letterSpacing: '.12em', textTransform: 'uppercase' }}>
              Day
            </label>
            <input id="d" className="input" type="date" value={date} max={todayIst()} onChange={(e) => setDate(e.target.value)} />
          </div>
        )}
      </div>

      {!mayView ? (
        <div className="card">
          <h2 style={{ fontSize: '.95rem', fontWeight: 500, marginBottom: '.5rem' }}>No analytics access</h2>
          <p className="muted" style={{ fontSize: '.84rem', lineHeight: 1.6 }}>
            Your role (<b>{user.role}</b>) does not include <code>analytics:view</code>. Ask an administrator if you
            need the operational dashboard.
          </p>
        </div>
      ) : error ? (
        <div className="alert alert--error">{error}</div>
      ) : loading ? (
        <div className="center"><InfinityLoader /><span className="muted">Loading lab statistics…</span></div>
      ) : stats ? (
        <>
          {/* Day on top, month to date beneath it — the pairing the LIS home
              screen uses, and the reason an admin can read that screen in one
              glance: "how is today going" and "how is the month going" are
              the two questions, and they belong on the same tile. */}
          {/* Lab sales leads, because it is the only tile here that describes
              the whole business. The three that follow cover order billing —
              Telo and Infinity only, a few percent of the first — and saying
              so on each one is the difference between a dashboard and a
              misleading one. */}
          <div className="grid2" style={{ marginBottom: '1rem' }}>
            <Kpi label="Lab sales" value={month ? inr(month.labSalesDay) : '—'} sub="Whole lab, LIS included" accent
                 mtd={month && inr(month.labSalesMonth)} />
            <Kpi label="Order billing" value={inr(stats.revenue)} sub={`${stats.bills.toLocaleString('en-IN')} bills · Telo and Infinity only`}
                 mtd={month && `${inr(month.revenue)} · ${month.bills.toLocaleString('en-IN')} bills`} />
            <Kpi label="Collected" value={inr(stats.collected)} sub={`${inr(stats.cashCollected)} cash · ${inr(stats.otherCollected)} other`}
                 mtd={month && inr(month.collected)} />
            <Kpi label="Outstanding" value={inr(stats.outstanding)} sub={stats.discount > 0 ? `${inr(stats.discount)} discounted` : 'No discounts'}
                 mtd={month && inr(month.outstanding)} />
            <Kpi label="Registrations" value={stats.registrations.toLocaleString('en-IN')} sub={`${stats.patients.toLocaleString('en-IN')} distinct patients`}
                 mtd={month && month.registrations.toLocaleString('en-IN')} />
          </div>

          {month && (
            <p className="muted" style={{ fontSize: '.74rem', margin: '-.4rem 0 1rem' }}>
              Month to date covers {fmtDay(month.month)} – {fmtDay(month.through)} ·{' '}
              <b>{month.activeClients.toLocaleString('en-IN')}</b> centre{month.activeClients === 1 ? '' : 's'} billed
              {month.referringDoctors > 0 && <> · <b>{month.referringDoctors.toLocaleString('en-IN')}</b> referring doctors</>}
              {month.refunded > 0 && <> · <b>{inr(month.refunded)}</b> refunded</>}
            </p>
          )}

          <div className="grid2">
            <div className="card">
              <SectionTitle>7-day revenue</SectionTitle>
              <Sparkline points={stats.trend} />
            </div>

            <div className="card">
              <SectionTitle>Sample pipeline</SectionTitle>
              {stats.byStatus.length === 0 ? (
                <p className="muted" style={{ fontSize: '.82rem' }}>No samples registered on this day.</p>
              ) : (
                <div className="stack" style={{ gap: '.5rem' }}>
                  {stats.byStatus.map((s) => {
                    const max = Math.max(...stats.byStatus.map((x) => x.count));
                    return (
                      <div key={s.status}>
                        <div className="row" style={{ justifyContent: 'space-between', fontSize: '.8rem' }}>
                          <span>{s.status}</span>
                          <span className="mono muted">{s.count.toLocaleString('en-IN')}</span>
                        </div>
                        <div style={{ height: 5, borderRadius: 4, background: 'var(--track)', marginTop: 3, overflow: 'hidden' }}>
                          <div style={{
                            height: '100%',
                            width: `${max ? (s.count / max) * 100 : 0}%`,
                            borderRadius: 4,
                            background: 'linear-gradient(92deg, var(--cyan), var(--teal))',
                          }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* The three boards from the LIS home screen. Billed and paid are
              deliberately side by side: high in the first and absent from the
              second is the thing an admin is scanning for. */}
          <div className="grid3" style={{ marginTop: '1rem' }}>
            <Board
              title="Top clients · billed"
              rows={month?.topClients}
              loading={monthLoading}
              error={monthError}
              render={(r) => inr(r.amount)}
              meta={(r) => `${r.count.toLocaleString('en-IN')} bill${r.count === 1 ? '' : 's'}`}
            />
            <Board
              title="Top clients · paid"
              rows={month?.topPayers}
              loading={monthLoading}
              error={monthError}
              render={(r) => inr(r.amount)}
              meta={(r) => `${r.count.toLocaleString('en-IN')} receipt${r.count === 1 ? '' : 's'}`}
              empty="Nothing received this month."
            />
            <Board
              title="Top tests · volume"
              rows={month?.topTests}
              loading={monthLoading}
              error={monthError}
              render={(r) => r.count.toLocaleString('en-IN')}
              meta={(r) => inr(r.amount)}
              // The test board is keyed by name; the code is the secondary fact.
              label={(r) => r.name || r.code}
            />
          </div>

          {stats.refunded > 0 && (
            <div className="alert alert--info" style={{ marginTop: '1rem' }}>
              <b>{inr(stats.refunded)}</b> refunded on this day.
            </div>
          )}

          <p className="muted" style={{ fontSize: '.72rem', marginTop: '1rem', lineHeight: 1.6 }}>
            <b>Lab sales</b> covers everything the lab sold, LIS included, keyed to the patient's registration date.
            It reads a few percent below the LIS home screen's Sales tile, which counts a test on the day its row was
            last edited — so work corrected this month is booked to this month there, and to its own month here.
            <br />
            <b>Order billing, collected and outstanding</b> cover only orders raised in Telo or Infinity, which is a
            small fraction of lab sales. Billing is keyed to the bill date; collections and refunds to the{' '}
            <b>receipt</b> date, so a payment taken today against an older bill counts towards today. Leaderboards
            cover the month to date.
          </p>
        </>
      ) : null}
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 style={{ fontSize: '.68rem', fontWeight: 600, letterSpacing: '.14em', textTransform: 'uppercase', color: 'var(--ink-dim)', marginBottom: '.8rem' }}>
      {children}
    </h2>
  );
}

/**
 * A day figure with its month-to-date companion.
 *
 * `mtd` is null while the month is still loading, and the row is omitted
 * rather than showing a zero — a zero here is a real number ("nothing billed
 * this month") and must not be confused with "not known yet".
 */
function Kpi({ label, value, sub, accent = false, mtd }: {
  label: string;
  value: string;
  sub?: string;
  accent?: boolean;
  mtd?: string | null | false;
}) {
  return (
    <div className="card">
      <div className="muted" style={{ fontSize: '.66rem', letterSpacing: '.14em', textTransform: 'uppercase' }}>{label}</div>
      <div
        style={{
          fontSize: '1.5rem', fontWeight: 300, marginTop: '.35rem', letterSpacing: '.01em',
          ...(accent
            ? {
                background: 'linear-gradient(92deg, var(--cyan), var(--teal) 50%, var(--blue))',
                WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent',
              }
            : {}),
        }}
      >
        {value}
      </div>
      {sub && <div className="muted" style={{ fontSize: '.74rem', marginTop: '.25rem' }}>{sub}</div>}
      {mtd && (
        <div className="kpi__mtd">
          <span className="kpi__mtd-tag">MTD</span>
          <span>{mtd}</span>
        </div>
      )}
    </div>
  );
}

/**
 * One leaderboard.
 *
 * Ten rows, and it says so when there are exactly ten — a list that stops at a
 * round number is indistinguishable from one that ran out, and the difference
 * matters when somebody is deciding whether the client they are looking for is
 * absent or merely eleventh.
 */
function Board({ title, rows, loading, error, render, meta, label, empty }: {
  title: string;
  rows: LeaderRow[] | undefined;
  loading: boolean;
  error: string | null;
  render: (r: LeaderRow) => string;
  meta?: (r: LeaderRow) => string;
  label?: (r: LeaderRow) => string;
  empty?: string;
}) {
  return (
    <div className="card">
      <SectionTitle>{title}</SectionTitle>
      {error ? (
        <p className="muted" style={{ fontSize: '.8rem' }}>{error}</p>
      ) : loading ? (
        <p className="muted" style={{ fontSize: '.8rem' }}>Loading…</p>
      ) : !rows || rows.length === 0 ? (
        <p className="muted" style={{ fontSize: '.82rem' }}>{empty ?? 'Nothing billed this month.'}</p>
      ) : (
        <>
          <ol className="board">
            {rows.map((r, i) => (
              <li key={`${r.code}-${i}`}>
                <span className="board__rank">{i + 1}</span>
                <span className="board__name" title={r.name ?? r.code}>
                  {label ? label(r) : r.code}
                  {!label && r.name && r.name !== r.code && (
                    <span className="board__sub">{r.name}</span>
                  )}
                </span>
                <span className="board__value mono">
                  {render(r)}
                  {meta && <span className="board__sub">{meta(r)}</span>}
                </span>
              </li>
            ))}
          </ol>
          {rows.length === 10 && (
            <p className="muted" style={{ fontSize: '.7rem', marginTop: '.5rem' }}>
              Top 10 only — there may be more.
            </p>
          )}
        </>
      )}
    </div>
  );
}

/** Inline SVG sparkline — no chart library, no bundle cost. */
function Sparkline({ points }: { points: TrendPoint[] }) {
  if (points.length === 0) return <p className="muted" style={{ fontSize: '.82rem' }}>No data.</p>;

  const w = 320, h = 72, pad = 4;
  const max = Math.max(...points.map((p) => p.revenue), 1);
  const step = points.length > 1 ? (w - pad * 2) / (points.length - 1) : 0;
  const xy = points.map((p, i) => [pad + i * step, h - pad - (p.revenue / max) * (h - pad * 2)] as const);
  const line = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${line} L${xy[xy.length - 1][0].toFixed(1)},${h - pad} L${xy[0][0].toFixed(1)},${h - pad} Z`;

  return (
    <>
      <svg viewBox={`0 0 ${w} ${h}`} style={{ width: '100%', height: 'auto', overflow: 'visible' }} role="img" aria-label="Revenue over the last 7 days">
        <defs>
          <linearGradient id="sparkFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--teal)" stopOpacity="0.28" />
            <stop offset="100%" stopColor="var(--teal)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={area} fill="url(#sparkFill)" />
        <path d={line} fill="none" stroke="var(--teal)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        {xy.map(([x, y], i) => (
          <circle key={i} cx={x} cy={y} r="2.5" fill="var(--surface)" stroke="var(--teal)" strokeWidth="1.5">
            <title>{`${points[i].date}: ${inr(points[i].revenue)}`}</title>
          </circle>
        ))}
      </svg>
      <div className="row" style={{ justifyContent: 'space-between', marginTop: '.4rem' }}>
        <span className="muted" style={{ fontSize: '.7rem' }}>{points[0].date.slice(5)}</span>
        <span className="muted" style={{ fontSize: '.7rem' }}>{points[points.length - 1].date.slice(5)}</span>
      </div>
    </>
  );
}
