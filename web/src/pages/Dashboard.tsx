import { useEffect, useLayoutEffect, useRef, useState } from 'react';
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

/**
 * "2026-08-06" -> "6 Aug". Parsed as parts, not handed to `new Date(iso)`:
 * that reads a bare date as UTC and shifts it a day back for anyone west of
 * Greenwich, which would print the wrong month boundary.
 */
function fmtDay(iso: string) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

/** "2026-08-06" -> "Thu 6". The x-axis needs the weekday to be readable. */
function fmtAxis(iso: string) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return `${dt.toLocaleDateString('en-IN', { weekday: 'short' })} ${d}`;
}

/**
 * Today on the IST calendar — the lab's day, not the browser's.
 *
 * getTime() is an absolute epoch, so the only shift needed is UTC -> IST.
 * The previous version also added getTimezoneOffset(), which double-counts:
 * on a machine already in IST the two cancelled to zero and toISOString then
 * rendered UTC — five and a half hours behind. Between midnight and 05:30 the
 * dashboard opened on YESTERDAY, while the month panel (computed server-side,
 * correctly) covered today. That is the mismatch of a screen disagreeing with
 * itself for the first six hours of every shift.
 */
function todayIst() {
  return new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
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
            {/* "Order billing", not "revenue": this is the same
                tbl_billing_patient_detail figure as the tile above, and the
                two must not disagree about what they are called. */}
            <div className="card card--chart">
              <SectionTitle>Order billing · 7 days</SectionTitle>
              <RevenueChart points={stats.trend} selected={date} />
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

/**
 * A round number at or above the peak, for the top gridline.
 *
 * Scaling the axis to the exact maximum puts the highest point hard against
 * the top edge and gives the reader a number nobody can hold in their head
 * (₹91,347). Rounding up to 1, 2 or 5 × a power of ten leaves headroom and
 * gives an axis label worth printing.
 */
function niceCeil(v: number) {
  if (v <= 0) return 1;
  const mag = 10 ** Math.floor(Math.log10(v));
  const n = v / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;
}

/** Compact for an axis: ₹91k, ₹1.2L. Full precision belongs in the readout. */
function shortInr(n: number) {
  if (n >= 1e7) return `₹${(n / 1e7).toFixed(n % 1e7 === 0 ? 0 : 1)}Cr`;
  if (n >= 1e5) return `₹${(n / 1e5).toFixed(n % 1e5 === 0 ? 0 : 1)}L`;
  if (n >= 1e3) return `₹${Math.round(n / 1e3)}k`;
  return `₹${n}`;
}

/**
 * Seven days of order billing.
 *
 * Sized by measurement rather than by a fixed viewBox. The old chart was a
 * 320×72 box scaled to the card's WIDTH with height:auto, so in a card stretched
 * tall by its neighbour it drew a short line across the top and left the rest
 * of the card empty — which is exactly what it looked like. Measuring means it
 * fills whatever space the grid gives it, and the stroke stays 2px instead of
 * being scaled along with everything else.
 *
 * Readable without hovering: a zero baseline, a labelled gridline at the top of
 * the scale, and every day named on the x-axis. The previous version showed two
 * dates in MM-DD — ambiguous anywhere that writes dates day-first — and put the
 * values in native <title> tooltips, which means a value is only available to
 * somebody who knows to hover and then waits a second for it.
 */
function RevenueChart({ points, selected }: { points: TrendPoint[]; selected: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [active, setActive] = useState<number | null>(null);

  /*
   * Measured synchronously first, THEN observed.
   *
   * ResizeObserver alone was not enough: the chart draws nothing at all until
   * the first callback arrives, so anything that delays or drops it leaves a
   * blank card rather than a small one. That is not hypothetical — a
   * background or non-compositing tab can withhold the callback indefinitely,
   * and it happened on the first run of this component.
   *
   * useLayoutEffect so the measurement lands before paint and there is no
   * frame where the card is visibly empty.
   */
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;

    const measure = () => {
      const { width, height } = el.getBoundingClientRect();
      setSize((prev) => {
        const w = Math.round(width), h = Math.round(height);
        // Same size means no state change: RO fires on every layout pass and
        // an unconditional setState here is a re-render loop.
        return prev.w === w && prev.h === h ? prev : { w, h };
      });
    };

    measure();

    // Both, deliberately. The observer catches the container changing without
    // the window doing so — a sibling card growing, the nav collapsing — and
    // the window listener is the fallback for when observer callbacks are not
    // being delivered, which is a state a background tab can sit in for as
    // long as it likes.
    window.addEventListener('resize', measure);
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    ro?.observe(el);

    return () => {
      window.removeEventListener('resize', measure);
      ro?.disconnect();
    };
  }, []);

  const peak = points.length ? Math.max(...points.map((p) => p.revenue)) : 0;
  const total = points.reduce((s, p) => s + p.revenue, 0);

  // A week with nothing in it says so. Drawing a flat line along the floor
  // under a gridline labelled "₹1" is technically consistent and tells the
  // reader nothing — worse, it looks like a chart that failed to load.
  if (points.length === 0 || peak <= 0) {
    return (
      <div className="chart__empty">
        <p className="muted" style={{ fontSize: '.82rem' }}>
          {points.length === 0
            ? 'No data for these seven days.'
            : 'Nothing billed through Telo or Infinity in these seven days.'}
        </p>
      </div>
    );
  }

  const top = niceCeil(peak);

  // The readout defaults to the selected day, so the chart says something
  // useful before anybody touches it.
  const selectedIdx = points.findIndex((p) => p.date === selected);
  const shown = active ?? (selectedIdx >= 0 ? selectedIdx : points.length - 1);

  const { w, h } = size;
  const padL = 44, padR = 10, padT = 10, padB = 4;
  const plotW = Math.max(0, w - padL - padR);
  const plotH = Math.max(0, h - padT - padB);
  const step = points.length > 1 ? plotW / (points.length - 1) : 0;

  const x = (i: number) => padL + (points.length > 1 ? i * step : plotW / 2);
  const y = (v: number) => padT + plotH - (top > 0 ? v / top : 0) * plotH;

  const xy = points.map((p, i) => [x(i), y(p.revenue)] as const);
  const line = xy.map(([px, py], i) => `${i ? 'L' : 'M'}${px.toFixed(1)},${py.toFixed(1)}`).join(' ');
  const base = padT + plotH;
  const area = xy.length
    ? `${line} L${xy[xy.length - 1][0].toFixed(1)},${base} L${xy[0][0].toFixed(1)},${base} Z`
    : '';

  return (
    <>
      <div className="chart__head">
        <div>
          <span className="chart__value">{inr(points[shown].revenue)}</span>
          <span className="chart__when">{fmtAxis(points[shown].date)}</span>
        </div>
        <span className="muted" style={{ fontSize: '.72rem' }}>{inr(total)} over 7 days</span>
      </div>

      <div className="chart__plot" ref={box}>
        {w > 0 && h > 0 && (
          <svg width={w} height={h} role="img"
               aria-label={`Order billing per day, ${fmtAxis(points[0].date)} to ${fmtAxis(points[points.length - 1].date)}`}>
            <defs>
              <linearGradient id="sparkFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--teal)" stopOpacity="0.28" />
                <stop offset="100%" stopColor="var(--teal)" stopOpacity="0" />
              </linearGradient>
            </defs>

            {/* Scale: a labelled top and a zero baseline, so the height of the
                line means something without hovering anything. */}
            <line x1={padL} x2={w - padR} y1={padT} y2={padT} className="chart__grid" />
            <line x1={padL} x2={w - padR} y1={base} y2={base} className="chart__axis" />
            <text x={padL - 8} y={padT + 4} className="chart__tick" textAnchor="end">{shortInr(top)}</text>
            <text x={padL - 8} y={base + 4} className="chart__tick" textAnchor="end">₹0</text>

            <path d={area} fill="url(#sparkFill)" />
            <path d={line} fill="none" stroke="var(--teal)" strokeWidth="2"
                  strokeLinecap="round" strokeLinejoin="round" />

            {/* One full-height hit target per day. Hovering a 2.5px circle is a
                game; hovering a column is not. */}
            {points.map((p, i) => {
              const half = points.length > 1 ? step / 2 : plotW / 2;
              return (
                <g key={p.date}>
                  {i === shown && (
                    <line x1={xy[i][0]} x2={xy[i][0]} y1={padT} y2={base} className="chart__cursor" />
                  )}
                  <circle cx={xy[i][0]} cy={xy[i][1]} r={i === shown ? 4 : 2.5}
                          fill="var(--surface)" stroke="var(--teal)" strokeWidth={i === shown ? 2 : 1.5} />
                  <rect
                    x={Math.max(padL, xy[i][0] - half)} y={padT}
                    width={Math.min(step || plotW, plotW)} height={plotH}
                    fill="transparent"
                    tabIndex={0}
                    role="button"
                    aria-label={`${fmtAxis(p.date)}: ${inr(p.revenue)}`}
                    onMouseEnter={() => setActive(i)}
                    onFocus={() => setActive(i)}
                    onMouseLeave={() => setActive(null)}
                    onBlur={() => setActive(null)}
                  />
                </g>
              );
            })}
          </svg>
        )}
      </div>

      <div className="chart__axis-x" style={{ paddingLeft: padL, paddingRight: padR }}>
        {points.map((p, i) => (
          <span key={p.date} className={i === shown ? 'is-on' : undefined}>{fmtAxis(p.date)}</span>
        ))}
      </div>
    </>
  );
}
