/**
 * A small "?" beside a label that explains the figure under it.
 *
 * Hover or keyboard focus shows the bubble; the text is also the element's
 * accessible name, so a screen reader hears the explanation without needing
 * the hover. Native `title` is deliberately NOT used: its delay and styling
 * are the browser's, and on touch it never appears at all.
 */
export function Tip({ text, side = 'below' }: { text: string; side?: 'below' | 'above' }) {
  return (
    <span className={`tip tip--${side}`} tabIndex={0} aria-label={text}>
      <span className="tip__icon" aria-hidden="true">?</span>
      <span className="tip__bubble" role="tooltip">{text}</span>
    </span>
  );
}
