import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { accountsApi, type SaleLine, type SalesResponse } from '../api/client';
import { inr } from '../lib/format';
import { InfinityLoader } from '../components/InfinityLoader';

/**
 * The Sales Data view for one client, as a page.
 *
 * Born as a tab inside the account modal and promoted the first time anyone
 * used it: nine columns of itemised lines do not belong inside a dialog, and a
 * month's reconciliation is not a glance — it wants the whole screen, a URL of
 * its own to return to, and room for the table to breathe.
 *
 * The definitions are Telo's /sales/[mcc] screen and therefore the LIS's: a
 * sale line is an amount-checked test dated by its UPDATE time; the sample
 * count is distinct status>1 samples by MODIFIED date. The lab reconciles this
 * against the LIS's own Sales Data screen, so the numbers must be the same
 * numbers.
 *
 * Titling comes from the response itself (clientCode/clientName ride on it),
 * so a deep link or a refresh titles the page without a second fetch.
 */

/** yyyy-mm-dd on the local calendar — toISOString names yesterday before 05:30 IST. */
function isoDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function dayShift(base: string, days: number): string {
  const [y, m, d] = base.split('-').map(Number);
  return isoDay(new Date(y, m - 1, d + days));
}

const AGE_UNIT: Record<number, string> = { 1: 'y', 2: 'mo', 3: 'd' };
const GENDER: Record<number, string> = { 1: 'M', 2: 'F' };

function ageSex(r: SaleLine): string {
  const age = r.age != null ? `${r.age}${r.ageType != null ? (AGE_UNIT[r.ageType] ?? '') : ''}` : null;
  const sex = r.gender != null ? (GENDER[r.gender] ?? null) : null;
  return [age, sex].filter(Boolean).join(' · ') || '—';
}

