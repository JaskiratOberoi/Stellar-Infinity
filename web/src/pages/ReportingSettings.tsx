import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { IS_STAGING } from '../lib/env';

/**
 * Reporting settings — the super admin's switches for what the standard
 * report prints. Lab-wide, effective on the next report opened or
 * downloaded (the PDF cache carries the switches in its key).
 *
 * The first switch is the failsafe for "Reading this thyroid profile": off,
 * and every thyroid profile prints exactly as it did before the figure —
 * the legacy interpretation text and the notes — without a deploy.
 */
interface ReportingSettings { thyroidFigure: boolean; trending: boolean }

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

  const save = async (patch: Partial<ReportingSettings>, said: (r: ReportingSettings) => string) => {
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      const r = await api.put<ReportingSettings>('/api/settings/reporting', patch);
      setData(r);
      setNotice(said(r));
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
              onClick={() => void save({ thyroidFigure: !data.thyroidFigure }, (r) => r.thyroidFigure
                ? 'On. Thyroid profiles print the reading figure from the next report opened or downloaded.'
                : 'Off. Thyroid profiles print as before — the legacy interpretation text and the notes — from the next report opened or downloaded.')}
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

          <div style={{ display: 'flex', gap: '.9rem', alignItems: 'flex-start', marginTop: '1.2rem', paddingTop: '1.2rem', borderTop: '1px solid var(--line)' }}>
            <button
              type="button"
              role="switch"
              aria-checked={data.trending}
              aria-label="Trending report on the standard report and in the Smart Report"
              className={`toggle${data.trending ? ' toggle--on' : ''}`}
              disabled={busy}
              title={data.trending ? 'On — reports carry the Trending page where earlier visits exist' : 'Off — no Trending page'}
              style={{ marginTop: '.15rem', flex: 'none' }}
              onClick={() => void save({ trending: !data.trending }, (r) => r.trending
                ? 'On. Reports print the Trending page where the same person has earlier results.'
                : 'Off. No Trending page on any report.')}
            />
            <span>
              <span style={{ fontWeight: 700 }}>Trending report — earlier visits beside today's results</span>
              <span className="muted" style={{ display: 'block', fontSize: '.82rem', marginTop: '.3rem', lineHeight: 1.6 }}>
                For every numeric analyte the same person has had before, a page showing its bands down the side and
                one column per visit, with the value sitting in its band — on the standard report as its last page and
                in the Smart Report as a chapter. A person is matched on name, mobile and sex with an age check, and
                the page says so; a registration with no mobile gets no page.
                {IS_STAGING
                  ? ' This build is staging: the page shows here while it is under test.'
                  : ' Under test on staging: a production build does not print it yet, whatever this switch says.'}
              </span>
              <span className="muted" style={{ display: 'block', fontSize: '.78rem', marginTop: '.4rem' }}>
                Currently <b>{data.trending ? 'on' : 'off'}</b>.
              </span>
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
