import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { InfinityLoader } from '../components/InfinityLoader';

interface StatusCount { status: string; count: number }
interface TrendPoint { date: string; revenue: number }

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
          <div className="grid2" style={{ marginBottom: '1rem' }}>
            <Kpi label="Revenue billed" value={inr(stats.revenue)} sub={`${stats.bills.toLocaleString('en-IN')} bills`} accent />
            <Kpi label="Collected" value={inr(stats.collected)} sub={`${inr(stats.cashCollected)} cash · ${inr(stats.otherCollected)} other`} />
            <Kpi label="Outstanding" value={inr(stats.outstanding)} sub={stats.discount > 0 ? `${inr(stats.discount)} discounted` : 'No discounts'} />
            <Kpi label="Registrations" value={stats.registrations.toLocaleString('en-IN')} sub={`${stats.patients.toLocaleString('en-IN')} distinct patients`} />
          </div>

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

          {stats.refunded > 0 && (
            <div className="alert alert--info" style={{ marginTop: '1rem' }}>
              <b>{inr(stats.refunded)}</b> refunded on this day.
            </div>
          )}

          <p className="muted" style={{ fontSize: '.72rem', marginTop: '1rem', lineHeight: 1.6 }}>
            Billing figures are keyed to the bill date. Collections and refunds are keyed to the <b>receipt</b> date, so
            a payment taken today against an older bill counts towards today.
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

function Kpi({ label, value, sub, accent = false }: { label: string; value: string; sub?: string; accent?: boolean }) {
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
