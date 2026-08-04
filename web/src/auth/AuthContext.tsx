import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { authApi, setUnauthorizedHandler, tokenStore, type AuthenticatedUser } from '../api/client';

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
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthenticatedUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [entering, setEntering] = useState(false);

  const signOut = useCallback(() => {
    tokenStore.clear();
    setUser(null);
    setEntering(false);
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

  // The credential check runs NOW (so a wrong password errors while the form
  // is still on screen), but the token store and user state change only when
  // the returned commit runs. Everything is deferred to commit so a transition
  // abandoned mid-way — user closes the tab during the animation — leaves no
  // half-signed-in state behind.
  const signInDeferred = useCallback(async (username: string, password: string) => {
    const res = await authApi.login(username, password);
    return () => {
      tokenStore.set(res.accessToken);
      setUser(res.user);
      setEntering(true);
    };
  }, []);

  const signIn = useCallback(async (username: string, password: string) => {
    (await signInDeferred(username, password))();
  }, [signInDeferred]);

  const can = useCallback(
    (capability: string) => user?.capabilities.includes(capability) ?? false,
    [user],
  );

  const value = useMemo(
    () => ({ user, loading, signIn, signInDeferred, entering, finishEntering, signOut, can }),
    [user, loading, signIn, signInDeferred, entering, finishEntering, signOut, can],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
