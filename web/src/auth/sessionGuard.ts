/**
 * Session lifetime rules for a shared clinical workstation.
 *
 * Two guarantees, both of which the plain JWT expiry cannot give:
 *
 *   1. Closing the LAST tab signs you out. Not any tab — the last one. A
 *      technologist routinely has the worklist in one tab and a report in
 *      another, and closing the report must not end their shift.
 *
 *   2. Forty-five minutes of inactivity signs you out, counted across every
 *      open tab. Reading a long report in one tab counts as activity for all
 *      of them.
 *
 * WHY THE TOKEN MOVED TO localStorage. It used to live in sessionStorage,
 * which is per-tab: opening a second tab meant signing in again, and closing a
 * tab always killed that tab's session. Sharing the session across tabs is the
 * behaviour a lab actually needs, and it makes rule 1 expressible at all —
 * "last tab" is not a question sessionStorage can answer. The cost is that the
 * token now outlives a single tab, which is exactly why the registry below
 * exists to clear it deliberately.
 *
 * The registry is a heartbeat, not a counter. A counter drifts: a crashed or
 * force-killed tab never decrements it, and the session becomes immortal.
 * Timestamps let a tab that never said goodbye simply go stale.
 */

const TABS_KEY = 'infinity.tabs';        // { tabId: lastSeenEpochMs }
const ACTIVITY_KEY = 'infinity.lastActivity';
const CLOSED_KEY = 'infinity.lastTabClosedAt';

/**
 * How long after the last tab disappears a returning tab is treated as the
 * SAME session rather than a new one.
 *
 * This exists because a reload is indistinguishable from a close at the moment
 * it happens: pressing F5 on the only open tab fires pagehide, removes the last
 * tab from the registry, and looks exactly like the user closing the window.
 * Clearing the token there signed people out every time they refreshed.
 *
 * So the close is not acted on immediately — it is timestamped. If a tab
 * appears within the grace window it was a reload and the session continues; if
 * the next tab arrives later than this, the session is over and the token is
 * discarded.
 *
 * Five seconds is long enough to cover a slow reload on a tired workstation and
 * short enough that walking away and coming back is a fresh sign-in. The
 * deliberate gap: reopening a tab within five seconds (Ctrl+Shift+T) resumes
 * the session. That is the price of not breaking refresh, and refresh is the
 * far more common act.
 */
const REOPEN_GRACE_MS = 5_000;

/** How often each tab restamps itself. */
const HEARTBEAT_MS = 4_000;
/** A tab unheard from for this long is treated as gone (crash, kill, sleep). */
const STALE_MS = 15_000;

export const IDLE_LIMIT_MS = 45 * 60 * 1000;
/** How long before the cutoff the user is warned, so nothing typed is lost. */
export const IDLE_WARN_MS = 2 * 60 * 1000;
const IDLE_TICK_MS = 5_000;

const tabId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/**
 * True on the report print routes, which are documents rather than sessions.
 *
 * These rules describe a PERSON at a workstation — a tab they opened, a
 * keyboard they stopped touching. A print route is neither. It is loaded three
 * ways, and none of them is somebody working:
 *
 *   - by headless Chromium in the render sidecar, which photographs it to make
 *     the PDF. Its browser profile is empty, so the tab registry is empty, so
 *     the startup check below read a perfectly good session as one left behind
 *     by a crash and signed it out — and the page it was about to photograph
 *     became the login form. That is what made every PDF download hang for
 *     forty-five seconds and then fail.
 *   - inside the preview iframe, where counting it as a second tab would let a
 *     modal left open hold a finished session alive.
 *   - from the QR on a patient's printed copy, which carries a token and has no
 *     session at all.
 *
 * So a print page neither registers itself nor judges anyone else's session. It
 * renders one report and is thrown away.
 *
 * The narrow cost: a session abandoned by a crash stays usable at a print URL
 * until any other page is opened, which is when the check below runs and ends
 * it. Reaching that report means already being at the machine AND knowing a
 * SID, and it is still stricter than having no tab registry at all.
 *
 * `/print/report` and not `/print`: the invoice sheet lives under the same
 * prefix but no renderer ever loads it — an operator opens it and prints it
 * themselves. That is a person at a workstation, and the rules below are for
 * them. ReportPdfEndpoints and PublicReportEndpoints are the only things that
 * hand a URL to the sidecar, and every one of them is a report.
 */
function isRenderSurface(): boolean {
  return typeof window !== 'undefined' && window.location.pathname.startsWith('/print/report/');
}

function readTabs(): Record<string, number> {
  try {
    const raw = localStorage.getItem(TABS_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, number>) : {};
  } catch {
    // Corrupt or unparseable: treat as empty rather than throwing on every
    // heartbeat. The worst case is one extra sign-in.
    return {};
  }
}

function writeTabs(tabs: Record<string, number>) {
  try { localStorage.setItem(TABS_KEY, JSON.stringify(tabs)); } catch { /* quota / private mode */ }
}

