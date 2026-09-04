import { useState } from 'react';

/**
 * Which paper the report is printed on — the one question behind every
 * report download, asked once and remembered.
 *
 * The LIS asked it as two buttons, "With Header" / "Without Header", and
 * Infinity's first cut kept that shape as a Letterhead toggle. But "without
 * header" hides a second question: WHOSE stationery? Noble's own pre-printed
 * sheets have a 26mm header band; a client's letterhead runs to 40mm. One
 * toggle could only say "no artwork, 40mm", so a report printed on Noble
 * paper started a hand's width below the printed header. Three answers:
 *
 *  letterhead  Noble's header and footer IN the PDF, for plain paper and
 *              anything sent digitally. 26/34mm margins.
 *  noble       no artwork, the same 26/34mm — pre-printed Noble stationery.
 *  plain       no artwork, 40/40mm — a client's own letterhead.
 *
 * The API and the print route both take the same key (?paper=), so what the
 * preview shows and what the PDF lays out for is one decision.
 *
 * A lab settles on one kind of paper for months at a time, so the answer is a
 * remembered preference — one localStorage key read by Worksheet, Reporting
 * and both viewers — rather than a per-download question. The PID menu is the
 * exception and offers all three per click, because one patient's report goes
 * to a portal and the next to the printer.
 */
export type Paper = 'letterhead' | 'noble' | 'plain';

export const PAPER_OPTIONS: ReadonlyArray<{ value: Paper; label: string; hint: string }> = [
  {
    value: 'letterhead',
    label: 'Digital · Noble letterhead',
    hint: "Noble's header and footer are in the PDF. For plain paper, email and WhatsApp.",
  },
  {
    value: 'noble',
    label: 'Noble pre-printed paper',
    hint: "No artwork; the report starts just under the printed header. For Noble's own stationery.",
  },
  {
    value: 'plain',
    label: 'Own letterhead · 40 mm',
    hint: "No artwork; a 40 mm band is left clear at the head and foot. For a client's own stationery.",
  },
];

export function isPaper(v: unknown): v is Paper {
  return v === 'letterhead' || v === 'noble' || v === 'plain';
}

/* Same key the Letterhead toggle used, so nobody's remembered choice is lost:
   its '1' (artwork on) and '0' (artwork off, 40mm) map onto the two modes that
   reproduce exactly what those values printed. */
const KEY = 'inf.report-letterhead';

function readStored(): Paper {
  try {
    const v = localStorage.getItem(KEY);
    if (isPaper(v)) return v;
    if (v === '0') return 'plain';
    return 'letterhead';
  } catch {
    return 'letterhead';
  }
}

export function usePaper(): [Paper, (v: Paper) => void] {
  const [paper, setPaperState] = useState<Paper>(readStored);
  const setPaper = (v: Paper) => {
    setPaperState(v);
    try { localStorage.setItem(KEY, v); } catch { /* private mode */ }
  };
  return [paper, setPaper];
}

export function PaperSelect({ value, onChange, disabled, className, ariaLabel }: {
  value: Paper;
  onChange: (v: Paper) => void;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
}) {
  const current = PAPER_OPTIONS.find((o) => o.value === value) ?? PAPER_OPTIONS[0];
  return (
    <select
      className={className ?? 'input input--sm'}
      value={value}
      disabled={disabled}
      aria-label={ariaLabel ?? 'Paper'}
      title={current.hint}
      onChange={(e) => { if (isPaper(e.target.value)) onChange(e.target.value); }}
    >
      {PAPER_OPTIONS.map((o) => (
        <option key={o.value} value={o.value} title={o.hint}>{o.label}</option>
      ))}
    </select>
  );
}
