import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * The PID download control: the number, the download glyph, and — on click —
 * a two-line menu asking the one question the LIS asks with its "With Header"
 * / "Without Header" buttons. The choice is per download, made at the moment
 * it matters, because one patient's report goes to a portal (needs the
 * artwork in the PDF) and the next is printed on pre-printed stationery
 * (must not print it twice). A single page-level switch kept answering
 * yesterday's question.
 *
 * The menu is PORTALLED and fixed-positioned: the button lives inside
 * .table-wrap, whose overflow-x:auto makes it a clipping context — an
 * absolutely-positioned panel would be sheared off at the table's edge for
 * the bottom rows. Fixed coordinates are taken from the button at the moment
 * of opening, and any scroll closes the menu rather than letting it drift
 * away from its row.
 */
export function PidReportButton({ pid, busy, disabled, title, count, onDownload }: {
  pid: number;
  /** THIS patient's download is being prepared. */
  busy: boolean;
  /** Some download is in flight — every control waits its turn. */
  disabled: boolean;
  title: string;
  /** Sample count suffix (×N) when the patient has several on this page. */
  count?: number;
  onDownload: (letterhead: boolean) => void;
}) {
  const [at, setAt] = useState<{ x: number; y: number; up: boolean } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLSpanElement>(null);

  const close = () => setAt(null);

  const toggle = () => {
    if (at) { close(); return; }
    const r = btnRef.current!.getBoundingClientRect();
    // Two rows of menu need ~90px; open upward when the row sits lower.
    const up = window.innerHeight - r.bottom < 110;
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

  const pick = (letterhead: boolean) => { close(); onDownload(letterhead); };

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
          <button type="button" role="menuitem" onClick={() => pick(true)}
                  title="The PDF carries the letterhead artwork — for plain paper and digital copies.">
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <rect x="3" y="2" width="10" height="12" rx="1.2" fill="none"
                    stroke="currentColor" strokeWidth="1.3" />
              <path d="M3.7 4.6h8.6" stroke="currentColor" strokeWidth="2.2" />
              <path d="M5.5 8h5M5.5 10.5h3.5" stroke="currentColor" strokeWidth="1.1"
                    strokeLinecap="round" />
            </svg>
            With letterhead
          </button>
          <button type="button" role="menuitem" onClick={() => pick(false)}
                  title="No artwork — for pre-printed stationery that already has the header.">
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <rect x="3" y="2" width="10" height="12" rx="1.2" fill="none"
                    stroke="currentColor" strokeWidth="1.3" />
              <path d="M5.5 8h5M5.5 10.5h3.5" stroke="currentColor" strokeWidth="1.1"
                    strokeLinecap="round" />
            </svg>
            Plain paper
          </button>
        </span>,
        document.body,
      )}
    </>
  );
}
