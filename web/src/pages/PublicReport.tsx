import { useCallback, useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { InfinityLoader } from '../components/InfinityLoader';

/**
 * Where the QR on a printed report lands.
 *
 * No session, no navigation, nothing to explore — one document, fetched with
 * the token printed on the paper the patient is holding. Everything this page
 * can reach is gated server-side; see PublicReportEndpoints for what the token
 * does and does not permit.
 *
 * ── WHY IT DOES NOT AUTO-DOWNLOAD ─────────────────────────────────────────
 * The obvious version fires the download on mount. It is worse: a phone camera
 * opens this in an in-app browser, several of which drop a programmatic
 * download silently, and the patient is left on a blank page believing their
 * report does not exist. A button they press is a download the browser treats
 * as user-initiated, which is the case those browsers actually handle.
 */
export function PublicReport() {
  const { sid = '' } = useParams();
  const [params] = useSearchParams();
  const token = params.get('t') ?? '';

  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { document.title = `Report ${sid} · Noble Diagnostics`; }, [sid]);

  const download = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/public/reports/${encodeURIComponent(sid)}/pdf?t=${encodeURIComponent(token)}`);

      if (!res.ok) {
        // The server answers 404 for a bad token, an unknown SID and a held
        // report alike, on purpose — so this message cannot be more specific
        // than the server was willing to be, and must not pretend otherwise.
        throw new Error(
          'This report link could not be opened. It may have expired or been mistyped — '
          + 'please contact the collection centre on your report.');
      }

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Report_${sid}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The report could not be downloaded.');
    } finally {
      setBusy(false);
    }
  }, [sid, token]);

  return (
    <div className="pubreport">
      <div className="pubreport__card">
        <h1 className="pubreport__title">Your test report</h1>
        <p className="pubreport__sid">
          Sample <b className="mono">{sid}</b>
        </p>

        {!token && (
          <div className="alert alert--error">
            This link is incomplete. Please scan the QR code on your report again.
          </div>
        )}
        {error && <div className="alert alert--error">{error}</div>}

        {busy ? (
          <div className="center" style={{ minHeight: 90 }}><InfinityLoader /></div>
        ) : (
          <button className="btn btn--primary" disabled={!token} onClick={() => void download()}>
            {done ? 'Download again' : 'Download report (PDF)'}
          </button>
        )}

        {done && (
          <p className="muted" style={{ fontSize: '.8rem' }}>
            Saved to your downloads. Keep this report for your records.
          </p>
        )}

        <p className="pubreport__note">
          This report is confidential and intended for the patient named on it. Please discuss the
          results with your doctor — a value outside a reference range is not by itself a diagnosis.
        </p>
      </div>
    </div>
  );
}
