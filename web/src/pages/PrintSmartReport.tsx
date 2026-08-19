import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api/client';
import { SmartBooklet, type SmartBookletData } from './SmartBooklet';

/**
 * The Smart Report, printed.
 *
 * Not the clinical report with friendlier words on it — a different document
 * for a different reader. The clinical report goes to a doctor and is
 * composited onto Noble's letterhead; this goes to the patient and is rendered
 * HEADLESS, with its own full-bleed cover and no page numbers. Telo makes
 * exactly the same split, for the same reason: a booklet with a cover reads
 * wrong with "Page 1 of 9" stamped across it, and self-branded pages should not
 * be pasted onto a clinical letterhead.
 *
 * The layout itself is SmartBooklet — a port of Telo's smart-report.tsx, kept
 * structurally identical. This file is only the route: fetch, gate, and tell
 * the renderer when to take the picture.
 *
 * ── WHY @page LIVES HERE ──────────────────────────────────────────────────
 * The first page is full-bleed and the rest are margined, which is a property
 * of the DOCUMENT, not of the app's stylesheet — so the rule is injected with
 * the page it belongs to and is scoped by a named page, keeping it off the
 * clinical report and the invoice.
 */

/** Page 1 bleeds; 2+ get the booklet's own margins (not the letterhead band). */
export const PAGE_RULE = `
@page smartbooklet { size: A4 portrait; margin: 13mm 12mm 15mm 12mm; }
@page smartbooklet:first { margin: 0; }
.smartbooklet { page: smartbooklet; }
@media print {
  html:has(.smartbooklet), body:has(.smartbooklet), #root:has(.smartbooklet) {
    height: auto !important;
    background: #fff !important;
  }
}
`;

export function PrintSmartReport() {
  const { sid = '' } = useParams();
  const [data, setData] = useState<SmartBookletData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    /*
     * Session only — there is deliberately no token path here.
     *
     * The clinical report has a public, token-gated route because its QR puts
     * one in a patient's hands. The booklet has no such route: it is produced
     * by the render service with the operator's own cookie forwarded, and the
     * QR printed inside it points at the clinical softcopy. Accepting a `t`
     * here would mean calling an endpoint that does not exist and answering a
     * 404 that reads like a broken report; if the booklet ever needs a public
     * copy, the route comes first.
     */
    api.get<SmartBookletData>(`/api/reports/${encodeURIComponent(sid)}/smart`)
      .then((d) => { if (live) setData(d); })
      .catch((e) => {
        if (live) {
          setError(e instanceof Error ? e.message : 'Could not load this summary.');
        }
      });
    return () => { live = false; };
  }, [sid]);

  /*
   * Ready ONLY with data in hand.
   *
   * The renderer waits on this attribute rather than on network idle, which can
   * settle while the SPA is still showing nothing. It is deliberately NOT set
   * on the error path: a failed fetch should time the render out and fail
   * loudly, not hand someone a PDF of an error message that looks like a
   * document. Nothing should reach that path anyway — the API refuses an
   * unsigned or unpurchased booklet before the renderer is ever started.
   */
  const ready = data !== null;

  return (
    <div className="smartbooklet" data-print-ready={ready ? 'true' : 'false'}>
      <style>{PAGE_RULE}</style>
      {error ? (
        <p style={{ padding: '2rem', fontSize: '10pt' }}>{error}</p>
      ) : !data ? null : (
        <SmartBooklet data={data} />
      )}
    </div>
  );
}
