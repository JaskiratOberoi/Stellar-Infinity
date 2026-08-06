import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { plainText } from '../lib/format';

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
 */
export function TestList({ names }: { names: string | null | undefined }) {
  const text = useMemo(() => plainText(names), [names]);
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
