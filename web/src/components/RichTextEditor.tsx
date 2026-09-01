import { useEffect, useRef } from 'react';
import { isRichValue, sanitizeRich } from '../lib/richText';

/**
 * The word-processor surface for descriptive results — the LIS's TinyMCE
 * strips (Worksheet/IHCReport.aspx toolbar: bold italic underline, lists,
 * font/size/format, colours, alignment, page break, tables), rebuilt small.
 *
 * Written rather than installed, like the Combobox and for the same reason:
 * the project's runtime dependencies are React and the router. contentEditable
 * with execCommand is deprecated on paper and universally supported in
 * practice; the output is sanitised through lib/richText on every path that
 * renders it, so whatever a browser's editing engine emits is rebuilt against
 * the allow-list before it reaches a report.
 *
 * UNCONTROLLED on purpose. Pushing value back into innerHTML on every
 * keystroke resets the caret to the start; the DOM owns the text while the
 * editor is open and onChange reports it outward. The `value` prop is read
 * once, at mount.
 */

const FONTS = ['Arial', 'Georgia', 'Times New Roman', 'Courier New', 'Verdana'];

/** execCommand's 1–7 scale, labelled in the points an operator thinks in. */
const SIZES: { value: string; label: string }[] = [
  { value: '1', label: '8pt' },
  { value: '2', label: '10pt' },
  { value: '3', label: '12pt' },
  { value: '4', label: '14pt' },
  { value: '5', label: '18pt' },
  { value: '6', label: '24pt' },
];

const BLOCKS: { value: string; label: string }[] = [
  { value: 'p', label: 'Paragraph' },
  { value: 'h2', label: 'Heading' },
  { value: 'h3', label: 'Subheading' },
  { value: 'h4', label: 'Small heading' },
];

/** Print-sensible ink: black, the report's danger red, and a deep blue. */
const COLOURS = ['#111827', '#dc2626', '#1d4ed8'];

const PAGE_BREAK_HTML = '<div class="pagebreak"></div><p><br></p>';

const TABLE_HTML =
  '<table style="border-collapse:collapse"><tbody>'
  + Array.from({ length: 3 }, () =>
      `<tr>${'<td style="border:1px solid #9ca3af;padding:2px 8px">&nbsp;</td>'.repeat(3)}</tr>`).join('')
  + '</tbody></table><p><br></p>';

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

  /* A select steals focus by nature, so the selection is gone by the time
     onChange fires — but execCommand still applies to the editor's LAST
     selection once it is refocused, which exec() does. The value snaps back
     to the placeholder row so the control reads as a menu of actions, not a
     state it would have no way of tracking across a mixed selection. */
  const Pick = ({ title, placeholder, options, cmd }: {
    title: string; placeholder: string;
    options: { value: string; label: string }[];
    cmd: (v: string) => void;
  }) => (
    <select
      className="richtext__pick"
      disabled={readOnly}
      title={title}
      aria-label={title}
      value=""
      onChange={(e) => { if (e.target.value) cmd(e.target.value); }}
    >
      <option value="" disabled>{placeholder}</option>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
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
        <Pick title="Paragraph format" placeholder="Format"
              options={BLOCKS} cmd={(v) => exec('formatBlock', v)} />
        <Pick title="Font" placeholder="Font"
              options={FONTS.map((f) => ({ value: f, label: f }))}
              cmd={(v) => exec('fontName', v)} />
        <Pick title="Font size" placeholder="Size"
              options={SIZES} cmd={(v) => exec('fontSize', v)} />
        <span className="richtext__sep" />
        {COLOURS.map((c) => (
          <button key={c} type="button" className="richtext__btn richtext__swatch"
                  disabled={readOnly} title={`Text colour ${c}`}
                  aria-label={`Text colour ${c}`}
                  onMouseDown={(e) => { e.preventDefault(); exec('foreColor', c); }}>
            <span style={{ background: c }} />
          </button>
        ))}
        <span className="richtext__sep" />
        <Btn cmd="justifyLeft" title="Align left" label="⟸" />
        <Btn cmd="justifyCenter" title="Centre" label="⟺" />
        <Btn cmd="justifyRight" title="Align right" label="⟹" />
        <Btn cmd="justifyFull" title="Justify" label="☰" />
        <span className="richtext__sep" />
        <Btn cmd="insertHTML" arg={TABLE_HTML} title="Insert a 3×3 table" label="⊞ Table" />
        <Btn cmd="insertHTML" arg={PAGE_BREAK_HTML}
             title="Page break — the report starts a new page here" label="⤓ Page" />
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
