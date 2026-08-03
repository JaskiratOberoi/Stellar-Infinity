import { useEffect, useState } from 'react';
import { currentTheme, toggleTheme, type Theme } from './theme';

/**
 * Sun/moon toggle. The icon shows the theme you would switch TO, which is the
 * convention Telo uses.
 */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>('light');

  // Read from the DOM rather than storage: the pre-paint script in index.html
  // is the source of truth and may have applied a default we never stored.
  useEffect(() => setTheme(currentTheme()), []);

  const isDark = theme === 'dark';
  const label = isDark ? 'Switch to light theme' : 'Switch to dark theme';

  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={() => setTheme(toggleTheme())}
      aria-label={label}
      title={label}
      /* role=switch + aria-pressed announce the state, which Telo's toggle
         does not do — a screen reader there only hears the label change. */
      aria-pressed={isDark}
    >
      {isDark ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}

function SunIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
    </svg>
  );
}
