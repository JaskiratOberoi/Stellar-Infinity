import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { downloadFile, fmtDateTime } from '../lib/format';
import { InfinityLoader } from '../components/InfinityLoader';

export interface Gauge {
  kind: 'both' | 'max' | 'min';
  low: number | null;
  high: number | null;
  value: number;
  pos: number;
  zone: 'normal' | 'low' | 'high';
}

export interface SmartAnalyte {
  testCode: string | null;
  lisName: string;
  friendlyName: string | null;
  value: string | null;
  unit: string | null;
  rangeText: string | null;
  abnormal: boolean;
  zone: 'normal' | 'low' | 'high';
  gauge: Gauge | null;
  what: string | null;
  meaning: string | null;
  advice: string | null;
  comments: string | null;
}

export interface SmartSection {
  categoryId: string;
  title: string;
  tagline: string;
  about: string | null;
  analytes: SmartAnalyte[];
  abnormalCount: number;
}

export interface SmartReportData {
  sid: string;
  patientName: string | null;
  sex: string | null;
  age: number | null;
  ageUnit: string | null;
  clientCode: string | null;
  sampleDrawn: string | null;
  reportedAt: string | null;
  totalAnalytes: number;
  abnormalCount: number;
  withheldCount: number;
  fullyAuthorised: boolean;
  sections: SmartSection[];
}

