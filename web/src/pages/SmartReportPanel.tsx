import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../api/client';
import { inr } from '../lib/format';
import { Kpi, SectionTitle, type LeaderRow } from './Dashboard';

/** One qualifying profile or package, with month-to-date and all-time sales. */
interface SmartTierRow {
  code: string;
  name: string;
  tier: 'package' | 'multi' | 'mini' | 'other';
  monthCount: number;
  monthAmount: number;
  allCount: number;
  allAmount: number;
}

interface SmartDayPoint { date: string; count: number; amount: number }

/** The selected day on its own: the tier split, and who sold what. */
interface SmartDayStats {
  date: string;
  count: number;
  amount: number;
  charged: number;
  downloaded: number;
  package: number;
  multi: number;
  mini: number;
  other: number;
  byClient: LeaderRow[];
  byProfile: LeaderRow[];
}

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
  day: SmartDayStats;
}

const n = (v: number) => v.toLocaleString('en-IN');

/** A board shows this many; the rest wait behind "View all". */
const BOARD_LIMIT = 10;

function fmtDay(iso: string) {
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

const tierWord = (t: SmartTierRow['tier']) =>
  t === 'package' ? 'health package or profile'
    : t === 'multi' ? 'two or more single tests'
    : t === 'mini' ? 'single test'
    : 'sold before the offer was restricted';

/**
 * The Smart Report section of the home dashboard — super admin only.
 *
 * Laid out as a bento grid: four columns, every card sized to what it holds
 * rather than to its neighbour. The selected day comes first — today unless
 * the dashboard's date says otherwise: booklets sold that day split by tier,
 * billed, charged and downloaded, and which centres and profiles they came
 * from. Then the month against all time in four tiles, the thirty-day bars
 * beside the all-time profile board, and the month's centres beside the
 * price points. Every board shows its top ten; the full list opens in a
 * modal, so a long tail never stretches the row it sits in.
 */
export function SmartReportPanel({ date }: { date: string }) {
  const [data, setData] = useState<SmartReportStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<{ title: string; body: ReactNode } | null>(null);

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

  // IST, as the dashboard's own date picker reckons "today".
  const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);

  const profileItem = (r: SmartTierRow, i: number) => (
    <li key={`${r.code}-${r.tier}`}>
      <span className="board__rank">{i + 1}</span>
      <span className="board__name" title={`${r.code} · ${r.tier}`}>
        {r.name || r.code}
        <span className="board__sub">
          {tierWord(r.tier)}
          {r.monthCount > 0 && ` · ${n(r.monthCount)} this month`}
        </span>
      </span>
      <span className="board__value mono">
        {n(r.allCount)}
        <span className="board__sub">{inr(r.allAmount)}</span>
      </span>
    </li>
  );

  const leaderItem = (r: LeaderRow, i: number) => (
    <li key={r.code}>
      <span className="board__rank">{i + 1}</span>
      <span className="board__name" title={r.name ?? r.code}>
        {r.name && r.name !== r.code ? r.name : r.code}
        {r.name && r.name !== r.code && <span className="board__sub">{r.code}</span>}
      </span>
      <span className="board__value mono">
        {n(r.count)}
        <span className="board__sub">{inr(r.amount)}</span>
      </span>
    </li>
  );

  const priceItem = (r: LeaderRow) => (
    <li key={r.code}>
      <span className="board__rank">{inr(Number(r.code))}</span>
      <span className="board__name">
        {n(r.count)} booklet{r.count === 1 ? '' : 's'}
        <span className="board__sub">
          {[49, 25, 11].includes(Number(r.code)) ? 'introductory offer' : 'list price'}
        </span>
      </span>
      <span className="board__value mono">{inr(r.amount)}</span>
    </li>
  );

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
        <div className="bento">
          {/* ── the selected day ── */}
          <BentoHead
            title={data.day.date === today ? 'Today' : fmtDay(data.day.date)}
            sub={data.day.date === today ? 'so far · the day picked above' : 'the day picked above'}
          />
          <DayTiles day={data.day} />
          {data.day.count > 0 && (
            <>
              <Board
                span={2}
                title={`By centre · ${data.day.date === today ? 'today' : fmtDay(data.day.date)}`}
                rows={data.day.byClient}
                render={leaderItem}
                onMore={(body) => setModal({ title: 'By centre · the day', body })}
              />
              <Board
                span={2}
                title={`By profile · ${data.day.date === today ? 'today' : fmtDay(data.day.date)}`}
                rows={data.day.byProfile}
                render={leaderItem}
                onMore={(body) => setModal({ title: 'By profile · the day', body })}
              />
            </>
          )}

          {/* ── the month, with all time alongside ── */}
          <BentoHead title="Month to date" sub={`${fmtDay(data.month)} – ${fmtDay(data.through)}, with all time alongside`} />
          <Kpi label="Booklets sold" value={n(data.monthCount)} sub={`${n(data.allCount)} all time`} accent />
          <Kpi label="Billed" value={inr(data.monthAmount)}
               sub={`${inr(data.allAmount)} all time · avg ${inr(data.allCount ? Math.round(data.allAmount / data.allCount) : 0)}`} />
          <Kpi label="Charged to centres" value={inr(data.monthCharged)}
               sub={data.uncharged > 0
                 ? `${inr(data.allCharged)} all time · ${n(data.uncharged)} not yet on an account`
                 : `${inr(data.allCharged)} all time · every sale on an account`} />
          <Kpi label="Downloaded" value={`${n(data.monthDownloaded)} of ${n(data.monthCount)}`}
               sub={`${n(data.allDownloaded)} of ${n(data.allCount)} all time`} />

          <div className="card card--chart bento__2">
            <SectionTitle>Booklets per day · 30 days</SectionTitle>
            <DailyBars points={data.daily} selected={date} />
          </div>
          <Board
            span={2}
            title="By profile · all time"
            rows={data.byProfile}
            render={profileItem}
            empty="Nothing yet."
            onMore={(body) => setModal({ title: 'By profile · all time', body })}
          />

          <Board
            span={2}
            title="By centre · month to date"
            rows={data.byClient}
            render={leaderItem}
            empty="No booklet sold this month."
            onMore={(body) => setModal({ title: 'By centre · month to date', body })}
          />
          <Board
            span={2}
            title="By price · all time"
            rows={data.byPrice}
            render={priceItem}
            onMore={(body) => setModal({ title: 'By price · all time', body })}
          />

          <p className="muted bento__4" style={{ fontSize: '.72rem', lineHeight: 1.6, margin: 0 }}>
            A booklet counts on its bill date, at the price on the bill. <b>Charged to centres</b> is what has been
            posted to a centre's account — at accessioning for an order with tests, at booking for one without —
            so a booklet booked today and not yet received shows here as billed but not yet charged.
            <b> Downloaded</b> counts booklets fetched at least once, not fetches.
          </p>
        </div>
      )}

      {modal && <BoardModal title={modal.title} onClose={() => setModal(null)}>{modal.body}</BoardModal>}
    </section>
  );
}

