import { useEffect, useState } from 'react';
import { api } from '../api/client';

/**
 * Reporting settings — the super admin's switches for what the standard
 * report prints. Lab-wide, effective on the next report opened or
 * downloaded (the PDF cache carries the switches in its key).
 *
 * The first switch is the failsafe for "Reading this thyroid profile": off,
 * and every thyroid profile prints exactly as it did before the figure —
 * the legacy interpretation text and the notes — without a deploy.
 */
interface ReportingSettings { thyroidFigure: boolean }

export function ReportingSettingsPage() {
  const [data, setData] = useState<ReportingSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api.get<ReportingSettings>('/api/settings/reporting')
      .then((r) => { if (live) setData(r); })
      .catch((e) => { if (live) setError(e instanceof Error ? e.message : 'Could not load the reporting settings.'); });
    return () => { live = false; };
  }, []);

  const save = async (next: ReportingSettings) => {
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      const r = await api.put<ReportingSettings>('/api/settings/reporting', next);
      setData(r);
      setNotice(r.thyroidFigure
        ? 'On. Thyroid profiles print the reading figure from the next report opened or downloaded.'
        : 'Off. Thyroid profiles print as before — the legacy interpretation text and the notes — from the next report opened or downloaded.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <h1 className="page__title">Reporting settings</h1>
      <p className="muted" style={{ marginTop: '.2rem' }}>
        Lab-wide switches for what the standard report prints. A change applies to the next report opened or
        downloaded, on every paper and in every format; nothing already printed changes.
      </p>

      {error && <div className="alert alert--error" style={{ marginTop: '1rem' }}>{error}</div>}
      {notice && <div className="alert" style={{ marginTop: '1rem' }}>{notice}</div>}

      {data && (
        <div className="card" style={{ marginTop: '1.2rem', maxWidth: 720 }}>
          <div style={{ display: 'flex', gap: '.9rem', alignItems: 'flex-start' }}>
            {/* The same switch the Jarvis rules use, so on/off reads the same
                everywhere in Settings. */}
            <button
              type="button"
              role="switch"
              aria-checked={data.thyroidFigure}
              aria-label="Reading this thyroid profile under thyroid profiles"
              className={`toggle${data.thyroidFigure ? ' toggle--on' : ''}`}
              disabled={busy}
              title={data.thyroidFigure ? 'On — thyroid profiles print the reading figure' : 'Off — thyroid profiles print as before'}
              style={{ marginTop: '.15rem', flex: 'none' }}
              onClick={() => void save({ ...data, thyroidFigure: !data.thyroidFigure })}
            />
            <span>
              <span style={{ fontWeight: 700 }}>“Reading this thyroid profile” under thyroid profiles</span>
              <span className="muted" style={{ display: 'block', fontSize: '.82rem', marginTop: '.3rem', lineHeight: 1.6 }}>
                The TSH-against-T4 grid with T3 beside it, each hormone on its reference band, and the pattern in plain
                words, printed under Thyroid Profile I and any other profile carrying TSH and T4. While it prints, the
                profile's catalogue interpretation text stands down; the notes still print. Switch it off and every
                thyroid profile prints exactly as it did before the figure — no deploy needed.
              </span>
              <span className="muted" style={{ display: 'block', fontSize: '.78rem', marginTop: '.4rem' }}>
                Currently <b>{data.thyroidFigure ? 'on' : 'off'}</b>. Each change is on the audit trail and clears the
                report PDF cache.
              </span>
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
