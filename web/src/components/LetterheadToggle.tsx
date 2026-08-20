import { useState } from 'react';

/**
 * With or without the letterhead artwork, remembered across pages and visits.
 *
 * The LIS asks the same question as two buttons on its report screen —
 * "With Header" / "Without Header" — because a lab prints on two kinds of
 * paper: plain (the PDF must carry the artwork) and pre-printed stationery
 * (the artwork is already on the sheet, and printing it again doubles it).
 * A lab settles on one kind of paper for months at a time, so this is a
 * remembered preference rather than a per-download question.
 *
 * One localStorage key, read by Worksheet and Reporting both, so the answer
 * given on either page is the answer everywhere.
 */
const KEY = 'inf.report-letterhead';

export function useLetterhead(): [boolean, (v: boolean) => void] {
  const [on, setOn] = useState(() => {
    try { return localStorage.getItem(KEY) !== '0'; } catch { return true; }
  });
  const set = (v: boolean) => {
    setOn(v);
    try { localStorage.setItem(KEY, v ? '1' : '0'); } catch { /* private mode */ }
  };
  return [on, set];
}

export function LetterheadToggle({ value, onChange, disabled }: {
  value: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="row" style={{ gap: '.4rem', fontSize: '.8rem', cursor: 'pointer', whiteSpace: 'nowrap' }}
           title="Report downloads carry the letterhead artwork. Untick when printing on pre-printed stationery — the paper already has the header, and the PDF arrives plain.">
      <input type="checkbox" checked={value} disabled={disabled}
             onChange={(e) => onChange(e.target.checked)} />
      Letterhead
    </label>
  );
}
