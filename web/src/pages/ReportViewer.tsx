import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { fmtDateTime } from '../lib/format';
import type { WorksheetRow } from './Reports';
import { StatusBadge } from './Reports';
import { InfinityLoader } from '../components/InfinityLoader';

interface TestResult {
  resultId: number;
  testCode: string | null;
  testName: string | null;
  testType: string | null;
  value: string | null;
  unit: string | null;
  normalRange: string | null;
  abnormal: boolean;
  authorized: boolean;
  comments: string | null;
  departmentName: string | null;
}

type FullRow = WorksheetRow & { results: TestResult[] };

export function ReportViewer({ sid, onClose }: { sid: string; onClose: () => void }) {
  const [row, setRow] = useState<FullRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    api
      .get<FullRow>(`/api/reports/${encodeURIComponent(sid)}`)
      .then((r) => { if (live) setRow(r); })
      .catch((e) => { if (live) setError(e instanceof Error ? e.message : 'Could not load this report.'); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [sid]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Group by department, preserving the order the LIS returned them in — that
  // order is the printed report's order and operators read it that way.
  const departments = useMemo(() => {
    const groups = new Map<string, TestResult[]>();
    for (const r of row?.results ?? []) {
      const key = r.departmentName?.trim() || 'Results';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(r);
    }
    return [...groups.entries()];
  }, [row]);

  const abnormalCount = row?.results.filter((r) => r.abnormal).length ?? 0;
  const pendingCount = row?.results.filter((r) => !r.authorized).length ?? 0;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" style={{ width: 'min(880px, 100%)' }} onClick={(e) => e.stopPropagation()}
           role="dialog" aria-modal="true" aria-label={`Report ${sid}`}>
        {loading ? (
          <div className="center" style={{ minHeight: 160 }}><InfinityLoader /></div>
        ) : error ? (
          <>
            <div className="alert alert--error">{error}</div>
            <div className="modal__actions"><button className="btn btn--ghost" onClick={onClose}>Close</button></div>
          </>
        ) : row ? (
          <>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <h2 className="modal__title">{row.patientName ?? 'Unnamed patient'}</h2>
                <p className="muted" style={{ fontSize: '.8rem', marginTop: '.15rem' }}>
                  SID <b className="mono">{row.sid}</b>
                  {row.clientCode && ` · ${row.clientCode}`}
                  {row.sex && ` · ${row.sex}`}
                  {row.age != null && ` · ${row.age}${row.ageUnit ?? ''}`}
                </p>
              </div>
              <StatusBadge status={row.status} statusCode={row.statusCode} />
            </div>

            <div className="row" style={{ gap: '.5rem', flexWrap: 'wrap' }}>
              {abnormalCount > 0 && (
                <span className="badge" style={{ color: 'var(--danger)', borderColor: 'var(--danger-line)', background: 'var(--danger-soft)' }}>
                  {abnormalCount} out of range
                </span>
              )}
              {pendingCount > 0 && (
                <span className="badge badge--telo">{pendingCount} unauthorised</span>
              )}
              {row.results.length === 0 && (
                <span className="muted" style={{ fontSize: '.82rem' }}>No results entered yet.</span>
              )}
            </div>

            {row.clinicalHistory && (
              <p className="muted" style={{ fontSize: '.8rem', lineHeight: 1.6 }}>
                <b>Clinical history:</b> {row.clinicalHistory}
              </p>
            )}

            <div style={{ maxHeight: '52vh', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              {departments.map(([dept, results]) => (
                <section key={dept}>
                  <h3 style={{
                    fontSize: '.66rem', fontWeight: 600, letterSpacing: '.14em', textTransform: 'uppercase',
                    color: 'var(--teal)', marginBottom: '.4rem',
                  }}>
                    {dept}
                  </h3>
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Test</th>
                          <th style={{ textAlign: 'right' }}>Result</th>
                          <th>Unit</th>
                          <th>Reference</th>
                        </tr>
                      </thead>
                      <tbody>
                        {results.map((t) => (
                          <tr key={t.resultId}>
                            <td>
                              {t.testName ?? t.testCode ?? '—'}
                              {!t.authorized && (
                                <span className="muted" style={{ fontSize: '.68rem' }}> · unauthorised</span>
                              )}
                              {t.comments && (
                                <div className="muted" style={{ fontSize: '.72rem', marginTop: '.15rem' }}>{t.comments}</div>
                              )}
                            </td>
                            <td className="mono" style={{
                              textAlign: 'right',
                              fontWeight: t.abnormal ? 600 : 400,
                              color: t.abnormal ? 'var(--danger)' : undefined,
                            }}>
                              {t.value ?? '—'}
                              {t.abnormal && <span aria-label="out of range" title="Out of range"> ▲</span>}
                            </td>
                            <td className="muted">{t.unit ?? '—'}</td>
                            <td className="muted" style={{ fontSize: '.78rem' }}>{t.normalRange ?? '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              ))}
            </div>

            <p className="muted" style={{ fontSize: '.72rem', lineHeight: 1.6 }}>
              Drawn {fmtDateTime(row.sampleDrawn)} · registered {fmtDateTime(row.registeredAt)} · last updated{' '}
              {fmtDateTime(row.lastModifiedAt)}
            </p>

            <div className="modal__actions">
              <button className="btn btn--ghost" onClick={onClose}>Close</button>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
