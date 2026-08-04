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

/* ---- worksheet ---- */

export interface WorksheetSampleHeader {
  sid: string;
  pid: number;
  patientName: string | null;
  sex: string | null;
  age: number | null;
  ageUnit: string | null;
  clientCode: string | null;
  shortName: string | null;
  orderNumber: string | null;
  billNumber: string | null;
  sampleDrawn: string | null;
  registeredAt: string | null;
  lastModifiedAt: string | null;
  statusCode: number | null;
  status: string | null;
  sampleComments: string | null;
  sampleClinicalHistory: string | null;
  patientClinicalHistory: string | null;
  rejectComments: string | null;
  authorisedBy: number | null;
  authorisedByUsername: string | null;
  signatureId: number | null;
  signatoryName: string | null;
  signatoryDesignation: string | null;
  isEditable: boolean;
  needsReopen: boolean;
  isRejected: boolean;
}

export interface WorksheetResultRow {
  resultId: number;
  testId: number | null;
  paramId: number | null;
  testCode: string | null;
  testName: string | null;
  /** Test | Param | Head | Profile — the last two are display scaffolding. */
  testType: string | null;
  value: string | null;
  unit: string | null;
  /** The frozen display string that the report prints. */
  normalRange: string | null;
  /** Live numeric bounds for THIS patient's age and sex, or null if undefined. */
  rangeLow: number | null;
  rangeHigh: number | null;
  abnormal: boolean;
  authorized: boolean;
  comments: string | null;
  profileId: number | null;
  masterProfileId: number | null;
  machineName: string | null;
  enteredBy: string | null;
  enteredAt: string | null;
  updatedBy: string | null;
  updatedAt: string | null;
  hasAttachment: boolean;
  departmentCode: string | null;
  departmentName: string | null;
  departmentId: number | null;
  codedOptions: string[];
  isNumericRange: boolean;
  /** A configured rule would sign this row automatically once it is in range. */
  autoAuthEligible: boolean;
}

export interface AutoAuthRuleInForce {
  scopeType: string;
  scopeKey: string;
  scopeLabel: string | null;
  requireInRange: boolean;
  allowOutOfRange: boolean;
  numericOnly: boolean;
}

export interface WorksheetPermissions {
  canEnter: boolean;
  canAmend: boolean;
  canAuthorize: boolean;
  canReopen: boolean;
  canReject: boolean;
}

export interface WorksheetSampleResponse {
  header: WorksheetSampleHeader;
  rows: WorksheetResultRow[];
  autoAuthRules: AutoAuthRuleInForce[];
  permissions: WorksheetPermissions;
}

/**
 * One edit. `value`/`comments` use null to mean "not touched" and "" to mean
 * "clear it" — the distinction survives all the way into the SQL table type,
 * so an untouched row can never wipe a value someone else entered since the
 * page loaded.
 *
 * There is deliberately no `abnormal`: the flag is derived server-side from the
 * reference ranges and anything a client sent would be ignored.
 */
export interface ResultEdit {
  resultId: number;
  value?: string | null;
  comments?: string | null;
  setAuth?: boolean | null;
  reason?: string | null;
}

export interface SaveResultsOutcome {
  applied: number;
  autoAuthorized: number;
  statusBefore: number | null;
  statusAfter: number | null;
}

export interface ResultAuditRow {
  id: number;
  resultId: number | null;
  testName: string | null;
  testCode: string | null;
  action: string;
  field: string | null;
  oldValue: string | null;
  newValue: string | null;
  reason: string | null;
  actorUsername: string | null;
  actorIp: string | null;
  source: string;
  occurredAt: string;
}

export interface AutoAuthScopeRow {
  scopeType: string;
  scopeKey: string;
  label: string | null;
  departmentName: string | null;
  enabled: boolean;
  requireInRange: boolean;
  allowOutOfRange: boolean;
  numericOnly: boolean;
  updatedAt: string | null;
  updatedByUsername: string | null;
}

