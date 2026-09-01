import { useEffect, useRef } from 'react';
import { isRichValue, sanitizeRich } from '../lib/richText';

/**
 * The word-processor surface for descriptive results — the LIS's TinyMCE
 * strips (Worksheet/IHCReport.aspx), rebuilt small.
 *
 * Written rather than installed, like the Combobox and for the same reason:
 * the project's runtime dependencies are React and the router, and what a
 * histopathology description needs is bold, lists and alignment — not a
 * plugin ecosystem. contentEditable with execCommand is deprecated on paper
 * and universally supported in practice; the output is sanitised through
 * lib/richText on every path that renders it, so whatever a browser's editing
 * engine emits is rebuilt against the allow-list before it reaches a report.
 *
 * UNCONTROLLED on purpose. Pushing value back into innerHTML on every
 * keystroke resets the caret to the start; the DOM owns the text while the
 * editor is open and onChange reports it outward. The `value` prop is read
 * once, at mount.
 */
export function RichTextEditor({ value, readOnly, ariaLabel, minHeight, onChange }: {
  value: string;
  readOnly: boolean;
  ariaLabel: string;
  /** CSS length; the per-row editors in the Desc report stay compact. */
  minHeight?: string;
  onChange: (html: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // A plain value (numbers, or prose typed before this editor existed)
    // arrives as text with newlines; markup arrives sanitised.
    el.innerHTML = isRichValue(value)
      ? sanitizeRich(value)
      : escapeText(value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const report = () => {
    const el = ref.current;
    if (!el) return;
    // An editor holding no text is an empty value, not markup shaped like one
    // — '<p><br></p>' saved as a result would print a blank paragraph.
    onChange(el.innerText.trim() === '' ? '' : el.innerHTML);
  };

  const exec = (cmd: string, arg?: string) => {
    if (readOnly) return;
    ref.current?.focus();
    document.execCommand(cmd, false, arg);
    report();
  };

  const Btn = ({ cmd, arg, title, label, children }: {
    cmd: string; arg?: string; title: string; label?: string; children?: React.ReactNode;
  }) => (
    <button
      type="button"
      className="richtext__btn"
      disabled={readOnly}
      title={title}
      aria-label={title}
      // mousedown, not click: click lands after the editor loses focus and
      // with it the selection the command was meant to apply to.
      onMouseDown={(e) => { e.preventDefault(); exec(cmd, arg); }}
    >
      {children ?? label}
    </button>
  );

  return (
    <div className="richtext">
      <div className="richtext__bar" role="toolbar" aria-label="Text formatting">
        <Btn cmd="bold" title="Bold (Ctrl+B)"><b>B</b></Btn>
        <Btn cmd="italic" title="Italic (Ctrl+I)"><i>I</i></Btn>
        <Btn cmd="underline" title="Underline (Ctrl+U)"><u>U</u></Btn>
        <span className="richtext__sep" />
        <Btn cmd="insertUnorderedList" title="Bulleted list" label="• List" />
        <Btn cmd="insertOrderedList" title="Numbered list" label="1. List" />
        <span className="richtext__sep" />
        <Btn cmd="justifyLeft" title="Align left" label="⟸" />
        <Btn cmd="justifyCenter" title="Centre" label="⟺" />
        <Btn cmd="justifyRight" title="Align right" label="⟹" />
        <span className="richtext__sep" />
        <Btn cmd="removeFormat" title="Clear formatting" label="Tx" />
        <Btn cmd="undo" title="Undo (Ctrl+Z)" label="↶" />
        <Btn cmd="redo" title="Redo" label="↷" />
      </div>
      <div
        ref={ref}
        className="richtext__area"
        contentEditable={!readOnly}
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label={ariaLabel}
        aria-readonly={readOnly}
        style={minHeight ? { minHeight } : undefined}
        onInput={report}
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
