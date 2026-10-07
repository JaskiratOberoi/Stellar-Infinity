import { useEffect, useId, useRef, useState } from 'react';

/**
 * A select for a SHORT, fixed list — the kind of a sale, a business unit, a
 * source. The native <select> opens the operating system's own menu, which
 * matches nothing else on the page (and on Windows looks like 2009). This
 * one is a button that opens the same styled listbox the comboboxes use,
 * with the keyboard behaviour of a select: arrows move, Enter and Space
 * pick, Escape closes, typing a letter jumps. For a long list that wants
 * typing to filter, use Combobox instead.
 */
export interface MenuOption<V extends string | number | null> {
  value: V;
  label: string;
  hint?: string | null;
}

export function MenuSelect<V extends string | number | null>({
  value, options, onChange, ariaLabel, className, small = true, width,
}: {
  value: V;
  options: MenuOption<V>[];
  onChange: (v: V) => void;
  ariaLabel: string;
  className?: string;
  small?: boolean;
  width?: number | string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const listId = useId();
  const current = options.find((o) => o.value === value) ?? options[0];

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  const openAt = () => {
    setActive(Math.max(0, options.findIndex((o) => o.value === value)));
    setOpen(true);
  };
  const pick = (i: number) => { onChange(options[i].value); setOpen(false); };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) { openAt(); return; }
      setActive((i) => e.key === 'ArrowDown' ? (i + 1) % options.length : (i - 1 + options.length) % options.length);
      return;
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (open) pick(active); else openAt();
      return;
    }
    if (e.key === 'Escape') { setOpen(false); return; }
    if (e.key === 'Tab') { setOpen(false); return; }
    if (e.key.length === 1 && /\S/.test(e.key)) {
      // Jump to the next option starting with the letter, as a select does.
      const from = open ? active : options.findIndex((o) => o.value === value);
      for (let n = 1; n <= options.length; n++) {
        const i = (from + n) % options.length;
        if (options[i].label.toLowerCase().startsWith(e.key.toLowerCase())) {
          if (open) setActive(i); else onChange(options[i].value);
          break;
        }
      }
    }
  };

  return (
    <div ref={root} className={`combo menu${className ? ` ${className}` : ''}`} style={width != null ? { width } : undefined}>
      <button
        type="button"
        className={`input${small ? ' input--sm' : ''} menu__btn`}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-label={ariaLabel}
        onClick={() => (open ? setOpen(false) : openAt())}
        onKeyDown={onKey}
      >
        <span className="menu__label">{current?.label}</span>
        <span className="combo__caret" aria-hidden="true">▾</span>
      </button>
      {open && (
        <ul className="combo__list menu__list" id={listId} role="listbox" aria-label={ariaLabel}>
          {options.map((o, i) => (
            <li
              key={String(o.value)}
              role="option"
              aria-selected={o.value === value}
              data-active={i === active}
              className={`combo__opt${o.value === value ? ' combo__opt--on' : ''}`}
              onPointerDown={(e) => { e.preventDefault(); pick(i); }}
              onPointerEnter={() => setActive(i)}
            >
              <span className="combo__label">{o.label}</span>
              {o.hint && <span className="combo__hint">{o.hint}</span>}
              {o.value === value && <span className="combo__mark" aria-hidden="true">✓</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
