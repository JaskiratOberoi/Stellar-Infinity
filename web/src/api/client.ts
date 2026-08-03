/**
 * Thin fetch wrapper for the Infinity API.
 *
 * Token storage: sessionStorage, so the token dies with the tab and is not
 * shared across windows. This is still readable by any script on the page, so
 * it is only as safe as the app is free of XSS. The stronger option is an
 * httpOnly cookie, which needs the API to set it and a CSRF strategy — worth
 * doing before this handles patient data in production.
 */

const TOKEN_KEY = 'infinity.token';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
  }
}

export const tokenStore = {
  get: () => sessionStorage.getItem(TOKEN_KEY),
  set: (token: string) => sessionStorage.setItem(TOKEN_KEY, token),
  clear: () => sessionStorage.removeItem(TOKEN_KEY),
};

/** Called when the API rejects our token, so the shell can bounce to /login. */
let onUnauthorized: (() => void) | null = null;
export const setUnauthorizedHandler = (fn: () => void) => {
  onUnauthorized = fn;
};

/**
 * Requests are bounded. Without this, an unreachable API leaves the UI spinning
 * forever with no explanation — fetch has no default timeout, and a dev server
 * that has stopped accepts nothing and reports nothing.
 */
const TIMEOUT_MS = 20_000;

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = tokenStore.get();
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  if (init.body) headers.set('Content-Type', 'application/json');
  if (token) headers.set('Authorization', `Bearer ${token}`);

  let res: Response;
  try {
    res = await fetch(path, { ...init, headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    // Network-level failure: server down, DNS, CORS, or our own timeout.
    // Distinguish it from an HTTP error so the message is actionable rather
    // than a bare "failed to fetch".
    const timedOut = err instanceof DOMException && err.name === 'TimeoutError';
    throw new ApiError(
      0,
      timedOut
        ? `The server did not respond within ${TIMEOUT_MS / 1000}s.`
        : 'Cannot reach the Infinity API. Is it running?',
    );
  }

  if (res.status === 401) {
    // Either never signed in, or the session was revoked server-side (role
    // change, password reset, deactivation). Both mean: sign in again.
    tokenStore.clear();
    onUnauthorized?.();
    throw new ApiError(401, 'Your session has ended. Please sign in again.');
  }

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const message =
      (body && typeof body === 'object' && ('error' in body || 'detail' in body)
        ? String((body as Record<string, unknown>).error ?? (body as Record<string, unknown>).detail)
        : null) ?? `Request failed (${res.status})`;
    throw new ApiError(res.status, message, body);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown, headers?: Record<string, string>) =>
    request<T>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined, headers }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PUT', body: body ? JSON.stringify(body) : undefined }),
};

/* ---- types mirrored from the API ---- */

export interface AuthenticatedUser {
  userId: number;
  username: string;
  displayName: string | null;
  email: string | null;
  role: string;
  capabilities: string[];
  usertypeId: number | null;
  usertypeName: string | null;
  /** infinity | telo | lis */
  managedBy: string;
  lisAccess: boolean;
}

export interface LoginResponse {
  accessToken: string;
  expiresAt: string;
  user: AuthenticatedUser;
}

export interface AdminUserRow {
  userId: number;
  username: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  usertypeId: number | null;
  usertypeName: string | null;
  lisIsActive: boolean;
  managedBy: 'infinity' | 'telo' | 'lis';
  infinityActive: boolean | null;
  infinityLisAccess: boolean | null;
  infinityRole: string | null;
  effectiveRole: string;
  sessionVersion: number;
}

export interface AdminUserPage {
  users: AdminUserRow[];
  totalCount: number;
}

export const authApi = {
  login: (username: string, password: string) =>
    // X-Login-User lets the API rate-limit per username+IP rather than per IP
    // alone — whole collection centres share one NAT address.
    api.post<LoginResponse>('/api/auth/login', { username, password }, { 'X-Login-User': username }),
  me: () => api.get<AuthenticatedUser>('/api/auth/me'),
};

export const adminApi = {
  listUsers: (search: string, page = 1, pageSize = 50) =>
    api.get<AdminUserPage>(
      `/api/admin/users?search=${encodeURIComponent(search)}&page=${page}&pageSize=${pageSize}`,
    ),
  roles: () => api.get<{ role: string; capabilities: string[] }[]>('/api/admin/roles'),
  createUser: (body: {
    username: string;
    password: string;
    firstName: string;
    lastName?: string;
    email?: string;
    lisUsertypeId: number;
    infinityRole: string;
    grantLisAccess: boolean;
  }) => api.post<{ userId: number }>('/api/admin/users', body),
  setLisAccess: (userId: number, enabled: boolean) =>
    api.put<void>(`/api/admin/users/${userId}/lis-access`, { enabled }),
  setActive: (userId: number, enabled: boolean) =>
    api.put<void>(`/api/admin/users/${userId}/active`, { enabled }),
  setRole: (userId: number, role: string) => api.put<void>(`/api/admin/users/${userId}/role`, { role }),
  resetPassword: (userId: number, password: string) =>
    api.put<void>(`/api/admin/users/${userId}/password`, { password }),
};
