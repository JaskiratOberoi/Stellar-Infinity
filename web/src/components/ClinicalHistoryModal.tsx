import { useRef, useState } from 'react';
import { api } from '../api/client';

/**
 * The clinical-history dialog and its paperclip, shared by the Reporting tab
 * and the Accessioning desk: a centre attaches history to a tube it has
 * sent, and the desk can do the same for a tube it is about to register.
 * Both talk to the same SID-keyed routes, so the LIS worksheet sees one file.
 */

export const ClipGlyph = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth="2.1" aria-hidden="true" style={{ verticalAlign: '-2px' }}>
    <path d="M21.4 11.05 12.25 20.2a6 6 0 0 1-8.49-8.49l8.57-8.57a4 4 0 1 1 5.66 5.66l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
  </svg>
);

/**
 * Attach / view / replace / remove a sample's clinical-history PDF — the port
 * of the LIS Sample Status upload, one dialog per tube. The file lands where
 * the LEGACY worksheet already looks (clihis.ashx, SID-keyed), so a tech on
 * either system opens the same document.
 *
 * Once the report is signed out the history CLOSES — the same lock the LIS
 * puts on the whole sample (WorksheetClass.CheckSampleEnable refuses 7 and 9;
 * 8 sits between them and its omission there is a gap, not a rule). What a
 * signatory signed against must not change under them, so a locked dialog
 * still VIEWS but never edits, and the server refuses regardless.
 */
export function ClinicalHistoryModal({ sid, patientName, has, locked, onClose, onChanged }: {
  /** The tube the history belongs to. */
  sid: string;
  patientName?: string | null;
  has: boolean;
  locked: boolean;
  onClose: () => void;
  onChanged: (sid: string, nowHas: boolean) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const pickerRef = useRef<HTMLInputElement>(null);

  const pick = (f: File | null) => {
    setErr(null);
    if (!f) { setFile(null); return; }
    if (!/\.pdf$/i.test(f.name)) { setErr('Only PDF files can be attached.'); setFile(null); return; }
    if (f.size > 10 * 1024 * 1024) { setErr('That PDF is larger than 10 MB.'); setFile(null); return; }
    setFile(f);
  };

  const upload = async () => {
    if (!file) return;
    setBusy(true); setErr(null);
    try {
      const b64 = await new Promise<string>((resolve, reject) => {
        const rd = new FileReader();
        rd.onerror = () => reject(new Error('The file could not be read.'));
        rd.onload = () => resolve(String(rd.result).split(',')[1] ?? '');
        rd.readAsDataURL(file);
      });
      await api.put(`/api/reports/${encodeURIComponent(sid)}/clinical-history`, { fileBase64: b64 });
      onChanged(sid, true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'The file could not be attached.');
    } finally {
      setBusy(false);
    }
  };

  const view = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await fetch(`/api/reports/${encodeURIComponent(sid)}/clinical-history`, { credentials: 'include' });
      if (!r.ok) throw new Error('The file could not be opened.');
      const blob = await r.blob();
      window.open(URL.createObjectURL(blob), '_blank', 'noopener');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'The file could not be opened.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true); setErr(null);
    try {
      await api.delete(`/api/reports/${encodeURIComponent(sid)}/clinical-history`);
      onChanged(sid, false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'The file could not be removed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <h2 className="modal__title">Clinical history</h2>
        <p className="muted" style={{ fontSize: '.82rem', marginTop: '.2rem' }}>
          Sample <b className="mono">{sid}</b>
          {patientName ? <> · {patientName}</> : null}
        </p>
        <p className="muted" style={{ fontSize: '.8rem', lineHeight: 1.6, marginTop: '.6rem' }}>
          {locked
            ? has
              ? 'The report is authorised, so the clinical history is closed — it can still be viewed, exactly as it was signed against.'
              : 'The report is authorised, so the clinical history is closed — no attachment can be added now.'
            : has
              ? 'A clinical history PDF is attached — the lab opens it from the worksheet. Uploading another replaces it.'
              : 'Attach a PDF — referral notes, prescriptions, prior reports — and the lab sees it on the worksheet for this sample.'}
        </p>

        {!locked && (
          <>
            {/* A drop target that is also the browse button — one surface,
                either gesture. The native input stays for the picker dialog
                and the keyboard, visually replaced rather than removed. */}
            <div
              className={`filedrop${dragOver ? ' filedrop--over' : ''}${file ? ' filedrop--has' : ''}`}
              role="button"
              tabIndex={0}
              aria-label="Choose or drop a clinical history PDF"
              onClick={() => pickerRef.current?.click()}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickerRef.current?.click(); } }}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                pick(e.dataTransfer.files?.[0] ?? null);
              }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"
                   aria-hidden="true" className="filedrop__icon">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <path d="M14 2v6h6" />
                <path d="M12 18v-6" />
                <path d="m9 15 3 3 3-3" transform="rotate(180 12 15.5)" />
              </svg>
              {file ? (
                <>
                  <b className="filedrop__name">{file.name}</b>
                  <span className="muted">{(file.size / 1024 / 1024).toFixed(file.size > 1024 * 1024 ? 1 : 2)} MB
                    {' · '}click to choose a different file</span>
                </>
              ) : (
                <>
                  <b>Drop a PDF here</b>
                  <span className="muted">or click to browse · up to 10 MB</span>
                </>
              )}
              <input ref={pickerRef} type="file" accept="application/pdf,.pdf" hidden
                     aria-hidden="true" tabIndex={-1}
                     onChange={(e) => { pick(e.target.files?.[0] ?? null); e.target.value = ''; }} />
            </div>
          </>
        )}

        {err && <p style={{ color: 'var(--danger)', fontSize: '.8rem', marginTop: '.5rem' }}>{err}</p>}

        <div className="modal__actions">
          {has && (
            <button className="btn btn--ghost" disabled={busy} onClick={() => void view()}>
              View current
            </button>
          )}
          {has && !locked && (
            <button className="btn btn--ghost" disabled={busy} style={{ color: 'var(--danger)' }}
                    onClick={() => void remove()}>
              Remove
            </button>
          )}
          <button className="btn btn--ghost" disabled={busy} onClick={onClose}>
            {locked ? 'Close' : 'Cancel'}
          </button>
          {!locked && (
            <button className="btn btn--primary" disabled={busy || !file} onClick={() => void upload()}>
              {busy ? 'Working…' : has ? 'Replace' : 'Attach'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
