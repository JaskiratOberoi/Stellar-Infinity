import { useState } from 'react';

/**
 * Which FORMAT the report is drawn in — the typography, not the paper.
 *
 *  v1  the format every report has been issued in: Helvetica, mixed case.
 *  v2  the same layout set in a serif face with the tabular text in
 *      capitals, so the sheet reads larger without a size change. Asked for
 *      on 2026-09-12 for side-by-side testing.
 *  v3  v2 exactly, in Playfair Display instead of Georgia. Asked for on
 *      2026-09-19. The Smart Report has no v3 of its own: it treats v3 as v2.
 *
 * Carried the same way as the paper: `?format=` on the print route, `format`
 * on the PDF routes, remembered per desk in localStorage. Nothing about the
 * content, the pagination rules or the paper changes with it — see the
 * `.lr--v2` and `.lr--v3` rules in report.css for exactly what does.
 */
export type ReportFormat = 'v1' | 'v2' | 'v3';

export const FORMAT_OPTIONS: ReadonlyArray<{ value: ReportFormat; label: string; hint: string }> = [
  { value: 'v1', label: 'Format v1', hint: 'The standard report: Helvetica, mixed case.' },
  { value: 'v2', label: 'Format v2', hint: 'Serif face (Georgia), tabular text in capitals. Under test.' },
  { value: 'v3', label: 'Format v3', hint: 'As v2, set in Playfair Display. Under test.' },
];

export function isReportFormat(v: unknown): v is ReportFormat {
  return v === 'v1' || v === 'v2' || v === 'v3';
}

const KEY = 'inf.report-format';

export function readStoredFormat(): ReportFormat {
  try {
    const v = localStorage.getItem(KEY);
    return isReportFormat(v) ? v : 'v1';
  } catch {
    return 'v1';
  }
}

export function useReportFormat(): [ReportFormat, (v: ReportFormat) => void] {
  const [format, setFormatState] = useState<ReportFormat>(readStoredFormat);
  const setFormat = (v: ReportFormat) => {
    setFormatState(v);
    try { localStorage.setItem(KEY, v); } catch { /* private mode */ }
  };
  return [format, setFormat];
}

export function FormatSelect({ value, onChange, disabled, className, ariaLabel }: {
  value: ReportFormat;
  onChange: (v: ReportFormat) => void;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
}) {
  const current = FORMAT_OPTIONS.find((o) => o.value === value) ?? FORMAT_OPTIONS[0];
  return (
    <select
      className={className ?? 'input input--sm'}
      value={value}
      disabled={disabled}
      aria-label={ariaLabel ?? 'Report format'}
      title={current.hint}
      onChange={(e) => { if (isReportFormat(e.target.value)) onChange(e.target.value); }}
    >
      {FORMAT_OPTIONS.map((o) => (
        <option key={o.value} value={o.value} title={o.hint}>{o.label}</option>
      ))}
    </select>
  );
}
