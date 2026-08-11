import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { correctAt, type Correction } from '../lib/spellcheck';

/**
 * Self-correcting text fields for the worksheet, with an undo.
 *
 * A bench comment is read by a doctor and kept for ever, so a typo in it is
 * worth fixing — but silently editing what somebody wrote into a medical record
 * is not something to do quietly. Every correction therefore announces itself
 * twice: the field flashes, and a toast names the exact substitution and offers
 * to put it back for three seconds.
 *
 * ── WHY THE FLASH IS ON THE FIELD, NOT THE WORD ───────────────────────────
 * Highlighting the corrected word itself needs a mirror element rendered behind
 * the input with matching metrics, kept in step through wrapping, scrolling and
 * font loading. When it drifts — and it drifts — the highlight sits over the
 * wrong word, which in a medical record is worse than no highlight at all.
 *
 * The field flash plus a toast that spells out «recieve» → «receive» tells the
 * operator the same two things (that something changed, and what) without a
 * mechanism that can point at the wrong word. See spellcheck.ts for why the
 * correction list itself is a fixed table rather than a dictionary.
 */

/** How long the undo stays up. Three seconds, per the request. */
const UNDO_MS = 3000;
/** How long the field stays tinted. Shorter — it is a nudge, not a state. */
const FLASH_MS = 1400;

interface Pending {
  id: number;
  correction: Correction;
  undo: () => void;
}

// A module-level store rather than a context: exactly one correction is on
// screen at a time, the toast is mounted once, and threading a provider through
// the worksheet would be more plumbing than the feature is worth.
let pending: Pending | null = null;
let seq = 0;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

function announce(correction: Correction, undo: () => void) {
  pending = { id: ++seq, correction, undo };
  notify();
}

function dismiss(id?: number) {
  // The id guards against a stale timer clearing a NEWER correction: type fast
  // enough to trigger two, and the first one's timeout must not take the
  // second one's undo away with it.
  if (id !== undefined && pending?.id !== id) return;
  pending = null;
  notify();
}

type Props = {
  value: string;
  onChange: (next: string) => void;
  /** Rendered as a textarea rather than an input. */
  multiline?: boolean;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>;

export function SpellChecked({ value, onChange, multiline, className, ...rest }: Props) {
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  // Where to put the caret once React has re-rendered with the corrected text.
  const caret = useRef<number | null>(null);
  const [flash, setFlash] = useState(false);

  // Layout effect, not effect: the caret has to be restored in the same frame
  // the corrected text paints, or it visibly jumps to the end and back.
  useLayoutEffect(() => {
    if (caret.current == null || !ref.current) return;
    ref.current.setSelectionRange(caret.current, caret.current);
    caret.current = null;
  });

  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(false), FLASH_MS);
    return () => clearTimeout(t);
  }, [flash]);

  const apply = useCallback((result: ReturnType<typeof correctAt>, before: string, beforeCaret: number) => {
    if (!result) return false;
    onChange(result.text);
    caret.current = result.caret;
    setFlash(true);

    announce(result.correction, () => {
      // Puts back exactly what was typed, caret included. Restoring the text
      // alone would drop the operator's cursor to the end of the field, which
      // on a long comment means finding their place again.
      onChange(before);
      caret.current = beforeCaret;
      setFlash(false);
      ref.current?.focus();
    });
    return true;
  }, [onChange]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const next = e.target.value;
    const pos = e.target.selectionStart ?? next.length;

    // The uncorrected text is what onChange normally gets; the correction, if
    // any, replaces it in the same tick so there is no intermediate render.
    if (!apply(correctAt(next, pos), next, pos)) onChange(next);
  };

  // The last word never gets a boundary character, so nothing would fire on it
  // without this. Leaving a field is the moment that word is finished.
  const handleBlur = (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const text = e.target.value;
    apply(correctAt(text, text.length, true), text, text.length);
    rest.onBlur?.(e as React.FocusEvent<HTMLInputElement>);
  };

  const cls = `${className ?? ''}${flash ? ' spellfix' : ''}`.trim() || undefined;

  return multiline ? (
    <textarea
      {...(rest as React.TextareaHTMLAttributes<HTMLTextAreaElement>)}
      ref={ref} className={cls} value={value}
      onChange={handleChange} onBlur={handleBlur}
      // The browser's own red underline still marks what this did not correct,
      // which is most of it — see spellcheck.ts on why the table is small.
      spellCheck
    />
  ) : (
    <input
      {...rest} ref={ref} className={cls} value={value}
      onChange={handleChange} onBlur={handleBlur}
      spellCheck
    />
  );
}

/**
 * The undo. Mounted once per screen that uses SpellChecked.
 *
 * Portalled to the body so it floats clear of whatever table or drawer the
 * field happens to live in, and positioned above the New order button rather
 * than under it.
 */
export function SpellCheckUndo() {
  const [, force] = useState(0);
  const [now, setNow] = useState<Pending | null>(pending);

  useEffect(() => {
    const l = () => { setNow(pending); force((n) => n + 1); };
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);

  useEffect(() => {
    if (!now) return;
    const id = now.id;
    const t = setTimeout(() => dismiss(id), UNDO_MS);
    return () => clearTimeout(t);
  }, [now]);

  if (!now) return null;

  return createPortal(
    // role=status, not alert: this is a notification about something already
    // done, and it must not interrupt a screen reader mid-word.
    <div className="spellundo" role="status" aria-live="polite">
      <span className="spellundo__text">
        Corrected <s>{now.correction.from}</s> <b>{now.correction.to}</b>
      </span>
      <button
        className="spellundo__btn"
        onClick={() => { now.undo(); dismiss(now.id); }}
      >
        Undo
      </button>
    </div>,
    document.body,
  );
}
