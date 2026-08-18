import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api/client';
import { downloadFile } from '../lib/format';
import type { WorksheetRow } from './Reports';

export interface TestResult {
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
  /**
   * The catalogue's display name, for a row that carries none of its own. It is
   * the TEST's name, shared by every row under that test — see nameOf() in
   * PrintReport.tsx before printing it.
   */
  reportTestName: string | null;
  /** How it was measured — CLIA, ELISA. A printed report names its method. */
  method: string | null;
  /** Clinical significance from the catalogue, printed under the test. */
  interpretation: string | null;
  /** The profile this row belongs to. Null on roughly a sixth of the rows. */
  profileId: number | null;
  /** The tube it came from, e.g. "WB - EDTA". */
  specimen: string | null;
  /**
   * The catalogue row this result was measured against.
   *
   * Not display data — it is what the report's structure is rebuilt from. A
   * multi-parameter test emits an untitled "report name" Head immediately
   * before the real coded Head its Param rows hang off, and the only thing
   * saying those two rows are one test is this id. See buildSampleReport().
   */
  testId: number | null;
  /**
   * An interpretation held as a picture — the HBV and HCV graphs — inlined by
   * the API as a data URI. Some tests carry ONLY this and no text.
   */
  interpretationImage: string | null;
}

/** Where the sample was taken — the centre a patient rings, not the lab. */
export interface CollectionCentre {
  code: string;
  name: string | null;
  address: string | null;
  city: string | null;
  phone: string | null;
  email: string | null;
}

/** The lab that processed it. */
export interface ProcessingUnit {
  id: number;
  name: string | null;
  address: string | null;
  city: string | null;
  phone: string | null;
}

export interface ReportSigner {
  id: number;
  doctorName: string | null;
  designation: string | null;
  docType: number;
  /** The signature image, inlined so the renderer never waits on a second fetch. */
  signatureDataUrl: string | null;
}

/**
 * Everything the print route draws.
 *
 * The extras ride on the same response as the results rather than sitting
 * behind a second call, because the only page that needs them is being
 * photographed by a headless browser — see GetReport's remarks.
 */
export type FullRow = WorksheetRow & {
  results: TestResult[];
  refDoctor: string | null;
  refCustomer: string | null;
  passportNo: string | null;
  /** Date of birth as ISO 'YYYY-MM-DD', from Infinity's sidecar; null when the
   *  order predates DOB capture. */
  dob: string | null;
  collectedAt: CollectionCentre | null;
  processedAt: ProcessingUnit | null;
  signers: ReportSigner[];
  /** profile id → clinical significance, from Telo's shared sidecar table. */
  profileInterpretations: Record<number, string>;
  /** QR PNG data URI for the patient's copy; null when the link is not configured. */
  qr: string | null;
};

/**
 * Preview one report, then download it.
 *
 * ── WHAT CHANGED, AND WHY IT MATTERED ─────────────────────────────────────
 * This modal used to render its own summary table from the report data: a
 * second layout, built from the same numbers, that nobody printed. It could
 * disagree with the PDF and did — no pagination, no letterhead band, no idea
 * how much would land on a sheet — so "preview" meant "a different view of the
 * same rows" rather than "what you are about to send to a doctor".
 *
 * It now loads the print route in an iframe. That route IS the PDF, so the
 * preview and the download cannot drift: one layout, photographed by Chromium
 * for the download and displayed here for approval. Telo reached the same
 * arrangement for the same reason.
 *
 * The iframe URL is frozen at mount. Letterhead and layout are pushed into the
 * loaded frame by postMessage and applied client-side, because changing the URL
 * would remount the iframe, re-boot the SPA and re-fetch the report just to
 * move a page break — seconds of blank white for a toggle.
 */