export function ClientSales() {
  const { mcc = '' } = useParams();
  const mccId = Number(mcc);

  const today = isoDay(new Date());
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<SalesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!Number.isInteger(mccId) || mccId <= 0) return;
    let live = true;
    setLoading(true);
    setError(null);
    accountsApi.sales(mccId, from, to, page)
      .then((r) => { if (live) setData(r); })
      .catch((e) => { if (live) setError(e instanceof Error ? e.message : 'Could not load sales.'); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [mccId, from, to, page]);

  const firstOfWeek = () => {
    const t = new Date();
    const day = t.getDay();
    return dayShift(isoDay(t), day === 0 ? -6 : 1 - day);
  };
  const presets = [
    { label: 'Today', from: today, to: today },
    { label: 'Yesterday', from: dayShift(today, -1), to: dayShift(today, -1) },
    { label: 'This week', from: firstOfWeek(), to: today },
    { label: 'This month', from: today.slice(0, 8) + '01', to: today },
  ];
  const pick = (p: { from: string; to: string }) => { setFrom(p.from); setTo(p.to); setPage(1); };

  const t = data?.totals;
  const rangeStart = data && data.rows.length > 0 ? (data.page - 1) * data.pageSize + 1 : 0;
  const rangeEnd = data && data.rows.length > 0 ? rangeStart + data.rows.length - 1 : 0;

  if (!Number.isInteger(mccId) || mccId <= 0) {
    return <div className="page"><div className="alert alert--error">No such client.</div></div>;
  }

  return (
    <div className="page">
      <div className="page__head">
        <div>
          <h1 className="page__title">
            {data?.clientName ?? 'Sales'}{' '}
            {data?.clientCode && <span className="mono muted" style={{ fontSize: '1rem' }}>{data.clientCode}</span>}
          </h1>
          <p className="page__sub">
            Sales · {from} → {to}
            {t && <> · <b>{t.sampleCount.toLocaleString('en-IN')}</b> sample{t.sampleCount === 1 ? '' : 's'} · sale <b>{inr(t.saleAmount)}</b></>}
          </p>
        </div>
        <Link to="/accounts" className="btn btn--ghost btn--sm" style={{ marginLeft: 'auto' }}>
          ← Accounts
        </Link>
      </div>

      <div className="row" style={{ flexWrap: 'wrap', gap: '.4rem', marginBottom: '.8rem' }}>
        {presets.map((p) => (
          <button key={p.label} type="button"
                  className={`btn btn--sm ${from === p.from && to === p.to ? 'btn--primary' : 'btn--ghost'}`}
                  onClick={() => pick(p)}>
            {p.label}
          </button>
        ))}
        <input className="input input--sm" type="date" value={from} max={to}
               onChange={(e) => { setFrom(e.target.value); setPage(1); }} aria-label="From date" />
        <span className="muted">to</span>
        <input className="input input--sm" type="date" value={to} min={from} max={today}
               onChange={(e) => { setTo(e.target.value); setPage(1); }} aria-label="To date" />
      </div>

      {error && <div className="alert alert--error" style={{ marginBottom: '.8rem' }}>{error}</div>}

      {loading ? (
        <div className="center"><InfinityLoader /><span className="muted">Loading sales…</span></div>
      ) : (
        <>
          <div className="table-wrap table-wrap--cards">
            <table>
              <thead>
                <tr>
                  <th>SID</th><th>PID</th><th>Patient</th><th>Age / Sex</th>
                  <th>Date</th><th>Test</th><th>Name</th><th>Ref. Doctor / Customer</th>
                  <th style={{ textAlign: 'right' }}>Amount</th>
                </tr>
              </thead>
              <tbody>
                {(data?.rows ?? []).map((r, i) => (
                  <tr key={`${r.regdNo}-${r.testCode}-${i}`}>
                    <td className="mono cell--lead">{r.sid ?? '—'}</td>
                    <td className="mono muted cell--meta" data-label="PID">{r.regdNo}</td>
                    <td className="cell--head">{r.patientName ?? '—'}</td>
                    <td className="muted cell--meta" data-label="Age/Sex" style={{ fontSize: '.76rem' }}>{ageSex(r)}</td>
                    <td className="muted cell--meta" data-label="Date" style={{ fontSize: '.76rem', whiteSpace: 'nowrap' }}>{r.sampleDate ?? '—'}</td>
                    <td className="mono cell--meta" data-label="Test" style={{ fontSize: '.76rem' }}>{r.testCode ?? '—'}</td>
                    <td className="cell--body" data-label="Name" style={{ fontSize: '.8rem' }}>{r.testName ?? '—'}</td>
                    <td className="muted cell--body" data-label="Ref" style={{ fontSize: '.76rem' }}>
                      {[r.doctor, r.customer].filter(Boolean).join(' · ') || '—'}
                    </td>
                    <td className="mono cell--tag" style={{ textAlign: 'right', fontWeight: 600 }}>{inr(r.amount)}</td>
                  </tr>
                ))}
                {(data?.rows ?? []).length === 0 && (
                  <tr>
                    <td colSpan={9} className="muted" style={{ textAlign: 'center', padding: '2.5rem' }}>
                      No sales in this range.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="row" style={{ justifyContent: 'space-between', marginTop: '.8rem' }}>
            <span className="muted" style={{ fontSize: '.78rem' }}>
              {data && data.rows.length > 0 && t
                ? `Showing ${rangeStart.toLocaleString('en-IN')}–${rangeEnd.toLocaleString('en-IN')} of ${t.lineCount.toLocaleString('en-IN')} line${t.lineCount === 1 ? '' : 's'}`
                : 'No results'}
            </span>
            {data && (data.page > 1 || data.hasMore) && (
              <div className="row">
                <button className="btn btn--ghost btn--sm" disabled={data.page <= 1 || loading}
                        onClick={() => setPage((p) => p - 1)}>Previous</button>
                <span className="muted" style={{ fontSize: '.78rem' }}>Page {data.page}</span>
                <button className="btn btn--ghost btn--sm" disabled={!data.hasMore || loading}
                        onClick={() => setPage((p) => p + 1)}>Next</button>
              </div>
            )}
          </div>

          <p className="muted" style={{ fontSize: '.7rem', fontStyle: 'italic', marginTop: '.6rem' }}>
            A sale line is a billable test dated by its update time. Sample count is distinct
            samples modified in the period — mirrors the LIS Sales Data screen.
          </p>
        </>
      )}
    </div>
  );
}