/** A row heading across the grid: bold title, quiet subtitle. */
function BentoHead({ title, sub }: { title: string; sub: string }) {
  return (
    <div className="bento__4 row" style={{ alignItems: 'baseline', gap: '.6rem', margin: '.2rem 0 -.3rem' }}>
      <span style={{ fontSize: '.8rem', fontWeight: 700 }}>{title}</span>
      <span className="muted" style={{ fontSize: '.72rem' }}>{sub}</span>
    </div>
  );
}

/** The selected day's four tiles. */
function DayTiles({ day }: { day: SmartDayStats }) {
  const tiers: string[] = [];
  if (day.package) tiers.push(`${n(day.package)} package`);
  if (day.multi) tiers.push(`${n(day.multi)} multi`);
  if (day.mini) tiers.push(`${n(day.mini)} single`);
  if (day.other) tiers.push(`${n(day.other)} other`);
  return (
    <>
      <Kpi label="Booklets sold" value={n(day.count)} sub={tiers.length ? tiers.join(' · ') : 'none yet'} accent />
      <Kpi label="Billed" value={inr(day.amount)}
           sub={day.count ? `avg ${inr(Math.round(day.amount / day.count))}` : '—'} />
      <Kpi label="Charged to centres" value={inr(day.charged)}
           sub={day.count
             ? day.charged >= day.amount ? 'every sale on an account' : `${inr(day.amount - day.charged)} not yet on an account`
             : '—'} />
      <Kpi label="Downloaded" value={`${n(day.downloaded)} of ${n(day.count)}`} sub="fetched at least once" />
    </>
  );
}

/**
 * A leaderboard card: the top ten, and a "View all" that hands the full
 * list to the panel's modal. The card is sized to ten rows at most, so the
 * chart or tiles beside it never inherit a long tail's height.
 */
function Board<T>({ span, title, rows, render, empty = 'Nothing yet.', onMore }: {
  span: 1 | 2 | 4;
  title: string;
  rows: T[];
  render: (r: T, i: number) => ReactNode;
  empty?: string;
  onMore: (body: ReactNode) => void;
}) {
  const shown = rows.slice(0, BOARD_LIMIT);
  const more = rows.length - shown.length;
  return (
    <div className={`card bento__${span}`}>
      <div className="row" style={{ alignItems: 'baseline', justifyContent: 'space-between', gap: '.6rem' }}>
        <SectionTitle>{title}</SectionTitle>
        {more > 0 && (
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            style={{ marginBottom: '.8rem' }}
            onClick={() => onMore(<ol className="board">{rows.map(render)}</ol>)}
          >
            View all {n(rows.length)}
          </button>
        )}
      </div>
      {shown.length === 0 ? (
        <p className="muted" style={{ fontSize: '.82rem' }}>{empty}</p>
      ) : (
        <ol className="board">{shown.map(render)}</ol>
      )}
      {more > 0 && (
        <p className="muted" style={{ fontSize: '.72rem', marginTop: '.5rem' }}>
          Top {BOARD_LIMIT} of {n(rows.length)}.
        </p>
      )}
    </div>
  );
}

/** The full list of a board, in the dashboard's modal; Escape or the backdrop closes it. */
function BoardModal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal--wide" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={title}>
        <h2 className="modal__title">{title}</h2>
        <div style={{ maxHeight: '70vh', overflowY: 'auto' }}>{children}</div>
        <div className="modal__actions">
          <button type="button" className="btn btn--ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

/**
 * Thirty days of booklets as bars: whole numbers, so bars read better than a
 * line. The bars fill whatever height the card is given, so beside a
 * ten-row board the chart grows into the room rather than leaving it blank.
 */
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
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, flex: 1, minHeight: 140, padding: '.4rem 0 0' }}
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
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '.66rem', color: 'var(--ink-dim)', marginTop: '.3rem' }}>
        {points.length > 0 && [0, 7, 14, 21, points.length - 1].filter((i) => i < points.length).map((i) => (
          <span key={i}>{fmtDay(points[i].date)}</span>
        ))}
      </div>
    </>
  );
}
