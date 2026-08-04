import { useState, type ChangeEvent } from 'react';
import { api, ApiError } from '../api/client';

interface PreviewCell { rowNumber: number; sid: string; testCode: string; value: string }

interface Preview {
  testCodes: string[];
  dataRows: number;
  readings: number;
  warnings: string[];
  sample: PreviewCell[];
  distinctSids: number;
}

interface ApplyResult {
  batchId: string;
  accepted: number;
  applied: number;
  unmatched: number;
  duplicate: number;
  warnings: string[];
}

export function ImportResults({ onClose, onApplied }: { onClose: () => void; onApplied: () => void }) {
  const [fileName, setFileName] = useState('');
  const [content, setContent] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [result, setResult] = useState<ApplyResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;

    setError(null); setPreview(null); setResult(null);
    setFileName(f.name);

    const text = await f.text();
    setContent(text);
    setBusy(true);
    try {
      setPreview(await api.post<Preview>('/api/instruments/import/preview', { fileName: f.name, content: text }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not read that file.');
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    setBusy(true); setError(null);
    try {
      setResult(await api.post<ApplyResult>('/api/instruments/import/apply', { fileName, content }));
      onApplied();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The import failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" style={{ width: 'min(760px, 100%)' }} onClick={(e) => e.stopPropagation()}
           role="dialog" aria-modal="true" aria-label="Import results">
        <h2 className="modal__title">Import results from a file</h2>

        {error && <div className="alert alert--error">{error}</div>}

        {result ? (
          <>
            <div className={result.applied > 0 ? 'alert alert--ok' : 'alert alert--info'}>
              <b>{result.applied}</b> of {result.accepted} reading{result.accepted === 1 ? '' : 's'} applied.
              {result.unmatched > 0 && <> {result.unmatched} did not match and {result.unmatched === 1 ? 'is' : 'are'} waiting in the inbox.</>}
              {result.duplicate > 0 && <> {result.duplicate} were already imported.</>}
            </div>
            <p className="muted" style={{ fontSize: '.78rem', lineHeight: 1.6 }}>
              Nothing was auto-authorised — applied values are set on the result awaiting sign-off on the
              worksheet. Unmatched rows stay in the inbox with a reason and can be replayed once the sample is
              registered or the test added to the order.
            </p>
            <div className="modal__actions">
              <button className="btn btn--primary" onClick={onClose}>Done</button>
            </div>
          </>
        ) : (
          <>
            <div className="field">
              <label htmlFor="f">CSV or TSV file</label>
              <input id="f" type="file" accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values"
                     onChange={(e) => void onFile(e)} />
              <span className="muted" style={{ fontSize: '.72rem' }}>
                One row per sample; the header row carries test codes. Excel files are not read directly —
                export as CSV, so a binary format cannot silently mis-parse a clinical value.
              </span>
            </div>

            <details>
              <summary className="muted" style={{ fontSize: '.75rem', cursor: 'pointer' }}>Expected layout</summary>
              <pre className="mono" style={{
                fontSize: '.72rem', marginTop: '.5rem', padding: '.6rem .8rem',
                background: 'var(--field-bg)', border: '1px solid var(--line)',
                borderRadius: 8, overflowX: 'auto',
              }}>
{`SID,GLU,UREA,CREA
895608909737,5.4,4.2,78
895608909738,6.1,,81`}
              </pre>
              <p className="muted" style={{ fontSize: '.72rem', lineHeight: 1.6 }}>
                Blank cells are skipped, not imported as empty — so a gap never blanks an existing result.
                Columns like Patient, Age or Date are ignored rather than treated as analytes.
              </p>
            </details>

            {busy && !preview && <div className="row"><div className="spinner" /><span className="muted">Reading…</span></div>}

            {preview && (
              <>
                <div className="grid2">
                  <Stat label="Rows" value={preview.dataRows} />
                  <Stat label="Samples" value={preview.distinctSids} />
                  <Stat label="Analytes" value={preview.testCodes.length} />
                  <Stat label="Readings" value={preview.readings} />
                </div>

                {preview.warnings.map((w, i) => (
                  <div key={i} className="alert alert--info">{w}</div>
                ))}

                <div>
                  <div className="muted" style={{ fontSize: '.68rem', letterSpacing: '.14em', textTransform: 'uppercase', marginBottom: '.4rem' }}>
                    Test columns detected
                  </div>
                  <div className="row" style={{ flexWrap: 'wrap', gap: '.3rem' }}>
                    {preview.testCodes.map((c) => <span key={c} className="badge badge--role">{c}</span>)}
                  </div>
                </div>

                {preview.readings > 0 && (
                  <div>
                    <div className="muted" style={{ fontSize: '.68rem', letterSpacing: '.14em', textTransform: 'uppercase', marginBottom: '.4rem' }}>
                      First {Math.min(25, preview.readings)} readings — check these landed in the right columns
                    </div>
                    <div className="table-wrap" style={{ maxHeight: 200, overflowY: 'auto' }}>
                      <table>
                        <tbody>
                          {preview.sample.map((c, i) => (
                            <tr key={i}>
                              <td className="muted" style={{ width: 50, fontSize: '.72rem' }}>r{c.rowNumber}</td>
                              <td className="mono" style={{ width: 150 }}>{c.sid}</td>
                              <td className="mono" style={{ width: 90 }}>{c.testCode}</td>
                              <td className="mono">{c.value}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </>
            )}

            <div className="modal__actions">
              <button className="btn btn--ghost" onClick={onClose} disabled={busy}>Cancel</button>
              <button className="btn btn--primary" disabled={busy || !preview || preview.readings === 0}
                      onClick={() => void apply()}>
                {busy ? 'Importing…' : preview ? `Import ${preview.readings} reading${preview.readings === 1 ? '' : 's'}` : 'Import'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="card" style={{ padding: '.6rem .8rem' }}>
      <div className="muted" style={{ fontSize: '.66rem', letterSpacing: '.14em', textTransform: 'uppercase' }}>{label}</div>
      <div style={{ fontSize: '1.15rem', fontWeight: 300, marginTop: '.15rem' }}>{value.toLocaleString('en-IN')}</div>
    </div>
  );
}
