import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { authApi, setUnauthorizedHandler, tokenStore, type AuthenticatedUser } from '../api/client';
import { isOrphanedSession, markActivity, startSessionGuard } from './sessionGuard';

interface AuthState {
  user: AuthenticatedUser | null;
  loading: boolean;
  signIn: (username: string, password: string) => Promise<void>;
  /**
   * Two-stage sign-in for the login transition. Performs the credential check
   * and returns a COMMIT function; nothing user-visible changes until commit
   * is called. The login screen needs this because setting `user` unmounts it
   * instantly — the card-to-logo animation has to finish first, then commit.
   */
  signInDeferred: (username: string, password: string) => Promise<() => void>;
  /** True from commit until the entrance transition finishes. */
  entering: boolean;
  finishEntering: () => void;
  signOut: () => void;
  can: (capability: string) => boolean;
  /** Seconds left before an idle sign-out, or null when not near the limit. */
  idleSecondsLeft: number | null;
  /** Called by the warning banner's "stay signed in" button. */
  staySignedIn: () => void;
  /** Why the last sign-out happened, so the login screen can explain itself. */
  signedOutReason: string | null;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthenticatedUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [entering, setEntering] = useState(false);
  const [idleSecondsLeft, setIdleSecondsLeft] = useState<number | null>(null);
  const [signedOutReason, setSignedOutReason] = useState<string | null>(null);

  // Read by the unload handler, which cannot call hooks or read stale state.
  const signedInRef = useRef(false);
  useEffect(() => { signedInRef.current = user !== null; }, [user]);

  const signOut = useCallback((reason: string | null = null) => {
    // The session cookie is httpOnly, so ONLY the server can remove it —
    // clearing local state alone would leave a usable credential in the
    // browser. Not awaited, because the UI must not hang on the network to
    // sign out; the local state is dropped either way and the cookie's own
    // session lifetime is the backstop.
    void authApi.logout().catch(() => { /* ignore */ });
    tokenStore.clear();
    setUser(null);
    setEntering(false);
    setIdleSecondsLeft(null);
    setSignedOutReason(reason);
  }, []);

  const finishEntering = useCallback(() => setEntering(false), []);

  // A 401 from anywhere in the app means the token is gone or revoked.
  useEffect(() => {
    setUnauthorizedHandler(() => setUser(null));
  }, []);

  // Restore a session on reload. The token may have been revoked server-side
  // while the tab was closed, so /me is the authority — never trust the cached
  // token's own claims.
  useEffect(() => {
    // A token with no live tab behind it was left by a crash or a force-quit,
    // not by a user who is still working. On a shared bench machine that is
    // exactly the session that must not silently resume.
    if (isOrphanedSession(!!tokenStore.get())) {
      // Only the server can drop an httpOnly cookie, so ending an orphaned
      // session means asking it to — clearing the local marker alone would
      // leave the credential alive in the browser.
      tokenStore.clear();
      void authApi.logout().catch(() => { /* ignore */ });
      setLoading(false);
      return;
    }

    if (!tokenStore.get()) {
      setLoading(false);
      return;
    }
    authApi
      .me()
      .then(setUser)
      .catch(() => tokenStore.clear())
      .finally(() => setLoading(false));
  }, []);

  // ---- session lifetime: last tab out, and idle expiry -------------------
  useEffect(() => {
    const stop = startSessionGuard({
      onIdleExpired: () => {
        if (signedInRef.current) signOut('You were signed out after 45 minutes of inactivity.');
      },
      onIdleWarning: (msLeft) => {
        if (signedInRef.current) setIdleSecondsLeft(Math.max(0, Math.round(msLeft / 1000)));
      },
      onIdleCleared: () => setIdleSecondsLeft(null),
      onLastTabClosing: () => {
        // sendBeacon is the only thing that survives unload reliably; a fetch
        // is cancelled as the page goes. Not used here on purpose, though —
        // this also fires on an ordinary reload, and logging out on refresh is
        // exactly the bug the grace window exists to avoid. The marker is
        // dropped so a returning tab knows to re-check, and the real teardown
        // happens at the next startup via isOrphanedSession.
        // Deliberately does NOT clear the token: this fires on a plain reload
        // of the only tab as well as on a real close, and the two are
        // indistinguishable at this moment. sessionGuard timestamps the event
        // and isOrphanedSession decides at the next startup — a tab that comes
        // back within the grace window was a refresh, anything later is a new
        // session and the token is discarded then.
      },
    });
    return stop;
  }, [signOut]);

  const staySignedIn = useCallback(() => {
    markActivity();
    setIdleSecondsLeft(null);
  }, []);

  // The credential check runs NOW (so a wrong password errors while the form
  // is still on screen), but the token store and user state change only when
  // the returned commit runs. Everything is deferred to commit so a transition
  // abandoned mid-way — user closes the tab during the animation — leaves no
  // half-signed-in state behind.
  const signInDeferred = useCallback(async (username: string, password: string) => {
    const res = await authApi.login(username, password);
    return () => {
      // Nothing to store: the API set the session cookie on this response.
      setUser(res.user);
      setEntering(true);
      setSignedOutReason(null);
      markActivity();       // a fresh sign-in restarts the idle clock
    };
  }, []);

  const signIn = useCallback(async (username: string, password: string) => {
    (await signInDeferred(username, password))();
  }, [signInDeferred]);

  const can = useCallback(
    // Both links optional-chained. `user` without `capabilities` should not be
    // reachable, but `can` is called during the first render of nearly every
    // screen and there is no error boundary above them — so a payload missing
    // the array does not fail one permission check, it white-screens the whole
    // application. Denying is the safe reading of "no capabilities".
    (capability: string) => user?.capabilities?.includes(capability) ?? false,
    [user],
  );

  const value = useMemo(
    () => ({
      user, loading, signIn, signInDeferred, entering, finishEntering,
      signOut: () => signOut(null), can, idleSecondsLeft, staySignedIn, signedOutReason,
    }),
    [user, loading, signIn, signInDeferred, entering, finishEntering, signOut, can,
     idleSecondsLeft, staySignedIn, signedOutReason],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
