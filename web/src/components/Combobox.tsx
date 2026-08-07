import { useEffect, useId, useMemo, useRef, useState } from 'react';

/**
 * A select you can type into.
 *
 * The client-code list is several hundred centres. A native <select> there is
 * a scroll: you cannot type "MEHAR" to find AG0050A, and on a phone it is an
 * unindexed wheel. This filters as you type, on the code AND the name, because
 * an operator knows one or the other and rarely both.
 *
 * Written rather than installed. The project's runtime dependencies are React
 * and the router, and a combobox is the one widget where a library earns its
 * weight through ARIA rather than layout — which is exactly the part that is
 * cheap to get right and expensive to get wrong. The wiring below follows the
 * APG combobox pattern: the input owns the query and announces the active
 * option, the list is a listbox, and the active option is referenced by id
 * rather than focused, so focus never leaves the input and typing never breaks.
 *
 * `datalist` was the obvious alternative and is not good enough: it cannot show
 * a code and a name as separate columns, its filtering is prefix-only in some
 * browsers and substring in others, and it is unstyleable.
 */

export interface ComboOption {
  value: string;
  label: string;
  /** Shown dimmed after the label — a centre's name beside its code. */
  hint?: string | null;
}

/**
 * The rendered list is capped. Several hundred <li> elements is a real cost on
 * a mid-range phone for a list nobody reads past the first screen of, and the
 * answer to "my option is not here" is to type, which is the point of the
 * control.
 */
const MAX_RENDERED = 60;

/** Case-insensitive substring, matched against the label and the value. */
function matches(o: ComboOption, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  return o.label.toLowerCase().includes(needle)
      || o.value.toLowerCase().includes(needle)
      || (o.hint ?? '').toLowerCase().includes(needle);
}

/** The matched run, so the eye lands on why a row is in the list. */
function Highlight({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const at = text.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark className="combo__mark">{text.slice(at, at + query.length)}</mark>
      {text.slice(at + query.length)}
    </>
  );
}

export function Combobox({
  value, options, emptyLabel, placeholder, onChange, inputClassName,
}: {
  value: string;
  options: ComboOption[];
  /** The "no filter" row, always first and always offered. */
  emptyLabel: string;
  placeholder?: string;
  onChange: (value: string) => void;
  inputClassName?: string;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);

  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const selected = options.find((o) => o.value === value) ?? null;

  // The empty row is an option like any other, so one code path selects and one
  // set of keys navigates — a separate "clear" button would be a second way to
  // do the same thing with its own keyboard story.
  const all = useMemo<ComboOption[]>(
    () => [{ value: '', label: emptyLabel }, ...options],
    [options, emptyLabel],
  );

  const filtered = useMemo(() => {
    const hits = all.filter((o) => matches(o, query));
    return { shown: hits.slice(0, MAX_RENDERED), total: hits.length };
  }, [all, query]);

  // A filter that shrinks under the cursor must not leave the cursor past the
  // end of the list.
  useEffect(() => { setActive(0); }, [query]);

  // Pointer-down, not click: a click that starts inside and ends outside should
  // not close, and mousedown fires before the input's blur.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  // Keep the active row in view when arrowing past the fold. Focus stays on the
  // input throughout, so nothing here can steal it.
  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')
      ?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  const commit = (o: ComboOption) => {
    onChange(o.value);
    setQuery('');
    setOpen(false);
    inputRef.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) { setOpen(true); return; }
      const last = filtered.shown.length - 1;
      setActive((i) => e.key === 'ArrowDown'
        ? (i >= last ? 0 : i + 1)
        : (i <= 0 ? last : i - 1));
      return;
    }
    if (e.key === 'Enter') {
      if (open && filtered.shown[active]) { e.preventDefault(); commit(filtered.shown[active]); }
      return;
    }
    if (e.key === 'Escape') {
      if (open) { e.preventDefault(); setOpen(false); setQuery(''); }
      return;
    }
    if (e.key === 'Home' && open) { e.preventDefault(); setActive(0); return; }
    if (e.key === 'End' && open) { e.preventDefault(); setActive(filtered.shown.length - 1); return; }
    // Tab leaves the field; the list must not stay open behind the next one.
    if (e.key === 'Tab') setOpen(false);
  };

  return (
    <div className="combo" ref={rootRef}>
      <input
        ref={inputRef}
        // `combobox` with aria-expanded and aria-controls — the input is the
        // widget, the list is what it controls.
        role="combobox"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        aria-autocomplete="list"
        aria-activedescendant={open && filtered.shown[active] ? `${id}-opt-${active}` : undefined}
        className={inputClassName ?? 'input'}
        // Closed, it reads as the current selection. Open, it is a search box
        // whose placeholder still says what is selected, so typing never costs
        // you the context of what you are replacing.
        value={open ? query : (selected?.label ?? '')}
        placeholder={open ? (selected?.label ?? placeholder ?? emptyLabel) : (placeholder ?? emptyLabel)}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
        onFocus={() => { setQuery(''); setOpen(true); }}
        onKeyDown={onKeyDown}
        autoComplete="off"
        spellCheck={false}
      />

      {/* Purely decorative: the input already announces its state. */}
      <svg className="combo__caret" viewBox="0 0 24 24" aria-hidden="true" fill="none"
           stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="m6 9 6 6 6-6" />
      </svg>

      {open && (
        <ul className="combo__list" id={`${id}-list`} role="listbox" ref={listRef}>
          {filtered.shown.map((o, i) => (
            <li
              key={o.value || '__any'}
              id={`${id}-opt-${i}`}
              role="option"
              aria-selected={o.value === value}
              data-active={i === active}
              className={`combo__opt${o.value === value ? ' combo__opt--on' : ''}${o.value === '' ? ' combo__opt--any' : ''}`}
              // pointerdown, not click: click lands after blur, by which point
              // the list has already gone.
              onPointerDown={(e) => { e.preventDefault(); commit(o); }}
              onPointerEnter={() => setActive(i)}
            >
              <span className="combo__label"><Highlight text={o.label} query={query} /></span>
              {o.hint && <span className="combo__hint"><Highlight text={o.hint} query={query} /></span>}
            </li>
          ))}

          {filtered.total === 0 && (
            <li className="combo__empty" role="presentation">Nothing matches “{query}”.</li>
          )}

          {filtered.total > MAX_RENDERED && (
            <li className="combo__more" role="presentation">
              {filtered.total - MAX_RENDERED} more — keep typing to narrow.
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
