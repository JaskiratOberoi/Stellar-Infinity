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
  // execCommand's fontName/fontSize/foreColor speak <font> — legacy markup,
  // but it is what every browser's editing engine still emits.
  'FONT',
]);

/** Removed WITH their content — nothing inside these is result text. */
const POISON = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META', 'FORM', 'INPUT', 'BUTTON']);

/** The inline styles the editor emits and the report honours. */
const STYLE_KEEP = [
  'text-align', 'font-weight', 'font-style', 'text-decoration',
  'color', 'background-color', 'font-size', 'font-family',
];

/** <font>'s own presentational attributes — value-checked, not just named. */
const FONT_ATTRS: Record<string, RegExp> = {
  size: /^[1-7]$/,
  color: /^(#[0-9a-f]{3,8}|[a-z]+|rgb\([\d ,]+\))$/i,
  face: /^[\w \-,'"]+$/,
};

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
    // Attributes are rebuilt, never trusted: the whitelisted style
    // properties, <font>'s value-checked presentational trio, and the one
    // marker class the page-break tool writes. Nothing else — no handlers,
    // no ids, nothing riding in from outside.
    const style = child.getAttribute('style') ?? '';
    const isBreak = child.tagName === 'DIV' && child.getAttribute('class') === 'pagebreak';
    const fontKeep = child.tagName === 'FONT'
      ? Object.keys(FONT_ATTRS)
          .map((a) => [a, child.getAttribute(a)] as const)
          .filter(([a, v]) => v != null && FONT_ATTRS[a].test(v))
      : [];
    for (const a of [...child.attributes]) child.removeAttribute(a.name);
    if (isBreak) child.setAttribute('class', 'pagebreak');
    for (const [a, v] of fontKeep) child.setAttribute(a, v!);
    if (style) {
      const kept = style
        .split(';')
        .map((d) => d.trim())
        .filter((d) => STYLE_KEEP.some((k) => d.toLowerCase().startsWith(`${k}:`))
                    && !/url\s*\(|expression\s*\(/i.test(d))
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
