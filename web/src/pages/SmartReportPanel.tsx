import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { inr } from '../lib/format';
import { Kpi, SectionTitle, type LeaderRow } from './Dashboard';

/** One qualifying profile or package, with month-to-date and all-time sales. */
interface SmartTierRow {
  code: string;
  name: string;
  tier: 'package' | 'mini' | 'other';
  monthCount: number;
  monthAmount: number;
  allCount: number;
  allAmount: number;
}

interface SmartDayPoint { date: string; count: number; amount: number }

/** The Smart Report's own numbers, as /api/dashboard/smart-reports returns them. */
interface SmartReportStats {
  month: string;
  through: string;
  firstSale: string | null;
  monthCount: number;
  monthAmount: number;
  allCount: number;
  allAmount: number;
  monthCharged: number;
  allCharged: number;
  uncharged: number;
  monthDownloaded: number;
  allDownloaded: number;
  byProfile: SmartTierRow[];
  byClient: LeaderRow[];
  byPrice: LeaderRow[];
  daily: SmartDayPoint[];
}

const n = (v: number) => v.toLocaleString('en-IN');

function fmtDay(iso: string) {
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

/**
 * The Smart Report section of the home dashboard — super admin only.
 *
 * Four tiles pair the selected month with all time: booklets sold, what they
 * were billed at, how much of that has reached a centre's account, and how
 * many were actually downloaded. Beneath: sales per day for the last thirty
 * days, and three boards — by the profile that qualified the sale, by centre
 * this month, and by price point, which is how the introductory offers read.
 */
export function SmartReportPanel({ date }: { date: string }) {
  const [data, setData] = useState<SmartReportStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    api
      .get<{ smart: SmartReportStats }>(`/api/dashboard/smart-reports?date=${date}`)
      .then((r) => { if (live) setData(r.smart); })
      .catch((e) => { if (live) setError(e instanceof Error ? e.message : 'Could not load the Smart Report figures.'); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [date]);

  return (
    <section style={{ marginTop: '1.4rem' }} aria-label="Smart Report">
      <div className="row" style={{ alignItems: 'baseline', gap: '.6rem', marginBottom: '.8rem' }}>
        <SectionTitle>Smart Report</SectionTitle>
        {data?.firstSale && (
          <span className="muted" style={{ fontSize: '.72rem', marginBottom: '.8rem' }}>
            selling since {fmtDay(data.firstSale)} · month to date {fmtDay(data.month)} – {fmtDay(data.through)}
          </span>
        )}
      </div>

      {error ? (
        <div className="alert alert--error">{error}</div>
      ) : loading || !data ? (
        <p className="muted" style={{ fontSize: '.8rem' }}>Loading…</p>
      ) : data.allCount === 0 ? (
        <div className="card">
          <p className="muted" style={{ fontSize: '.82rem' }}>No Smart Report has been sold yet.</p>
        </div>
      ) : (
        <>
          <div className="grid2" style={{ marginBottom: '1rem' }}>
            <Kpi label="Booklets sold" value={n(data.monthCount)} sub={`${n(data.allCount)} all time`} accent />
            <Kpi label="Billed" value={inr(data.monthAmount)}
                 sub={`${inr(data.allAmount)} all time · avg ${inr(data.allCount ? Math.round(data.allAmount / data.allCount) : 0)}`} />
            <Kpi label="Charged to centres" value={inr(data.monthCharged)}
                 sub={data.uncharged > 0
                   ? `${inr(data.allCharged)} all time · ${n(data.uncharged)} not yet on an account`
                   : `${inr(data.allCharged)} all time · every sale on an account`} />
            <Kpi label="Downloaded" value={`${n(data.monthDownloaded)} of ${n(data.monthCount)}`}
                 sub={`${n(data.allDownloaded)} of ${n(data.allCount)} all time`} />
          </div>

          <div className="grid2">
            <div className="card card--chart">
              <SectionTitle>Booklets per day · 30 days</SectionTitle>
              <DailyBars points={data.daily} selected={date} />
            </div>

            <div className="card">
              <SectionTitle>By profile · all time</SectionTitle>
              {data.byProfile.length === 0 ? (
                <p className="muted" style={{ fontSize: '.82rem' }}>Nothing yet.</p>
              ) : (
                <ol className="board">
                  {data.byProfile.map((r, i) => (
                    <li key={r.code}>
                      <span className="board__rank">{i + 1}</span>
                      <span className="board__name" title={`${r.code} · ${r.tier}`}>
                        {r.name || r.code}
                        <span className="board__sub">
                          {r.tier === 'package' ? 'health package' : r.tier === 'mini' ? 'mini profile' : 'sold before the offer was restricted'}
                          {r.monthCount > 0 && ` · ${n(r.monthCount)} this month`}
                        </span>
                      </span>
                      <span className="board__value mono">
                        {n(r.allCount)}
                        <span className="board__sub">{inr(r.allAmount)}</span>
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </div>

          <div className="grid2" style={{ marginTop: '1rem' }}>
            <div className="card">
              <SectionTitle>By centre · month to date</SectionTitle>
              {data.byClient.length === 0 ? (
                <p className="muted" style={{ fontSize: '.82rem' }}>No booklet sold this month.</p>
              ) : (
                <ol className="board">
                  {data.byClient.map((r, i) => (
                    <li key={r.code}>
                      <span className="board__rank">{i + 1}</span>
                      <span className="board__name" title={r.name ?? r.code}>
                        {r.code}
                        {r.name && r.name !== r.code && <span className="board__sub">{r.name}</span>}
                      </span>
                      <span className="board__value mono">
                        {n(r.count)}
                        <span className="board__sub">{inr(r.amount)}</span>
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </div>

            <div className="card">
              <SectionTitle>By price · all time</SectionTitle>
              <ol className="board">
                {data.byPrice.map((r) => (
                  <li key={r.code}>
                    <span className="board__rank">{inr(Number(r.code))}</span>
                    <span className="board__name">
                      {n(r.count)} booklet{r.count === 1 ? '' : 's'}
                      <span className="board__sub">
                        {Number(r.code) === 49 || Number(r.code) === 11 ? 'introductory offer' : 'list price'}
                      </span>
                    </span>
                    <span className="board__value mono">{inr(r.amount)}</span>
                  </li>
                ))}
              </ol>
            </div>
          </div>

          <p className="muted" style={{ fontSize: '.72rem', marginTop: '.8rem', lineHeight: 1.6 }}>
            A booklet counts on its bill date, at the price on the bill. <b>Charged to centres</b> is what has been
            posted to a centre's account — at accessioning for an order with tests, at booking for one without —
            so a booklet booked today and not yet received shows here as billed but not yet charged.
            <b> Downloaded</b> counts booklets fetched at least once, not fetches.
          </p>
        </>
      )}
    </section>
  );
}

/** Thirty days of booklets as bars: whole numbers, so bars read better than a line. */
function DailyBars({ points, selected }: { points: SmartDayPoint[]; selected: string }) {
  const max = Math.max(1, ...points.map((p) => p.count));
  const total = points.reduce((s, p) => s + p.count, 0);
  const amount = points.reduce((s, p) => s + p.amount, 0);
  return (
    <>
      <div className="chart__head">
        <div>
          <span className="chart__value">{n(total)}</span>
          <span className="chart__when">booklets · {inr(amount)}</span>
        </div>
        <span className="muted" style={{ fontSize: '.72rem' }}>
          {points.length ? `${fmtDay(points[0].date)} – ${fmtDay(points[points.length - 1].date)}` : ''}
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 120, padding: '.4rem 0 0' }}
           role="img" aria-label="Booklets sold per day over the last thirty days">
        {points.map((p) => (
          <div key={p.date} title={`${fmtDay(p.date)} · ${n(p.count)} booklet${p.count === 1 ? '' : 's'} · ${inr(p.amount)}`}
               style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', height: '100%' }}>
            <div style={{
              height: `${Math.max(p.count ? 6 : 2, (p.count / max) * 100)}%`,
              borderRadius: 3,
              background: p.date === selected
                ? 'linear-gradient(180deg, var(--cyan), var(--teal))'
                : p.count ? 'var(--teal)' : 'var(--track)',
              opacity: p.count || p.date === selected ? 1 : .6,
            }} />
          </div>
        ))}
      </div>
    </>
  );
}