export function ReportViewer({
  sid, patientName, onClose, onSmart,
}: {
  sid: string;
  /** For the window title only; the report draws its own header. */
  patientName?: string | null;
  onClose: () => void;
  /** Opens the patient-facing Smart Report. Omitted where it is not offered. */
  onSmart?: (sid: string) => void;
}) {
  /*
   * Headless is the DEFAULT, and the toggle below reads the other way round.
   *
   * Noble prints onto pre-printed letterhead paper, so the normal download must
   * NOT carry a second letterhead of its own — it would print on top of the
   * one already on the sheet. Turning "Letterhead" on adds Noble's header and
   * footer, for the times the report is emailed or printed on plain paper.
   * Telo defaults the same way.
   */
  const [headless, setHeadless] = useState(true);
  // One department per sheet. Telo defaults this on: a doctor reading a
  // haematology report should not have to find where biochemistry ended.
  const [split, setSplit] = useState(true);

  const [previewSrc] = useState(
    () => `/print/report/${encodeURIComponent(sid)}?split=1&headless=1`,
  );
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [frameLoading, setFrameLoading] = useState(true);

  const [graphCount, setGraphCount] = useState(0);
  const [includeGraph, setIncludeGraph] = useState(true);
  /*
   * True until the attachment probe answers.
   *
   * The toolbar has to be drawn before the answer arrives, and a control that
   * appears half a second later moves everything beside it — so the switch is
   * rendered from the first frame and only its label settles. It also stops
   * "no attachment" being asserted during the moment we do not yet know.
   */
  const [graphProbing, setGraphProbing] = useState(true);
  const hasGraph = graphCount > 0;
  const [busy, setBusy] = useState<'pdf' | 'graph' | null>(null);
  const [error, setError] = useState<string | null>(null);

  // What the operator unticked inside the frame, and how much is left. The
  // counts are what block a download of nothing.
  const [excluded, setExcluded] = useState<number[]>([]);
  const [counts, setCounts] = useState({ total: 0, remaining: 0 });
  const nothingSelected = counts.total > 0 && counts.remaining === 0;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    // The report scrolls inside the frame; the page behind it must not scroll too.
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  // Push display options in. Runs on every toggle and once the frame is up,
  // which covers a toggle flipped while it was still loading.
  useEffect(() => {
    if (frameLoading) return;
    iframeRef.current?.contentWindow?.postMessage(
      { type: 'infinity:report-display', sid, split, headless },
      window.location.origin,
    );
  }, [frameLoading, split, headless, sid]);

  // Take the selection back out. Same-origin only — a report is patient data
  // and this listener must not accept a count, or anything else, from elsewhere.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return;
      const d = e.data;
      if (!d || d.type !== 'infinity:report-selection' || d.sid !== sid) return;
      if (Array.isArray(d.excluded)) {
        setExcluded(d.excluded.filter((n: unknown): n is number => typeof n === 'number'));
      }
      if (typeof d.total === 'number' && typeof d.remaining === 'number') {
        setCounts({ total: d.total, remaining: d.remaining });
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [sid]);

  // Is there a graph to offer? Metadata only — this must not drag a
  // multi-megabyte attachment across just to decide whether to draw a button.
  useEffect(() => {
    let live = true;
    api.get<{ count: number }>(`/api/reports/${encodeURIComponent(sid)}/graph?meta=true`)
      .then((g) => { if (live) setGraphCount(g.count); })
      .catch(() => { /* No graph, or locked. Either way: nothing to staple. */ })
      .finally(() => { if (live) setGraphProbing(false); });
    return () => { live = false; };
  }, [sid]);

  const download = useCallback(async (what: 'pdf' | 'graph') => {
    if (what === 'pdf' && nothingSelected) {
      setError('Tick at least one test to include in the PDF.');
      return;
    }
    setBusy(what);
    setError(null);
    try {
      const base = `/api/reports/${encodeURIComponent(sid)}`;
      if (what === 'graph') {
        await downloadFile(`${base}/graph`);
      } else {
        const q = new URLSearchParams();
        // withGraph: the LIS staples the graph to the printed report, so
        // Infinity's PDF is the same document unless it is turned off.
        q.set('withGraph', String(hasGraph && includeGraph));
        q.set('headless', String(headless));
        q.set('split', String(split));
        if (excluded.length) q.set('exclude', excluded.join(','));
        await downloadFile(`${base}/pdf?${q}`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The download failed.');
    } finally {
      setBusy(null);
    }
  }, [sid, nothingSelected, hasGraph, includeGraph, headless, split, excluded]);

  return createPortal(
    <div className="modal-backdrop preview-backdrop" onClick={onClose}>
      <div className="preview" onClick={(e) => e.stopPropagation()}
           role="dialog" aria-modal="true" aria-label={`Report ${sid}`}>

        <div className="preview__bar">
          <div className="preview__who">
            <p className="preview__name">
              {patientName || 'Report'} <span className="mono muted">· {sid}</span>
            </p>
            {error && <p className="preview__err">{error}</p>}
            {!error && counts.total > 0 && counts.remaining < counts.total && (
              <p className="muted" style={{ fontSize: '.72rem' }}>
                {counts.remaining} of {counts.total} tests included
              </p>
            )}
          </div>

          <div className="preview__tools">
            {/* Off by default: Noble prints onto pre-printed letterhead, so a
                second one would land on top of it. */}
            <label className="preview__switch"
                   title="On: include Noble's header and footer, for plain paper or email. Off (default): the same margins with no header or footer, for printing onto pre-printed letterhead.">
              <input type="checkbox" checked={!headless}
                     onChange={(e) => setHeadless(!e.target.checked)} />
              <span className="preview__track" aria-hidden="true" />
              Letterhead
            </label>

            <select className="input input--sm preview__layout" value={split ? 'split' : 'continuous'}
                    aria-label="Report layout"
                    onChange={(e) => setSplit(e.target.value === 'split')}>
              <option value="continuous">Continuous</option>
              <option value="split">Split by department</option>
            </select>

            {/* Saves the attachment on its own, for the times it is the only
                thing being sent on. Only when there is one — a button that
                downloads nothing is not worth the width. */}
            {hasGraph && (
              <button className="btn btn--ghost btn--sm" disabled={busy !== null}
                      onClick={() => void download('graph')}
                      title="Download the attachment on its own, without the report">
                {busy === 'graph' ? 'Fetching…' : `Graph${graphCount > 1 ? ` (${graphCount})` : ''}`}
              </button>
            )}

            {/* The switch lives inside the download button so it reads as what
                this download will contain rather than as a setting beside it.
                It stays visible with no attachment, dimmed: vanishing, it said
                "no such option" where the operator needed to be told "this
                report has nothing stapled to it". */}
            <div className="preview__dl">
              <label className={`preview__dlopt${hasGraph ? '' : ' preview__dlopt--none'}`}
                     title={hasGraph
                       ? 'On: staple the attachment after the report, as one merged file — the document the LIS prints. Off: the report alone.'
                       : 'This report has no attachment. Graphs are stapled to the reports that carry one, such as Double and Quadruple Marker.'}>
                <input type="checkbox" checked={hasGraph && includeGraph}
                       disabled={!hasGraph || busy !== null}
                       onChange={(e) => setIncludeGraph(e.target.checked)} />
                <span className="preview__track preview__track--on" aria-hidden="true" />
                {/* "Graph", not "Attachment": it is what the LIS and Telo both
                    call this, so it is the word the operator already knows —
                    and it is two-thirds the width, which is what keeps the
                    toolbar on one line on a smaller screen. */}
                {graphProbing ? 'Graph…' : '+ Graph'}
              </label>
              <button className="btn btn--primary btn--sm" disabled={busy !== null || nothingSelected}
                      title={nothingSelected ? 'Tick at least one test to download' : undefined}
                      onClick={() => void download('pdf')}>
                {busy === 'pdf' ? 'Preparing…' : 'Download PDF'}
              </button>
            </div>

            {onSmart && (
              <button className="btn btn--ghost btn--sm" onClick={() => onSmart(sid)}
                      title="The patient-facing Smart Report">
                Smart Report
              </button>
            )}

            <button className="btn btn--ghost btn--sm" onClick={onClose} aria-label="Close preview">✕</button>
          </div>
        </div>

        <div className="preview__stage">
          {frameLoading && (
            <div className="preview__loading">
              <span className="preview__spin" aria-hidden="true" />
              Preparing report…
            </div>
          )}
          <iframe
            ref={iframeRef}
            title={`Report ${sid}`}
            src={previewSrc}
            onLoad={() => setFrameLoading(false)}
            className="preview__frame"
            style={{ opacity: frameLoading ? 0 : 1 }}
          />
        </div>
      </div>
    </div>,
    document.body,
  );
}