export function SmartReportModal({ sid, onClose }: { sid: string; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const download = async () => {
    setBusy(true);
    setDownloadError(null);
    try {
      await downloadFile(`/api/reports/${encodeURIComponent(sid)}/smart/pdf`);
    } catch (e) {
      setDownloadError(e instanceof Error ? e.message : 'The download failed.');
    } finally {
      setBusy(false);
    }
  };

  const [data, setData] = useState<SmartReportData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    api
      .get<SmartReportData>(`/api/reports/${encodeURIComponent(sid)}/smart`)
      .then((r) => { if (live) setData(r); })
      .catch((e) => { if (live) setError(e instanceof Error ? e.message : 'Could not build the smart report.'); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [sid]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" style={{ width: 'min(820px, 100%)' }} onClick={(e) => e.stopPropagation()}
           role="dialog" aria-modal="true" aria-label={`Smart report ${sid}`}>
        {loading ? (
          <div className="center" style={{ minHeight: 160 }}><InfinityLoader /></div>
        ) : error ? (
          <>
            <div className="alert alert--error">{error}</div>
            <div className="modal__actions"><button className="btn btn--ghost" onClick={onClose}>Close</button></div>
          </>
        ) : data ? (
          <>
            <div>
              <h2 className="modal__title">Your health summary</h2>
              <p className="muted" style={{ fontSize: '.82rem', marginTop: '.2rem' }}>
                {data.patientName ?? 'Patient'}
                {data.sex && ` · ${data.sex}`}
                {data.age != null && ` · ${data.age}${data.ageUnit ?? ''}`}
                {' · '}SID <span className="mono">{data.sid}</span>
              </p>
            </div>

            <div className="row" style={{ gap: '.5rem', flexWrap: 'wrap' }}>
              <span className="badge badge--infinity">{data.totalAnalytes} results</span>
              {data.abnormalCount > 0 ? (
                <span className="badge" style={{ color: 'var(--danger)', borderColor: 'var(--danger-line)', background: 'var(--danger-soft)' }}>
                  {data.abnormalCount} need attention
                </span>
              ) : (
                data.totalAnalytes > 0 && <span className="badge badge--infinity">All within range</span>
              )}
            </div>

            {!data.fullyAuthorised && (
              <div className="alert alert--info">
                <b>Provisional report.</b> {data.withheldCount} result{data.withheldCount === 1 ? ' has' : 's have'} not
                been authorised by the laboratory yet and {data.withheldCount === 1 ? 'is' : 'are'} not shown. The full
                report will be available once testing is complete.
              </div>
            )}

            {data.totalAnalytes === 0 && (
              <p className="muted" style={{ fontSize: '.85rem' }}>
                No authorised results are available for this sample yet.
              </p>
            )}

            <div style={{ maxHeight: '56vh', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '1.3rem' }}>
              {data.sections.map((s) => (
                <section key={s.categoryId}>
                  <div style={{ marginBottom: '.6rem' }}>
                    <h3 style={{ fontSize: '.95rem', fontWeight: 500, letterSpacing: '.02em' }}>
                      {s.title}
                      {s.abnormalCount > 0 && (
                        <span className="badge" style={{
                          marginLeft: '.6rem', color: 'var(--danger)',
                          borderColor: 'var(--danger-line)', background: 'var(--danger-soft)',
                        }}>
                          {s.abnormalCount}
                        </span>
                      )}
                    </h3>
                    <p className="muted" style={{ fontSize: '.78rem' }}>{s.tagline}</p>
                  </div>

                  <div className="stack" style={{ gap: '.7rem' }}>
                    {s.analytes.map((a, i) => <AnalyteCard key={`${a.testCode ?? a.lisName}-${i}`} a={a} />)}
                  </div>
                </section>
              ))}
            </div>

            <p className="muted" style={{ fontSize: '.72rem', lineHeight: 1.6 }}>
              Sample drawn {fmtDateTime(data.sampleDrawn)} · reported {fmtDateTime(data.reportedAt)}.
              This summary is for information only and is not a diagnosis. Please discuss these results with your doctor.
            </p>

            {downloadError && (
              <div className="alert alert--error" style={{ fontSize: '.8rem' }}>{downloadError}</div>
            )}

            <div className="modal__actions">
              <button className="btn btn--ghost" onClick={onClose}>Close</button>
              <button className="btn btn--primary" disabled={busy}
                      onClick={() => void download()}>
                {busy ? 'Preparing…' : 'Download summary'}
              </button>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

function AnalyteCard({ a }: { a: SmartAnalyte }) {
  const tone = a.zone === 'normal' ? 'var(--teal)' : 'var(--danger)';

  return (
    <div className="card" style={{ padding: '.85rem 1rem' }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline', gap: '.8rem' }}>
        <div>
          <b style={{ fontSize: '.88rem' }}>{a.friendlyName ?? a.lisName}</b>
          {a.friendlyName && a.friendlyName !== a.lisName && (
            <span className="muted" style={{ fontSize: '.72rem' }}> · {a.lisName}</span>
          )}
        </div>
        <div className="mono" style={{ fontWeight: 600, color: tone, whiteSpace: 'nowrap' }}>
          {a.value ?? '—'} {a.unit && <span className="muted" style={{ fontWeight: 400 }}>{a.unit}</span>}
        </div>
      </div>

      {a.gauge ? <GaugeBar g={a.gauge} /> : a.rangeText && (
        <p className="muted" style={{ fontSize: '.72rem', marginTop: '.35rem' }}>Reference: {a.rangeText}</p>
      )}

      {a.what && <p className="muted" style={{ fontSize: '.78rem', marginTop: '.5rem', lineHeight: 1.55 }}>{a.what}</p>}

      {a.meaning && (
        <p style={{ fontSize: '.78rem', marginTop: '.4rem', lineHeight: 1.55, color: 'var(--ink)' }}>
          <b>{a.zone === 'high' ? 'Higher than usual:' : 'Lower than usual:'}</b> {a.meaning}
        </p>
      )}

      {a.advice && (
        <p style={{
          fontSize: '.76rem', marginTop: '.45rem', lineHeight: 1.55,
          padding: '.5rem .65rem', borderRadius: 8,
          background: a.abnormal ? 'var(--warn-soft)' : 'var(--accent-softer)',
          color: 'var(--ink-dim)',
        }}>
          {a.advice}
        </p>
      )}

      {a.comments && (
        <p className="muted" style={{ fontSize: '.74rem', marginTop: '.4rem', fontStyle: 'italic' }}>{a.comments}</p>
      )}
    </div>
  );
}

/**
 * The normal band is the middle 50% of the track (or 60% on a one-sided range);
 * the API computes the marker position so the geometry matches Telo's exactly.
 */
function GaugeBar({ g }: { g: Gauge }) {
  const bandStart = g.kind === 'both' ? 25 : g.kind === 'max' ? 0 : 40;
  const bandWidth = g.kind === 'both' ? 50 : 60;

  return (
    <div style={{ marginTop: '.55rem' }}>
      <div style={{ position: 'relative', height: 8, borderRadius: 5, background: 'var(--track)', overflow: 'visible' }}>
        <div style={{
          position: 'absolute', left: `${bandStart}%`, width: `${bandWidth}%`, top: 0, bottom: 0,
          borderRadius: 5, background: 'linear-gradient(90deg, var(--cyan), var(--teal))', opacity: 0.55,
        }} />
        <div
          style={{
            position: 'absolute', left: `${g.pos * 100}%`, top: -3,
            width: 14, height: 14, marginLeft: -7, borderRadius: '50%',
            background: g.zone === 'normal' ? 'var(--teal)' : 'var(--danger)',
            border: '2px solid var(--surface)',
            boxShadow: '0 1px 4px rgba(0,0,0,.3)',
          }}
          title={`${g.value}`}
        />
      </div>
      <div className="row" style={{ justifyContent: 'space-between', marginTop: '.3rem' }}>
        <span className="muted" style={{ fontSize: '.68rem' }}>
          {g.kind === 'max' ? '' : g.low != null ? g.low : ''}
        </span>
        <span className="muted" style={{ fontSize: '.68rem' }}>
          {g.kind === 'both' ? `normal ${g.low}–${g.high}` : g.kind === 'max' ? `normal below ${g.high}` : `normal above ${g.low}`}
        </span>
        <span className="muted" style={{ fontSize: '.68rem' }}>{g.high != null ? g.high : ''}</span>
      </div>
    </div>
  );
}
