import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { plainText, withoutPackageTag } from '../lib/format';

/**
 * The CSV's separator, once plainText has been through it, is a comma followed
 * by a space. A comma with no space after it is INSIDE a name — "1,25
 * Dihydroxy Vitamin D" is one analyte, not two.
 */
const countTests = (s: string) => (s ? s.split(/,\s/).length : 0);

/**
 * A sample's test list: clipped to one line in a table, four lines on a card,
 * and openable from there.
 *
 * Printing the whole list is the point of the card — a truncated list is the
 * reason someone opens a sample just to find out what is on it. But an
 * antenatal profile is twenty tests and a dozen lines, and fifty of those to
 * scroll past turns the worklist back into the chore the card was meant to fix.
 * So it stops at four lines and says how many tests it is holding.
 *
 * The toggle appears only when the text genuinely overflows, and that is
 * MEASURED rather than guessed from a character count: whether four lines is
 * enough depends on the face, the phone's width and how long the lab's test
 * names are. On a wide screen the cell is one clipped line with the full string
 * on its title attribute, the measurement reports no vertical overflow, and no
 * button is rendered at all.
 *
 * `packages` is the package (the LIS's "master profile" — ROHTAK HR203A,
 * GENOMIC 20) the tube was booked under, named on its own line above the
 * list. The legacy worklist showed it as a bold "[ROHTAK HR203A]" tacked onto
 * the CSV, but only on some of a package's tubes; the server now reads it from
 * the order line instead, and that tag is dropped from the text so the name is
 * not printed twice. Where the server sends no package the CSV is shown as-is,
 * tag and all, so nothing that was visible before goes missing.
 */
export function TestList({ names, packages }: { names: string | null | undefined; packages?: string | null }) {
  const pkg = packages?.trim() || null;
  const text = useMemo(() => plainText(pkg ? withoutPackageTag(names) : names), [names, pkg]);
  const count = useMemo(() => countTests(text), [text]);

  const ref = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [clipped, setClipped] = useState(false);

  const measure = useCallback(() => {
    const el = ref.current;
    // Expanded, scrollHeight equals clientHeight by definition, so measuring
    // would report "nothing hidden" and take the way back with it.
    if (!el || open) return;
    setClipped(el.scrollHeight > el.clientHeight + 1);
  }, [open]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    measure();
    // Catches the breakpoint crossing and a rotation — both resize the cell
    // without changing a character of its text.
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure, text]);

  return (
    <div className="clamp">
      {pkg && (
        <div className="testlist__pkg" title={`Package: ${pkg}`}>
          <span className="testlist__pkg-label">Package</span>
          <span className="testlist__pkg-name">{pkg}</span>
        </div>
      )}
      <div
        ref={ref}
        className={`cell__clip${open ? ' cell__clip--open' : ''}`}
        title={text}
      >
        {text || '—'}
      </div>

      {(clipped || open) && (
        <button
          type="button"
          className="clamp__more"
          aria-expanded={open}
          // The card underneath opens the sample. Reading the rest of the list
          // is not a request to do that.
          onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        >
          {open ? 'Show fewer' : `Show all ${count} test${count === 1 ? '' : 's'}`}
        </button>
      )}
    </div>
  );
}
