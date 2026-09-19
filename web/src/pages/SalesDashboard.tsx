import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { salesApi, type SalesCentre, type SalesDashboard as SalesData } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { InfinityLoader } from '../components/InfinityLoader';
import { Board, Kpi, RevenueChart, SectionTitle, inr, shortInr, todayIst } from './Dashboard';

/**
 * The sales dashboard: one salesperson's territory against its target, this
 * month and this financial year.
 *
 * What a salesperson opens on, in place of the lab's revenue dashboard: the
 * lab's picture is bills and collections across every centre; this one is
 * the centres mapped to THIS person, what they booked, what was set for them,
 * and where the month is heading. The figures reconcile with the LIS's own
 * sales report — same lines, same dates — see SalesRepository.
 *
 * Two doors in. At "/" for a salesperson it is their own (no id). At
 * /sales-team/:userId for the Sales Admin and above it is a team member's,
 * with the month's target editable in place.
 */
export function SalesDashboard() {
  const { user } = useAuth();
  const { userId: param } = useParams();
  const userId = param ? Number(param) : null;
  const [month, setMonth] = useState(todayIst().slice(0, 7));
  const [data, setData] = useState<SalesData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    (userId != null ? salesApi.of(userId, month) : salesApi.mine(month))
      .then((d) => { if (live) setData(d); })
      .catch((e) => { if (live) setError(e instanceof Error ? e.message : 'Could not load the sales dashboard.'); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [userId, month, reload]);

  if (!user) return null;
  const own = userId == null;
  const who = data?.name || data?.username || (own ? (user.displayName ?? user.username) : `User ${userId}`);
  const pct = data && data.target > 0 ? Math.min(999, Math.round((data.achieved / data.target) * 100)) : null;
  const delta = data && data.prevMonthToDate > 0
    ? Math.round(((data.achieved - data.prevMonthToDate) / data.prevMonthToDate) * 100)
    : null;
  const monthName = monthLabel(month);
  const isCurrent = month === todayIst().slice(0, 7);

  return (
    <div className="page">
      <div className="page__head">
        <div>
          {!own && (
            <div className="muted" style={{ fontSize: '.74rem', marginBottom: '.3rem' }}>
              <Link to="/sales-team">← Sales team</Link>
            </div>
          )}
          <h1 className="page__title">{own ? `Welcome, ${who}` : who}</h1>
          <p className="page__sub">
            {data
              ? `${data.centres.toLocaleString('en-IN')} centre${data.centres === 1 ? '' : 's'} in the territory · ${data.activeCentres.toLocaleString('en-IN')} sent work in ${monthName}`
              : 'Your territory, this month and this financial year'}
          </p>
        </div>
        <label className="row" style={{ gap: '.5rem', alignItems: 'center' }}>
          <span className="muted" style={{ fontSize: '.66rem', letterSpacing: '.14em', textTransform: 'uppercase' }}>Month</span>
          <input className="input" type="month" value={month} max={todayIst().slice(0, 7)} onChange={(e) => e.target.value && setMonth(e.target.value)} />
        </label>
      </div>

      {error && <div className="alert alert--error">{error}</div>}
      {loading && !data && <div className="center" style={{ minHeight: 160 }}><InfinityLoader /></div>}

      {data && (
        <div className="stack">
          {/* ---- the month ------------------------------------------------ */}
          <div className="grid3">
            <Kpi
              label={`Sales · ${monthName}`}
              value={inr(data.achieved)}
              accent
              sub={data.prevMonthToDate > 0
                ? `${inr(data.prevMonthToDate)} same days last month${delta != null ? ` · ${delta >= 0 ? '+' : ''}${delta}%` : ''}`
                : `${data.patients.toLocaleString('en-IN')} patients · ${data.daysCounted} of ${data.daysInMonth} days`}
            />
            <div className="card">
              <div className="muted" style={{ fontSize: '.66rem', letterSpacing: '.14em', textTransform: 'uppercase' }}>Target · {monthName}</div>
              <div style={{ fontSize: '1.5rem', fontWeight: 300, marginTop: '.35rem' }}>
                {data.target > 0 ? inr(data.target) : <span className="muted">Not set</span>}
              </div>
              {data.target > 0 ? (
                <>
                  <div className="progress" title={`${pct}% of target`}>
                    <div className={`progress__bar${pct != null && pct >= 100 ? ' progress__bar--met' : ''}`} style={{ width: `${Math.min(100, pct ?? 0)}%` }} />
                  </div>
                  <div className="muted" style={{ fontSize: '.74rem', marginTop: '.3rem' }}>
                    {pct}% achieved · {data.achieved >= data.target ? `${inr(data.achieved - data.target)} over` : `${inr(data.target - data.achieved)} to go`}
                  </div>
                </>
              ) : (
                <div className="muted" style={{ fontSize: '.74rem', marginTop: '.25rem' }}>
                  {own ? 'No target has been set for this month.' : 'Set one below.'}
                </div>
              )}
              {!own && <TargetEditor data={data} onSaved={() => setReload((n) => n + 1)} />}
            </div>
            <Kpi
              label={isCurrent ? 'Projected month end' : 'Last month in full'}
              value={inr(isCurrent ? data.projected : data.prevMonthTotal)}
              sub={isCurrent
                ? `At the current daily run rate · last month closed at ${inr(data.prevMonthTotal)}`
                : `${data.patients.toLocaleString('en-IN')} patients this month`}
            />
          </div>

          <div className="card card--chart">
            <SectionTitle>Day by day · {monthName}</SectionTitle>
            <RevenueChart points={data.daily.map((d) => ({ date: d.date, revenue: d.amount }))} selected={data.through} />
          </div>

          {/* ---- the financial year --------------------------------------- */}
          <div className="grid2">
            <Kpi
              label={`${data.fyLabel} · sales to date`}
              value={inr(data.fyAchieved)}
              accent
              sub={`April to ${monthName}`}
            />
            <Kpi
              label={`${data.fyLabel} · target to date`}
              value={data.fyTarget > 0 ? inr(data.fyTarget) : 'Not set'}
              sub={data.fyTarget > 0
                ? `${Math.round((data.fyAchieved / data.fyTarget) * 100)}% achieved · ${data.fyAchieved >= data.fyTarget ? `${inr(data.fyAchieved - data.fyTarget)} over` : `${inr(data.fyTarget - data.fyAchieved)} behind`}`
                : 'Targets set month by month add up here'}
            />
          </div>

          <div className="card card--chart">
            <SectionTitle>Month by month · {data.fyLabel}</SectionTitle>
            <FyChart months={data.fyMonths} />
          </div>

          {/* ---- the centres ---------------------------------------------- */}
          <div className="grid3">
            <Board
              title={`Top centres · ${monthName}`}
              rows={data.topCentres.map(asRow)}
              loading={false}
              error={null}
              render={(r) => inr(r.amount)}
              meta={(r) => `${r.count.toLocaleString('en-IN')} patient${r.count === 1 ? '' : 's'}`}
              empty="Nothing booked yet this month."
            />
            <Board
              title="Went quiet"
              rows={data.silentCentres.map((c) => ({ code: c.code, name: c.name, amount: c.prevMonth, count: c.patients }))}
              loading={false}
              error={null}
              render={(r) => inr(r.amount)}
              meta={() => 'last month · nothing yet this month'}
              empty="Every centre that bought last month has bought this month too."
            />
            <Board
              title="New this month"
              rows={data.newCentres.map(asRow)}
              loading={false}
              error={null}
              render={(r) => (r.amount > 0 ? inr(r.amount) : '—')}
              meta={(r) => (r.count > 0 ? `${r.count.toLocaleString('en-IN')} patient${r.count === 1 ? '' : 's'}` : 'no work yet')}
              empty="No centre was opened in the territory this month."
            />
          </div>
        </div>
      )}
    </div>
  );
}

const asRow = (c: SalesCentre) => ({ code: c.code, name: c.name, amount: c.month, count: c.patients });

/** "2026-09" → "September 2026". */
function monthLabel(ym: string) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * The financial year month by month: a bar of what came in beside a bar of
 * what was set, per month, on one scale. A month with no target shows its
 * sales alone; the gap between the two bars is the story.
 */
function FyChart({ months }: { months: { year: number; month: number; target: number; achieved: number }[] }) {
  const max = Math.max(1, ...months.map((m) => Math.max(m.target, m.achieved)));
  const anyTarget = months.some((m) => m.target > 0);
  return (
    <div>
      <div className="fy">
        {months.map((m) => {
          const a = (m.achieved / max) * 100;
          const t = (m.target / max) * 100;
          const met = m.target > 0 && m.achieved >= m.target;
          return (
            <div className="fy__col" key={`${m.year}-${m.month}`} title={`${MONTHS[m.month - 1]} ${m.year}: ${inr(m.achieved)}${m.target > 0 ? ` of ${inr(m.target)}` : ''}`}>
              <div className="fy__bars">
                <div className={`fy__bar fy__bar--sales${met ? ' fy__bar--met' : ''}`} style={{ height: `${a}%` }} />
                {m.target > 0 && <div className="fy__bar fy__bar--target" style={{ height: `${t}%` }} />}
              </div>
              <div className="fy__value mono">{m.achieved > 0 ? shortInr(m.achieved) : '·'}</div>
              <div className="fy__label">{MONTHS[m.month - 1]}</div>
            </div>
          );
        })}
      </div>
      <div className="muted" style={{ fontSize: '.7rem', marginTop: '.5rem' }}>
        <span className="fy__key fy__key--sales" /> Sales
        {anyTarget && <><span className="fy__key fy__key--target" style={{ marginLeft: '.9rem' }} /> Target</>}
      </div>
    </div>
  );
}

/** The Sales Admin's control: this month's target, set in place. */
function TargetEditor({ data, onSaved }: { data: SalesData; onSaved: () => void }) {
  const [value, setValue] = useState(data.target > 0 ? String(data.target) : '');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => { setValue(data.target > 0 ? String(data.target) : ''); }, [data.target, data.month]);
  const [y, m] = data.month.split('-').map(Number);
  const save = async () => {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) { setMsg('Enter a whole-rupee amount.'); return; }
    setBusy(true); setMsg(null);
    try {
      await salesApi.setTarget(data.userId, y, m, Math.round(n));
      setMsg('Saved.');
      onSaved();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Could not save the target.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="row" style={{ gap: '.4rem', alignItems: 'center', marginTop: '.6rem', flexWrap: 'wrap' }}>
      <input className="input input--sm mono" type="number" min={0} step={1000} placeholder="Target ₹" value={value}
             onChange={(e) => setValue(e.target.value)} style={{ width: 130 }} />
      <button className="btn btn--sm btn--primary" disabled={busy} onClick={() => void save()}>Set target</button>
      {msg && <span className="muted" style={{ fontSize: '.72rem' }}>{msg}</span>}
    </div>
  );
}
