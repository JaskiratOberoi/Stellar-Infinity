import { useId } from 'react';
import { INFINITY_PATH, INFINITY_VIEWBOX } from './infinityPath';

/**
 * Stage 2 of the sign-in entrance: the spark draws the Infinity symbol.
 *
 * The particle that the login card collapsed into now travels the lemniscate
 * and DRAWS it — the stroke is revealed behind the moving head, so the symbol
 * is written in one continuous line rather than fading in. When the line
 * closes on itself the whole mark flares, and the flare's light expands to
 * become the application.
 *
 * The reveal and the particle are the same path, driven by the same clock:
 *
 *   trail  dasharray 100/100, offset 100 -> 0   (drawn length = 100 - offset)
 *   head   dasharray .1/99.9, offset   0 -> -100
 *
 * At every instant the head's dash sits exactly at the trail's leading edge,
 * so the particle can never separate from the line it is drawing. A SMIL
 * animateMotion dot would run on a different timeline and drift.
 */
export function SignInDraw() {
  const uid = useId().replace(/[^a-zA-Z0-9-]/g, '');
  const gradId = `sd-grad-${uid}`;
  const glowId = `sd-glow-${uid}`;

  // Starts at the CROSSOVER — the symbol's centre — so the stroke head
  // begins exactly where the login card's particle ended. See infinityPath.ts.
  const d = INFINITY_PATH;

  return (
    <div className="sdraw" aria-hidden="true">
      <svg className="sdraw__svg" viewBox={INFINITY_VIEWBOX} fill="none" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id={gradId} x1="60" y1="58" x2="420" y2="182" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#06b6d4" />
            <stop offset="50%" stopColor="#0d9488" />
            <stop offset="100%" stopColor="#2563eb" />
          </linearGradient>
          <filter id={glowId} x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="6" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* The line being written. */}
        <path
          className="sdraw__trail"
          d={d}
          pathLength={100}
          stroke={`url(#${gradId})`}
          filter={`url(#${glowId})`}
        />
        {/* The particle at the writing head — the same spark the card became. */}
        <path
          className="sdraw__head"
          d={d}
          pathLength={100}
          stroke="#ffffff"
          filter={`url(#${glowId})`}
        />
      </svg>

      {/* The flare: light thrown off when the loop closes, expanding into the app. */}
      <span className="sdraw__flare" />
    </div>
  );
}