function livingTabs(tabs: Record<string, number>, now: number): Record<string, number> {
  const alive: Record<string, number> = {};
  for (const [id, seen] of Object.entries(tabs)) {
    if (typeof seen === 'number' && now - seen < STALE_MS) alive[id] = seen;
  }
  return alive;
}

export function markActivity() {
  try { localStorage.setItem(ACTIVITY_KEY, String(Date.now())); } catch { /* ignore */ }
}

export function lastActivity(): number {
  const raw = Number(localStorage.getItem(ACTIVITY_KEY));
  return Number.isFinite(raw) && raw > 0 ? raw : Date.now();
}

/**
 * True when a token exists that NO live tab was holding — i.e. every tab died
 * without running its cleanup (browser crash, force quit, OS kill).
 *
 * Called once at startup, before this tab registers. Treating that token as
 * dead is the conservative reading: on a shared bench machine, a session left
 * behind by a crash is exactly the one that should not silently resume.
 */
export function isOrphanedSession(hasToken: boolean): boolean {
  if (!hasToken) return false;
  // A document, not a session. See isRenderSurface.
  if (isRenderSurface()) return false;

  const now = Date.now();
  const alive = Object.keys(livingTabs(readTabs(), now)).length > 0;
  if (alive) return false;                 // another tab is holding the session

  // No live tab. Either this is a reload of the only tab (the registry emptied
  // milliseconds ago) or the session genuinely ended.
  const closedAt = Number(localStorage.getItem(CLOSED_KEY));
  const wasReload = Number.isFinite(closedAt) && closedAt > 0 && now - closedAt <= REOPEN_GRACE_MS;

  try { localStorage.removeItem(CLOSED_KEY); } catch { /* ignore */ }
  return !wasReload;
}

/**
 * Register this tab and start the guards.
 *
 * @param onSignOut called when the session must end (last tab closing is
 *        handled inline; this fires for idle expiry and for a sign-out
 *        broadcast by another tab).
 * @param onLastTabClosing runs synchronously during unload when this is the
 *        final tab — it must do nothing async, because the page is going away.
 *        It must NOT clear the token: see REOPEN_GRACE_MS.
 */
export function startSessionGuard(opts: {
  onIdleExpired: () => void;
  onIdleWarning: (msRemaining: number) => void;
  onIdleCleared: () => void;
  onLastTabClosing: () => void;
}): () => void {
  const { onIdleExpired, onIdleWarning, onIdleCleared, onLastTabClosing } = opts;

  // A print page holds no session open and ends nobody's shift: it does not
  // register as a tab, and it has no idle clock because there is no one at it.
  // See isRenderSurface.
  if (isRenderSurface()) return () => { /* nothing was started */ };

  const beat = () => {
    const now = Date.now();
    const tabs = livingTabs(readTabs(), now);
    tabs[tabId] = now;
    writeTabs(tabs);
    // A live tab means the session is not in the "last tab closed" state.
    try { localStorage.removeItem(CLOSED_KEY); } catch { /* ignore */ }
  };
  beat();
  markActivity();

  const heartbeat = window.setInterval(beat, HEARTBEAT_MS);

  // Activity is shared: any tab's input resets the idle clock for all of them.
  // passive listeners so this never delays scrolling.
  const activityEvents = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;
  const onAny = () => markActivity();
  for (const e of activityEvents) window.addEventListener(e, onAny, { passive: true });

  let warned = false;
  const idleTimer = window.setInterval(() => {
    const idleFor = Date.now() - lastActivity();
    const remaining = IDLE_LIMIT_MS - idleFor;

    if (remaining <= 0) {
      onIdleExpired();
      return;
    }
    if (remaining <= IDLE_WARN_MS) {
      warned = true;
      onIdleWarning(remaining);
    } else if (warned) {
      // Activity in ANOTHER tab can pull us back from the brink.
      warned = false;
      onIdleCleared();
    }
  }, IDLE_TICK_MS);

  // pagehide, not beforeunload: beforeunload does not fire reliably on mobile
  // or when a tab is discarded, and pagehide covers the bfcache case too.
  const onHide = (e: PageTransitionEvent) => {
    // A bfcache-persisted page is not really closing; it may come back.
    if (e.persisted) return;

    const now = Date.now();
    const tabs = livingTabs(readTabs(), now);
    delete tabs[tabId];
    writeTabs(tabs);

    // Last one out. The token is NOT cleared here — this fires on an ordinary
    // reload too, and clearing it would sign the user out every refresh.
    // Instead the moment is recorded; isOrphanedSession decides on the next
    // startup whether a tab came back fast enough to have been a reload.
    if (Object.keys(tabs).length === 0) {
      try { localStorage.setItem(CLOSED_KEY, String(now)); } catch { /* ignore */ }
      onLastTabClosing();
    }
  };
  window.addEventListener('pagehide', onHide);

  return () => {
    window.clearInterval(heartbeat);
    window.clearInterval(idleTimer);
    for (const e of activityEvents) window.removeEventListener(e, onAny);
    window.removeEventListener('pagehide', onHide);
  };
}
