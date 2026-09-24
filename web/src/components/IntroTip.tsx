import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';

/**
 * An introductory tip: a small bubble that points at a control the first
 * times an account signs in after the control shipped — the dark-mode
 * switch, the report format selector — so the feature is noticed rather
 * than found by accident.
 *
 * The rule (Jas, 2026-09-24): each account sees a tip on at most TWO
 * sign-ins, then never again; "Got it" closes it for the session. The count
 * lives on the server per account (inf_user_tip), so it follows the user
 * across desks and devices. Within one session the bubble is counted once
 * and, once dismissed, stays away — both remembered in sessionStorage keyed
 * by the account, so a second login in the same tab starts a new session.
 *
 * Anchored to its child: the wrapper is positioned, the bubble is absolute
 * beside it. Nothing here blocks the control — the child is clickable with
 * the bubble open.
 */

interface TipState { tips: Record<string, number>; max: number }

// One fetch per page load, shared by every tip on the page.
let cache: Promise<TipState> | null = null;
function loadTips(): Promise<TipState> {
  cache ??= api.get<TipState>('/api/me/tips').catch(() => ({ tips: {}, max: 0 }));
  return cache;
}
/** Forget the fetched counts — called on sign-out so the next account fetches its own. */
export function resetIntroTips(): void { cache = null; }

export function IntroTip({ id, text, side = 'below', children }: {
  id: 'dark-mode' | 'report-format';
  text: string;
  /** Where the bubble sits relative to the control. */
  side?: 'below' | 'below-end' | 'above';
  children: ReactNode;
}) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const who = user?.username ?? 'anon';
  const dismissedKey = `inf.tip.${who}.${id}.dismissed`;
  const countedKey = `inf.tip.${who}.${id}.counted`;

  useEffect(() => {
    if (!user) return;
    let alive = true;
    const read = (k: string) => { try { return sessionStorage.getItem(k); } catch { return null; } };
    const write = (k: string) => { try { sessionStorage.setItem(k, '1'); } catch { /* private mode */ } };
    if (read(dismissedKey)) return;
    void loadTips().then((state) => {
      if (!alive) return;
      const shown = state.tips[id] ?? 0;
      const counted = !!read(countedKey);
      // Shown this session already (counted) — keep showing until dismissed.
      // Not yet counted — only if the account still has a showing left.
      if (!counted && shown >= state.max) return;
      setOpen(true);
      if (!counted) {
        write(countedKey);
        state.tips[id] = shown + 1;
        void api.post(`/api/me/tips/${id}/shown`, {}).catch(() => { /* the count is a courtesy */ });
      }
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.username, id]);

  const dismiss = () => {
    try { sessionStorage.setItem(dismissedKey, '1'); } catch { /* private mode */ }
    setOpen(false);
  };

  return (
    <span className={`introtip${open ? ' introtip--open' : ''}`}>
      {children}
      {open && (
        <span className={`introtip__bubble introtip__bubble--${side}`} role="status">
          <span className="introtip__tag">New</span>
          <span className="introtip__text">{text}</span>
          <button type="button" className="introtip__ok" onClick={dismiss}>Got it</button>
        </span>
      )}
    </span>
  );
}
