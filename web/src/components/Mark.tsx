/**
 * The Infinity mark — the same rounded double-helix figure-8 as the splash,
 * hand-inlined here rather than shared, because the splash builds its strands
 * imperatively at runtime and this only ever needs the static shape.
 */
export function Mark({ withText = true }: { withText?: boolean }) {
  return (
    <div className="mark">
      <svg viewBox="0 0 480 240" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <defs>
          <linearGradient id="mk" x1="0" y1="0" x2="480" y2="240" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#06b6d4" />
            <stop offset="50%" stopColor="#0d9488" />
            <stop offset="100%" stopColor="#2563eb" />
          </linearGradient>
        </defs>
        {/* rungs */}
        <path
          d="M96,92 L96,148 M132,78 L132,162 M168,92 L168,148 M312,92 L312,148 M348,78 L348,162 M384,92 L384,148"
          stroke="rgba(13,148,136,.28)"
          strokeWidth="7"
          strokeLinecap="round"
        />
        {/* back strand */}
        <path
          d="M60,120 C60,182 170,182 240,120 C310,58 420,58 420,120"
          stroke="rgba(13,148,136,.34)"
          strokeWidth="14"
          strokeLinecap="round"
          fill="none"
        />
        {/* front strand */}
        <path
          d="M60,120 C60,58 170,58 240,120 C310,182 420,182 420,120"
          stroke="url(#mk)"
          strokeWidth="14"
          strokeLinecap="round"
          fill="none"
        />
      </svg>
      {withText && (
        <span className="mark__text">
          <b>INFINITY</b>
        </span>
      )}
    </div>
  );
}
