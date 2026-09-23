import { useEffect, useRef } from 'react';
import { isRichValue, htmlToLines } from '../lib/richText';
import { correctionFor } from '../lib/spellcheck';
import { announceCorrection } from './SpellChecked';

/**
 * The long-form surface for descriptive results: a cytology description, a
 * histopathology impression, a culture note — prose in the same `value`
 * column a figure uses.
 *
 * It writes PLAIN LINES, never markup. The legacy LIS enters these values
 * through a multi-line textbox and stores them as text with line breaks
 * (309 of the last 300,000 result rows carry a line break; not one carries a
 * paragraph tag), and its worksheet preview shows whatever is stored
 * literally — a value saved here as `<div>VOLUME: 30&nbsp; ML</div>` came
 * out on the LIS screen exactly like that. This editor used to be a small
 * word processor (bold, fonts, colours, tables, page breaks) on the premise
 * that the LIS's Desc Report page wrote real HTML; the data says that page
 * is not what the lab uses. Both systems read one column, so the column
 * keeps one shape: lines. Line breaks are the pathologist's paragraphs and
 * print as written, in Infinity and in the LIS alike.
 *
 * Still contentEditable rather than a textarea, for the autocorrect: the
 * curated non-word table fires as it does in the plain fields, and the
 * corrected word gets its green mark while the editor is open. The mark is
 * a DOM span and never reaches the value — the value is the element's text.
 *
 * UNCONTROLLED on purpose. Pushing value back on every keystroke resets the
 * caret to the start; the DOM owns the text while the editor is open and
 * onChange reports it outward. The `value` prop is read once, at mount.
 */

/** Ends a word — the same set spellcheck.ts uses, plus the &nbsp; editors emit. */
const WORD_BOUNDARY = /[\s.,;:!?)\]}"'/\\ ]/;

/**
 * Autocorrect for the editing surface — and, because THIS surface can mark a
 * substring, the corrected word itself gets Infinity's green wavy underline
 * (`.inf-spellfix`), not just a field flash. The span is an editing aid; the
 * value is read as text, so the mark never prints.
 *
 * Same engine and same conservatism as the plain fields: only the curated
 * non-word table fires, the toast names the substitution, and Undo puts back
 * the exact text.
 */
function trySpellFix(root: HTMLElement, report: () => void): void {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return;
  const node = sel.anchorNode;
  if (!node || node.nodeType !== Node.TEXT_NODE || !root.contains(node)) return;
  // Typing inside an already-corrected word must not stack another span.
  if ((node.parentElement)?.closest('.inf-spellfix')) return;

  const text = node.textContent ?? '';
  const caret = sel.anchorOffset;
  if (caret < 1 || !WORD_BOUNDARY.test(text[caret - 1])) return;

  let end = caret - 1;
  while (end > 0 && WORD_BOUNDARY.test(text[end - 1])) end--;
  let start = end;
  while (start > 0 && !WORD_BOUNDARY.test(text[start - 1])) start--;
  if (start === end) return;

  const word = text.slice(start, end);
  const fixed = correctionFor(word);
  if (!fixed) return;

  const t = node as Text;
  const range = document.createRange();
  range.setStart(t, start);
  range.setEnd(t, end);
  const span = document.createElement('span');
  span.className = 'inf-spellfix';
  span.textContent = fixed;
  range.deleteContents();
  range.insertNode(span);

  // The caret goes back to where the typist was: just after the boundary
  // character, which now lives in the text node following the span.
  const after = span.nextSibling;
  if (after && after.nodeType === Node.TEXT_NODE) {
    const offset = Math.min(caret - end, (after.textContent ?? '').length);
    sel.collapse(after, offset);
  } else {
    sel.collapse(root, root.childNodes.length);
  }
  report();

  announceCorrection({ from: word, to: fixed, start }, () => {
    if (!span.isConnected) return;
    const original = document.createTextNode(word);
    span.replaceWith(original);
    const s = window.getSelection();
    s?.collapse(original, word.length);
    report();
  });
}

/**
 * The element's text as the value: block boundaries and <br> become line
 * breaks (innerText's rendering rule), non-breaking spaces become spaces,
 * runs of blank lines collapse to one blank line, and trailing space goes.
 * An editor holding no text is an empty value.
 */
function linesOf(el: HTMLElement): string {
  const text = el.innerText
    .replace(/ /g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\s+$/, '');
  return text.trim() === '' ? '' : text;
}

export function RichTextEditor({ value, readOnly, ariaLabel, minHeight, onChange }: {
  value: string;
  readOnly: boolean;
  ariaLabel: string;
  /** CSS length; the per-row editors in the Desc report stay compact. */
  minHeight?: string;
  /** The value as plain lines — what is stored. */
  onChange: (text: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // A value saved as markup before this editor wrote lines (or by the
    // LIS's own Desc Report page) is flattened to its lines here, so the
    // next save stores lines like every other value.
    el.innerHTML = escapeText(isRichValue(value) ? htmlToLines(value) : value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const report = () => {
    const el = ref.current;
    if (el) onChange(linesOf(el));
  };

  return (
    <div className="richtext">
      <div
        ref={ref}
        className="richtext__area"
        contentEditable={!readOnly ? 'plaintext-only' : false}
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label={ariaLabel}
        aria-readonly={readOnly}
        style={minHeight ? { minHeight } : undefined}
        onInput={() => {
          if (!readOnly && ref.current) trySpellFix(ref.current, report);
          report();
        }}
        // Pasted text arrives as text: a paragraph copied from a browser
        // or a document would otherwise bring its markup in, and the mark
        // would end up in the LIS column.
        onPaste={(e) => {
          if (readOnly) return;
          e.preventDefault();
          const text = e.clipboardData.getData('text/plain');
          if (text) document.execCommand('insertText', false, text.replace(/\r\n?/g, '\n'));
        }}
        onBlur={report}
      />
    </div>
  );
}

/** Plain text, made displayable inside the editor: escaped, newlines kept. */
function escapeText(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');
}
