/**
 * Rich descriptive results — detection and sanitisation.
 *
 * The LIS's Desc Report editor (Worksheet/IHCReport.aspx) writes REAL HTML
 * into the result value column: a histopathology description arrives as
 * paragraphs, bold headings and lists, and the report is expected to print
 * them as such. Infinity's default treatment of LIS markup is to strip it
 * (lib/format.ts plainText) because most of it is presentation leaked into
 * data — but for descriptive results the presentation IS the result, so this
 * module is the one gate through which value markup may reach
 * dangerouslySetInnerHTML, and everything passing it is rebuilt against an
 * allow-list first.
 */

/** Tags whose presence marks a value as a rich descriptive result. `<br>` on
 *  its own does not count — plenty of plain LIS values carry line breaks. */
const RICH_MARK = /<\/?(?:b|i|u|em|strong|p|div|ul|ol|li|h[1-6]|table|sub|sup)\b/i;

export function isRichValue(s: string | null | undefined): boolean {
  return !!s && RICH_MARK.test(s);
}

/** What survives sanitisation. Everything else is unwrapped (its children
 *  survive, the tag does not) — except the poison list below. */
const ALLOWED = new Set([
  'B', 'I', 'U', 'EM', 'STRONG', 'P', 'DIV', 'BR', 'UL', 'OL', 'LI',
  'SUB', 'SUP', 'TABLE', 'TBODY', 'THEAD', 'TR', 'TD', 'TH', 'H1', 'H2', 'H3', 'H4',
]);

/** Removed WITH their content — nothing inside these is result text. */
const POISON = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META', 'FORM', 'INPUT', 'BUTTON']);

/** The inline styles the editor emits and the report honours. */
const STYLE_KEEP = ['text-align', 'font-weight', 'font-style', 'text-decoration'];

function scrub(node: Element, doc: Document): void {
  for (const child of [...node.children]) {
    if (POISON.has(child.tagName)) {
      child.remove();
      continue;
    }
    scrub(child, doc);
    if (!ALLOWED.has(child.tagName)) {
      // Unwrap: keep the text and the surviving grandchildren, drop the tag.
      while (child.firstChild) node.insertBefore(child.firstChild, child);
      child.remove();
      continue;
    }
    // Attributes are rebuilt, never trusted: only the whitelisted style
    // properties survive, and nothing else does — no handlers, no ids, no
    // classes riding in from the LIS editor.
    const style = child.getAttribute('style') ?? '';
    for (const a of [...child.attributes]) child.removeAttribute(a.name);
    if (style) {
      const kept = style
        .split(';')
        .map((d) => d.trim())
        .filter((d) => STYLE_KEEP.some((k) => d.toLowerCase().startsWith(`${k}:`)))
        .join('; ');
      if (kept) child.setAttribute('style', kept);
    }
  }
}

/**
 * Sanitised HTML for a rich value, safe to hand to dangerouslySetInnerHTML.
 * Never returns markup for a value that is not rich — callers branch on
 * isRichValue first, and a plain value goes down the escaped-text path.
 */
export function sanitizeRich(s: string): string {
  const doc = new DOMParser().parseFromString(`<div>${s}</div>`, 'text/html');
  const root = doc.body.firstElementChild;
  if (!root) return '';
  scrub(root, doc);
  return root.innerHTML;
}
