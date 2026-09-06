import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { PAPER_OPTIONS, type Paper } from './PaperSelect';

/**
 * The PID download control: the number, the download glyph, and — on click —
 * a menu asking which paper the report is going onto: Noble's letterhead in
 * the PDF, Noble's pre-printed stationery, or the client's own 40mm sheet
 * (see PaperSelect). The choice is per download, made at the moment it
 * matters, because one patient's report goes to a portal (needs the artwork
 * in the PDF) and the next is printed on pre-printed stationery (must not
 * print it twice). A single page-level switch kept answering yesterday's
 * question.
 *
 * The menu is PORTALLED and fixed-positioned: the button lives inside
 * .table-wrap, whose overflow-x:auto makes it a clipping context — an
 * absolutely-positioned panel would be sheared off at the table's edge for
 * the bottom rows. Fixed coordinates are taken from the button at the moment
 * of opening, and any scroll closes the menu rather than letting it drift
 * away from its row.
 */
export function PidReportButton({ pid, busy, disabled, title, count, onDownload, onPreview, override }: {
  pid: number;
  /** THIS patient's download is being prepared. */
  busy: boolean;
  /** Some download is in flight — every control waits its turn. */
  disabled: boolean;
  title: string;
  /** Sample count suffix (×N) when the patient has several on this page. */
  count?: number;
  /** `includeHeld` is the Super Admin's tick below — true only when the
   *  override row was offered and ticked. */
  onDownload: (paper: Paper, includeHeld: boolean) => void;
  /** Open the complete report to review and untick tests before downloading. */
  onPreview?: () => void;
  /**
   * The Super Admin's balance-hold override. Given, the menu carries a tick
   * to include the patient's held reports in the download; the count names
   * how many, where the page knows. Offered to that role only — the caller
   * decides — and honoured by the server for that role only.
   */
  override?: { count?: number };
}) {
  const [at, setAt] = useState<{ x: number; y: number; up: boolean } | null>(null);
  // Off on every opening: releasing a held report is a decision taken each
  // time, not a setting that lingers from the last patient.
  const [includeHeld, setIncludeHeld] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLSpanElement>(null);

  const close = () => setAt(null);

  const toggle = () => {
    if (at) { close(); return; }
    const r = btnRef.current!.getBoundingClientRect();
    // Four rows of menu need ~170px (five with the override); open upward
    // when the row sits lower.
    const up = window.innerHeight - r.bottom < (override ? 230 : 190);
    setIncludeHeld(false);
    setAt({ x: r.left, y: up ? r.top : r.bottom, up });
  };

  useEffect(() => {
    if (!at) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!panelRef.current?.contains(t) && !btnRef.current?.contains(t)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { close(); btnRef.current?.focus(); }
    };
    // Capture-phase: the scroll that matters is .table-wrap's, which never
    // bubbles to the document as a plain scroll event.
    const onScroll = () => close();
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [at]);

  const pick = (paper: Paper) => { close(); onDownload(paper, !!override && includeHeld); };

  return (
    <>
      <button
        type="button"
        ref={btnRef}
        className="pidlink"
        disabled={disabled}
        title={title}
        aria-haspopup="menu"
        aria-expanded={at !== null}
        onClick={toggle}
      >
        {busy ? (
          <span className="muted">Preparing…</span>
        ) : (
          <>
            <b>{pid}</b>
            <svg className="pidlink__dl" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M8 2v8m0 0 3-3m-3 3L5 7M3 13h10" fill="none"
                    stroke="currentColor" strokeWidth="1.6"
                    strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {count != null && count > 1 && (
              <span className="pidlink__n">×{count}</span>
            )}
          </>
        )}
      </button>

      {at && createPortal(
        <span
          ref={panelRef}
          className="pidmenu"
          role="menu"
          aria-label={`Download report for patient ${pid}`}
          style={at.up
            ? { left: at.x, bottom: window.innerHeight - at.y + 4 }
            : { left: at.x, top: at.y + 4 }}
        >
          {onPreview && (
            <button type="button" role="menuitem" onClick={() => { close(); onPreview(); }}
                    title="Open the complete report on screen — review each sample and untick anything that should stay out of the PDF.">
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M1.8 8s2.3-4.2 6.2-4.2S14.2 8 14.2 8s-2.3 4.2-6.2 4.2S1.8 8 1.8 8Z"
                      fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
                <circle cx="8" cy="8" r="1.9" fill="none" stroke="currentColor" strokeWidth="1.3" />
              </svg>
              Review &amp; edit…
            </button>
          )}
          {/* One row per paper, in PaperSelect's order. The glyph says what
              the sheet looks like: a filled band for artwork in the PDF, a
              dashed band for Noble's pre-printed header, a taller dashed band
              for the client's own 40mm stationery. */}
          {PAPER_OPTIONS.map((o) => (
            <button key={o.value} type="button" role="menuitem" onClick={() => pick(o.value)}
                    title={`Download now. ${o.hint}`}>
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <rect x="3" y="2" width="10" height="12" rx="1.2" fill="none"
                      stroke="currentColor" strokeWidth="1.3" />
                {o.value === 'letterhead' && (
                  <path d="M3.7 4.6h8.6" stroke="currentColor" strokeWidth="2.2" />
                )}
                {o.value === 'noble' && (
                  <path d="M3.7 4.6h8.6" stroke="currentColor" strokeWidth="1.1"
                        strokeDasharray="1.4 1.1" />
                )}
                {o.value === 'plain' && (
                  <path d="M3.7 5.4h8.6" stroke="currentColor" strokeWidth="2.6"
                        strokeDasharray="1.4 1.1" />
                )}
                <path d="M5.5 8.6h5M5.5 11h3.5" stroke="currentColor" strokeWidth="1.1"
                      strokeLinecap="round" />
              </svg>
              {o.label}
            </button>
          ))}
          {/* Super Admin only: include the patient's balance-held reports.
              A tick, not a fourth set of paper rows — the paper is still
              chosen above; this only widens what goes onto it. The download
              is written to the audit trail with what was owed. */}
          {override && (
            <label className="pidmenu__override"
                   title="Super Admin: include reports on hold for an outstanding balance. Each one released is recorded in the audit trail.">
              <input
                type="checkbox"
                checked={includeHeld}
                onChange={(e) => setIncludeHeld(e.target.checked)}
              />
              <span>
                {override.count != null
                  ? `Include ${override.count} held report${override.count === 1 ? '' : 's'}`
                  : 'Include held reports'}
                <small>Super Admin override</small>
              </span>
            </label>
          )}
        </span>,
        document.body,
      )}
    </>
  );
}
