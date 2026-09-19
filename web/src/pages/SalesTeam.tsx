import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { salesApi, type SalesTeamRow } from '../api/client';
import { InfinityLoader } from '../components/InfinityLoader';
import { inr, todayIst } from './Dashboard';

/**
 * The sales team, one row each: territory size, the month's target and what
 * came in against it. For the Sales Admin and above — the salesperson's own
 * view is the dashboard at "/". A row opens that person's dashboard, where
 * the target is set.
 */
export function SalesTeam() {
  const [month, setMonth] = useState(todayIst().slice(0, 7));
  const [rows, setRows] = useState<SalesTeamRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    salesApi.team(month)
      .then((r) => { if (live) setRows(r); })
      .catch((e) => { if (live) setError(e instanceof Error ? e.message : 'Could not load the team.'); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [month]);

  const total = rows.reduce((s, r) => s + r.achieved, 0);
  const totalTarget = rows.reduce((s, r) => s + r.target, 0);
  const [y, m] = month.split('-').map(Number);
  const monthName = new Date(y, m - 1, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });

  return (
    <div className="page">
      <div className="page__head">
        <div>
          <h1 className="page__title">Sales team</h1>
          <p className="page__sub">
            {rows.length > 0
              ? `${rows.length} salespeople · ${inr(total)} booked in ${monthName}${totalTarget > 0 ? ` against ${inr(totalTarget)} set` : ''}`
              : 'Every salesperson with a territory, and their month'}
          </p>
        </div>
        <label className="row" style={{ gap: '.5rem', alignItems: 'center' }}>
          <span className="muted" style={{ fontSize: '.66rem', letterSpacing: '.14em', textTransform: 'uppercase' }}>Month</span>
          <input className="input" type="month" value={month} max={todayIst().slice(0, 7)} onChange={(e) => e.target.value && setMonth(e.target.value)} />
        </label>
      </div>

      {error && <div className="alert alert--error">{error}</div>}
      {loading ? (
        <div className="center" style={{ minHeight: 160 }}><InfinityLoader /></div>
      ) : (
        <div className="table-wrap table-wrap--cards">
          <table>
            <thead>
              <tr>
                <th>Salesperson</th>
                <th>Type</th>
                <th style={{ textAlign: 'right' }}>Centres</th>
                <th style={{ textAlign: 'right' }}>Target</th>
                <th style={{ textAlign: 'right' }}>Sales</th>
                <th style={{ minWidth: 160 }}>Achieved</th>
                <th style={{ textAlign: 'right' }}>Patients</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const pct = r.target > 0 ? Math.round((r.achieved / r.target) * 100) : null;
                return (
                  <tr key={r.userId}>
                    <td className="cell--lead">
                      <Link to={`/sales-team/${r.userId}`}><b>{r.name || r.username}</b></Link>
                      {r.name && <div className="muted" style={{ fontSize: '.72rem' }}>{r.username}</div>}
                    </td>
                    <td className="muted cell--meta" data-label="Type">{r.type ?? '—'}</td>
                    <td className="mono cell--meta" data-label="Centres" style={{ textAlign: 'right' }}>{r.centres.toLocaleString('en-IN')}</td>
                    <td className="mono cell--meta" data-label="Target" style={{ textAlign: 'right' }}>{r.target > 0 ? inr(r.target) : <span className="muted">—</span>}</td>
                    <td className="mono cell--value" data-label="Sales" style={{ textAlign: 'right' }}>{inr(r.achieved)}</td>
                    <td data-label="Achieved">
                      {pct != null ? (
                        <div className="row" style={{ gap: '.5rem', alignItems: 'center' }}>
                          <div className="progress" style={{ flex: 1, marginTop: 0 }}>
                            <div className={`progress__bar${pct >= 100 ? ' progress__bar--met' : ''}`} style={{ width: `${Math.min(100, pct)}%` }} />
                          </div>
                          <span className="mono" style={{ fontSize: '.78rem', minWidth: 40, textAlign: 'right' }}>{pct}%</span>
                        </div>
                      ) : <span className="muted" style={{ fontSize: '.74rem' }}>no target</span>}
                    </td>
                    <td className="mono cell--meta" data-label="Patients" style={{ textAlign: 'right' }}>{r.patients.toLocaleString('en-IN')}</td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr><td colSpan={7} className="muted" style={{ textAlign: 'center', padding: '2rem' }}>No salesperson has a territory mapped.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
