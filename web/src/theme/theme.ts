/**
 * Light/dark theming, mirroring Telo's approach (next-themes + a `dark` class
 * on <html>) but hand-rolled, because this app is plain CSS with no framework
 * to lean on.
 *
 * Two states only — light and dark, no "system" option. The DEFAULT is not a
 * constant, though: it follows the lab's clock. 7am–7pm IST is light, the
 * night hours are dark — the same reasoning as the login greeting, which
 * already knows the person signing in at 3am is running the night bench.
 *
 * The person always outranks the clock, in two tiers:
 *
 *   hold   one toggle applies immediately and HOLDS until the next 7am/7pm
 *          boundary, surviving reloads — the clock does not snatch back a
 *          choice mid-window.
 *   pin    a mode chosen three times is a habit, not an exception. It becomes
 *          the standing default and the clock stops driving. A later habit in
 *          the other direction re-pins the same way, so after both habits
 *          exist the toggle simply behaves like a remembered switch.
 *
 * IST is fixed UTC+5:30 with no daylight saving, so the arithmetic below can
 * be plain minutes and never needs a timezone database.
 */

export type Theme = 'light' | 'dark';

/** Namespaced so it cannot collide with Telo's `telo-theme` on a shared host. */
export const THEME_STORAGE_KEY = 'infinity-theme';

/** 'clock' = follow IST; a Theme value = pinned by habit. */
export const THEME_MODE_KEY = 'infinity-theme-mode';
/** {light: n, dark: n} — explicit choices, ever. */
export const THEME_VOTES_KEY = 'infinity-theme-votes';
/** {theme, until} — a toggle holding the fort until the next boundary. */
export const THEME_HOLD_KEY = 'infinity-theme-hold';

/** How many explicit picks of one mode turn it from exception into default. */
const PIN_AT = 3;

/** Minutes past IST midnight, from any Date. */
function istMinutes(now: Date): number {
  return (now.getUTCHours() * 60 + now.getUTCMinutes() + 330) % 1440;
}

/** What the lab's clock says the theme should be: 7am–7pm IST is light. */
export function istClockTheme(now = new Date()): Theme {
  const m = istMinutes(now);
  return m >= 7 * 60 && m < 19 * 60 ? 'light' : 'dark';
}

/** Epoch ms of the next 7:00 or 19:00 IST — when the clock next speaks. */
export function nextBoundaryAt(now = new Date()): number {
  const m = istMinutes(now);
  const next = [7 * 60, 19 * 60, 31 * 60].find((t) => t > m)!;
  return now.getTime() - (now.getSeconds() * 1000 + now.getMilliseconds())
    + (next - m) * 60_000;
}

function readJson<T>(key: string): T | null {
  try { return JSON.parse(localStorage.getItem(key) ?? 'null') as T | null; } catch { return null; }
}
function writeJson(key: string, v: unknown) {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* private mode */ }
}

/** The pinned mode, if a habit has formed. */
export function pinnedTheme(): Theme | null {
  try {
    const raw = localStorage.getItem(THEME_MODE_KEY);
    return raw === 'dark' || raw === 'light' ? raw : null;
  } catch { return null; }
}

/**
 * An explicit choice by the person. Applies now, holds until the next
 * boundary, and counts toward the habit that eventually pins it.
 */
export function chooseTheme(next: Theme): Theme {
  applyTheme(next);

  const votes = readJson<{ light?: number; dark?: number }>(THEME_VOTES_KEY) ?? {};
  votes[next] = (votes[next] ?? 0) + 1;
  writeJson(THEME_VOTES_KEY, votes);

  if ((votes[next] ?? 0) >= PIN_AT) {
    try { localStorage.setItem(THEME_MODE_KEY, next); } catch { /* private mode */ }
    try { localStorage.removeItem(THEME_HOLD_KEY); } catch { /* ignore */ }
  } else {
    writeJson(THEME_HOLD_KEY, { theme: next, until: nextBoundaryAt() });
  }
  return next;
}

/**
 * Keep the document on IST time while nothing outranks the clock.
 *
 * Runs every half-minute rather than aiming one long timeout at the boundary:
 * a laptop that slept through 7pm still lands on the right side within
 * moments of waking, which a fired-in-the-past timeout does not promise.
 * Returns the stop function.
 */
export function startThemeClock(): () => void {
  const tick = () => {
    if (pinnedTheme() !== null) return;

    const hold = readJson<{ theme?: string; until?: number }>(THEME_HOLD_KEY);
    if (hold && typeof hold.until === 'number') {
      if (hold.until > Date.now()) return;           // the person's window
      try { localStorage.removeItem(THEME_HOLD_KEY); } catch { /* ignore */ }
    }

    const due = istClockTheme();
    if (currentTheme() !== due) applyTheme(due);
  };
  tick();
  const t = window.setInterval(tick, 30_000);
  return () => window.clearInterval(t);
}

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

  // The toggle's icon and anything else showing the theme listens for this —
  // the clock can now change the document with nobody clicking anything.
  window.dispatchEvent(new Event('infinity-theme'));
}

export function toggleTheme(): Theme {
  return chooseTheme(currentTheme() === 'dark' ? 'light' : 'dark');
}
