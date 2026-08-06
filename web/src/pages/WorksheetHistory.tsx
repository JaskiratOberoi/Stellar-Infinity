import { useEffect, useState } from 'react';
import { worksheetApi, type ResultAuditRow, type ResultTrendResponse } from '../api/client';
import { fmtDateTime, plainText } from '../lib/format';
import { DeltaTrend } from '../components/DeltaTrend';
import { Pager } from '../components/Pager';
import { InfinityLoader } from '../components/InfinityLoader';

/**
 * History for one sample: what this patient's values have been doing over time,
 * and who changed what.
 *
 * This screen is the whole point of the rebuild. The legacy LIS records that
 * "Results Entered" happened and nothing more — no analyte, no previous value,
 * no reason — so the question an auditor actually asks ("what did this potassium
 * say before someone changed it, and who changed it") has no answer there.
 *
 * Every row here carries both values, and rows written by the auto-authorisation
 * rule are labelled as such so that a result released without a human reading it
 * is never mistaken for one a pathologist signed.
 */
export function WorksheetHistory({ sid, onClose }: { sid: string; onClose: () => void }) {
  const [tab, setTab] = useState<'trend' | 'audit'>('trend');

  const [rows, setRows] = useState<ResultAuditRow[]>([]);
  const [auditPage, setAuditPage] = useState(1);
  const [auditTotal, setAuditTotal] = useState(0);
  const auditPageSize = 100;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [trend, setTrend] = useState<ResultTrendResponse | null>(null);
  const [trendLoading, setTrendLoading] = useState(true);
  const [trendError, setTrendError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setLoading(true);
    worksheetApi
      .audit(sid, auditPage, auditPageSize)
      .then((r) => { if (live) { setRows(r.rows); setAuditTotal(r.total); } })
      .catch((e) => { if (live) setError(e instanceof Error ? e.message : 'Could not load the history.'); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [sid, auditPage]);

  // Fetched alongside the audit rather than on tab switch: the trend walks a
  // multi-million-row table, and starting it only when the operator clicks
  // makes the tab feel broken for the second or so it takes.
  useEffect(() => {
    let live = true;
    worksheetApi
      .trend(sid)
      .then((r) => { if (live) setTrend(r); })
      .catch((e) => { if (live) setTrendError(e instanceof Error ? e.message : 'Could not load the trend.'); })
      .finally(() => { if (live) setTrendLoading(false); });
    return () => { live = false; };
  }, [sid]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose} style={{ zIndex: 60 }}>
      <div
        className="modal modal--wide"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`History for ${sid}`}
      >
        <h2 className="modal__title">History · <span className="mono">{sid}</span></h2>

        <div className="tabs" role="tablist">
          <button
            role="tab"
            aria-selected={tab === 'trend'}
            className={`tab${tab === 'trend' ? ' tab--on' : ''}`}
            onClick={() => setTab('trend')}
          >
            Trend
            {trend && trend.analytes.length > 0 && (
              <span className="tab__count">{trend.analytes.length}</span>
            )}
          </button>
          <button
            role="tab"
            aria-selected={tab === 'audit'}
            className={`tab${tab === 'audit' ? ' tab--on' : ''}`}
            onClick={() => setTab('audit')}
          >
            Audit trail
            {auditTotal > 0 && <span className="tab__count">{auditTotal}</span>}
          </button>
        </div>

        {tab === 'trend' ? (
          <div style={{ maxHeight: '58vh', overflowY: 'auto' }}>
            {trendError && <div className="alert alert--error">{trendError}</div>}
            {trendLoading ? (
              <div className="center" style={{ minHeight: 140 }}><InfinityLoader /></div>
            ) : trend ? (
              <DeltaTrend analytes={trend.analytes} match={trend.match} />
            ) : null}
          </div>
        ) : (
        <>
        <p className="muted" style={{ fontSize: '.78rem' }}>
          Append-only. Entries cannot be edited or deleted, including by an administrator.
        </p>

        {error && <div className="alert alert--error">{error}</div>}

        {loading ? (
          <div className="center" style={{ minHeight: 140 }}><InfinityLoader /></div>
        ) : (
          <div className="table-wrap table-wrap--cards" style={{ maxHeight: '58vh', overflowY: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th style={{ width: 150 }}>When</th>
                  <th style={{ width: 110 }}>Who</th>
                  <th style={{ width: 130 }}>Action</th>
                  <th>Test</th>
                  <th>Change</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="muted cell--meta" data-label="When" style={{ fontSize: '.74rem', whiteSpace: 'nowrap' }}>
                      {fmtDateTime(r.occurredAt)}
                    </td>
                    <td className="cell--meta" data-label="Who" style={{ fontSize: '.78rem' }}>
                      {r.actorUsername ?? '—'}
                      {r.actorIp && (
                        <div className="muted mono" style={{ fontSize: '.66rem' }}>{r.actorIp}</div>
                      )}
                    </td>
                    <td className="cell--tag"><ActionBadge action={r.action} source={r.source} /></td>
                    {/* Which test was touched is what identifies an entry; the
                        old → new value is the entry's substance, so it gets the
                        card's body rather than a squeezed right-hand column. */}
                    <td className="cell--lead" style={{ fontSize: '.78rem' }}>
                      {plainText(r.testName) || r.testCode || <span className="muted">sample</span>}
                    </td>
                    <td className="mono cell--body" data-label="Change" style={{ fontSize: '.74rem' }}>
                      <span className="muted" style={{ textDecoration: 'line-through' }}>
                        {display(r.oldValue, r.field)}
                      </span>
                      {' → '}
                      <b>{display(r.newValue, r.field)}</b>
                      <div className="muted" style={{ fontSize: '.66rem' }}>{r.field}</div>
                    </td>
                    <td className="muted cell--body" data-label="Reason" style={{ fontSize: '.74rem' }}>{r.reason ?? '—'}</td>
                  </tr>
                ))}

                {rows.length === 0 && (
                  <tr>
                    <td colSpan={6} className="muted" style={{ textAlign: 'center', padding: '2rem' }}>
                      Nothing recorded yet. Changes made through the legacy LIS do not appear here — it keeps no
                      value-level history.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        <Pager page={auditPage} pageSize={auditPageSize} total={auditTotal}
               noun="entry" nounPlural="entries" onPage={setAuditPage} />
        </>
        )}

        <div className="modal__actions">
          <button className="btn btn--ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

/** Bits and statuses are stored as strings; render them the way a person reads them. */
function display(v: string | null, field: string | null) {
  if (v === null || v === '') return '∅';
  if (field === 'auth' || field === 'abnormal') return v === '1' ? 'yes' : 'no';
  if (field === 'status') return `status ${v}`;
  return v.length > 40 ? `${v.slice(0, 40)}…` : v;
}

function ActionBadge({ action, source }: { action: string; source: string }) {
  // Auto-authorisation gets its own, deliberately conspicuous treatment: it is
  // the one action in this list that no person performed.
  if (action === 'auto_authorize' || source === 'auto') {
    return <span className="badge badge--telo" title="Authorised by rule, not by a person">auto-authorised</span>;
  }

  const label = action.replace(/_/g, ' ');
  const kind =
    action === 'reopen' || action === 'reject' ? 'danger'
      : action === 'authorize' ? 'infinity'
        : 'lis';

  if (kind === 'danger') {
    return (
      <span
        className="badge"
        style={{ color: 'var(--danger)', borderColor: 'var(--danger-line)', background: 'var(--danger-soft)' }}
      >
        {label}
      </span>
    );
  }

  return <span className={`badge badge--${kind}`}>{label}</span>;
}
