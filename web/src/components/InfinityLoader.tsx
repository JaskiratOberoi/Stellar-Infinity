import { useId } from 'react';

/**
 * The house loader: the Infinity figure-8 with a particle riding the full
 * lemniscate. One dim track, one gradient comet, and a bright dot at the
 * comet's head — all three are THE SAME PATH, so nothing can drift out of
 * alignment.
 *
 * How the particle moves: the comet and the dot are extra copies of the track
 * path with `pathLength=100` and a dash pattern, and the animation slides
 * `stroke-dashoffset`. That keeps every moving part on the CSS animation
 * clock — a SMIL `animateMotion` dot would tick on a different timeline and
 * visibly detach from the comet the moment a tab is throttled. The dot is a
 * 0.1-length dash with round caps, which renders as a circle of the stroke
 * width, phase-shifted 26 units ahead so it sits exactly on the comet's nose.
 *
 * The path is the Mark's two strands joined into one continuous loop, so the
 * loader is literally the logo being traced. Under prefers-reduced-motion the
 * global animation kill-switch freezes it into a static brand mark, which is
 * exactly the right degraded state.
 *
 * `mono` renders in currentColor for places where the gradient would clash —
 * inside the primary button, the comet inherits the button label's colour.
 */
export function InfinityLoader({
  size = 120,
  mono = false,
  label = 'Loading',
}: {
  /** Rendered width in px; height follows the path's aspect. */
  size?: number;
  mono?: boolean;
  label?: string;
}) {
  // useId contains colons, which are invalid in url(#…) references.
  const gradId = `ig-${useId().replace(/[^a-zA-Z0-9-]/g, '')}`;

  // The Mark's front strand followed by its back strand reversed: one
  // continuous lemniscate from left-centre, over the left loop, through the
  // crossover, around the right loop, and home.
  const d =
    'M60,120 C60,58 170,58 240,120 C310,182 420,182 420,120 ' +
    'C420,58 310,58 240,120 C170,182 60,182 60,120 Z';

  return (
    <span className={`infload${mono ? ' infload--mono' : ''}`} role="status" aria-label={label} style={{ width: size }}>
      <svg
        viewBox="40 58 400 124"
        width={size}
        height={Math.round(size * (124 / 400))}
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
      >
        {!mono && (
          <defs>
            <linearGradient id={gradId} x1="60" y1="58" x2="420" y2="182" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stopColor="#06b6d4" />
              <stop offset="50%" stopColor="#0d9488" />
              <stop offset="100%" stopColor="#2563eb" />
            </linearGradient>
          </defs>
        )}

        <path className="infload__track" d={d} pathLength={100} />
        <path
          className="infload__comet"
          d={d}
          pathLength={100}
          stroke={mono ? 'currentColor' : `url(#${gradId})`}
        />
        <path
          className="infload__dot"
          d={d}
          pathLength={100}
          stroke={mono ? 'currentColor' : `url(#${gradId})`}
        />
      </svg>
    </span>
  );
}
