/**
 * Light/dark theming, mirroring Telo's approach (next-themes + a `dark` class
 * on <html>) but hand-rolled, because this app is plain CSS with no framework
 * to lean on.
 *
 * Two states only — light and dark, no "system" option — matching Telo's
 * deliberate choice of an explicit default plus a manual toggle.
 */

export type Theme = 'light' | 'dark';

/** Namespaced so it cannot collide with Telo's `telo-theme` on a shared host. */
export const THEME_STORAGE_KEY = 'infinity-theme';

export function readStoredTheme(): Theme | null {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    return raw === 'dark' || raw === 'light' ? raw : null;
  } catch {
    // Private mode / disabled storage — fall back to the default, never throw.
    return null;
  }
}

export function currentTheme(): Theme {
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
}

/**
 * Apply a theme to the document.
 *
 * Suppresses transitions for one frame while switching. Without this, every
 * surface with `transition: background .15s` cross-fades independently and the
 * page appears to smear through an intermediate state. This is what
 * next-themes' `disableTransitionOnChange` does for Telo.
 */
export function applyTheme(theme: Theme, { animate = false } = {}) {
  const root = document.documentElement;

  let killer: HTMLStyleElement | null = null;
  if (!animate) {
    killer = document.createElement('style');
    killer.appendChild(
      document.createTextNode('*,*::before,*::after{transition:none!important;animation:none!important}'),
    );
    document.head.appendChild(killer);
  }

  root.classList.toggle('dark', theme === 'dark');
  // Lets the browser theme native scrollbars, form controls and the caret.
  // Telo omits this; it is a cheap correctness win.
  root.style.colorScheme = theme;

  if (killer) {
    // Force a reflow so the no-transition style is definitely applied to the
    // new colours before we remove it.
    void window.getComputedStyle(document.body).opacity;
    document.head.removeChild(killer);
  }

  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Not fatal — the theme still applies for this session.
  }
}

export function toggleTheme(): Theme {
  const next: Theme = currentTheme() === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  return next;
}