export interface AutoAuthAuditRow {
  id: number;
  action: string;
  scopeType: string | null;
  scopeKey: string | null;
  scopeLabel: string | null;
  oldEnabled: boolean | null;
  newEnabled: boolean | null;
  detail: string | null;
  actorUsername: string | null;
  actorIp: string | null;
  occurredAt: string;
}

export interface TrendPoint {
  value: string | null;
  sid: string | null;
  drawnAt: string | null;
  isCurrent: boolean;
}

export interface AnalyteTrend {
  /** "testid:paramid" — the only field that identifies one analyte. `testCode`
   *  names the panel and repeats across every parameter within it. */
  testKey: string;
  testCode: string | null;
  testName: string | null;
  unit: string | null;
  points: TrendPoint[];
}

/**
 * How the prior visits were identified.
 *
 * `matchedOn` is rendered, not hidden: a trend built from a cross-visit guess
 * is only safe to act on if the person reading it can see how the guess was
 * made. `hasMobile: false` means no cross-visit lookup was even possible.
 */
export interface TrendMatch {
  matchedOn: 'visit' | 'name+mobile+gender' | 'none';
  priorVisits: number;
  hasMobile: boolean;
}

export interface ResultTrendResponse {
  match: TrendMatch;
  analytes: AnalyteTrend[];
}

/**
 * The shape every list endpoint returns.
 *
 * `total` is the whole matching set; `count` is only what came back in this
 * response. Screens must render `total` and drive their pager from it — asking
 * "did I get a full page?" is not a reliable way to learn whether more exists.
 */
export interface PagedResponse<T> {
  rows: T[];
  count: number;
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

export const worksheetApi = {
  getSample: (sid: string) =>
    api.get<WorksheetSampleResponse>(`/api/worksheet/${encodeURIComponent(sid)}`),

  saveResults: (
    sid: string,
    edits: ResultEdit[],
    sampleComments?: string | null,
    sampleClinicalHistory?: string | null,
  ) =>
    api.post<SaveResultsOutcome>(`/api/worksheet/${encodeURIComponent(sid)}/results`, {
      edits,
      sampleComments: sampleComments ?? null,
      sampleClinicalHistory: sampleClinicalHistory ?? null,
    }),

  reopen: (sid: string, reason: string) =>
    api.post<{ statusBefore: number; statusAfter: number }>(
      `/api/worksheet/${encodeURIComponent(sid)}/reopen`,
      { reason },
    ),

  audit: (sid: string, page = 1, pageSize = 200) =>
    api.get<PagedResponse<ResultAuditRow>>(
      `/api/worksheet/${encodeURIComponent(sid)}/audit?page=${page}&pageSize=${pageSize}`,
    ),

  trend: (sid: string, maxPoints = 12) =>
    api.get<ResultTrendResponse>(
      `/api/worksheet/${encodeURIComponent(sid)}/trend?maxPoints=${maxPoints}`,
    ),
};

export const autoAuthApi = {
  list: (search: string, onlyEnabled = false, page = 1, pageSize = 200) =>
    api.get<PagedResponse<AutoAuthScopeRow> & { featureEnabled: boolean }>(
      `/api/worksheet-settings/auto-auth/?search=${encodeURIComponent(search)}`
      + `&onlyEnabled=${onlyEnabled}&page=${page}&pageSize=${pageSize}`,
    ),

  // The password travels in the body of a POST over TLS and is never stored by
  // the browser beyond the lifetime of the page — see AutoAuthSettings.
  set: (body: {
    scopeType: string;
    scopeKey: string;
    scopeLabel?: string | null;
    enabled: boolean;
    requireInRange: boolean;
    allowOutOfRange: boolean;
    password: string;
  }) => api.post<{ scopeType: string; scopeKey: string; enabled: boolean }>(
    '/api/worksheet-settings/auto-auth/',
    body,
  ),

  audit: (page = 1, pageSize = 100) =>
    api.get<PagedResponse<AutoAuthAuditRow>>(
      `/api/worksheet-settings/auto-auth/audit?page=${page}&pageSize=${pageSize}`,
    ),
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
