/**
 * Thin fetch wrapper for the Infinity API.
 *
 * AUTH IS A COOKIE, NOT A TOKEN THIS CODE CAN SEE. The JWT lives in an
 * httpOnly cookie set by the API; script cannot read it, so an XSS defect can
 * no longer steal a credential and replay it elsewhere. Nothing here stores or
 * forwards a token — the browser attaches the cookie, which is why every
 * request sets credentials: 'include'.
 *
 * The price of cookies is CSRF: they ride along on cross-site requests too. So
 * every unsafe method echoes the readable CSRF cookie in a header, which a
 * cross-origin page cannot do (it can cause our cookies to be SENT, but the
 * same-origin policy stops it READING them). The API compares the two.
 */

/** Readable-by-design; the httpOnly session cookie is the one that matters. */
const CSRF_COOKIE = 'inf_csrf';
const PRESENCE_COOKIE = 'inf_present';
const CSRF_HEADER = 'X-CSRF-Token';

function readCookie(name: string): string | null {
  const hit = document.cookie
    .split('; ')
    .find((c) => c.startsWith(name + '='));
  return hit ? decodeURIComponent(hit.slice(name.length + 1)) : null;
}

/**
 * The CSRF header for an unsafe request made OUTSIDE this client.
 *
 * The bulk PDF download is a POST that has to read its response as a blob, so
 * it goes through fetch directly rather than through api.post — but it is still
 * an unsafe method and still needs the echo, or the API rejects it. Exported
 * rather than reimplemented at the call site so there is one definition of what
 * the header is called and where its value comes from.
 */
export function csrfHeader(): Record<string, string> {
  const token = readCookie(CSRF_COOKIE);
  return token ? { [CSRF_HEADER]: token } : {};
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
  }
}

/**
 * Whether a session probably exists.
 *
 * The session cookie is httpOnly and therefore invisible here, so this reads a
 * separate non-secret marker the API sets alongside it. It carries NO
 * authority: forging it buys nothing but a failed /me call. Its only job is to
 * let the app show "restoring session" instead of flashing the login screen,
 * and to let the tab guard reason about whether there is anything to end.
 *
 * clear() cannot delete an httpOnly cookie from script — only the server can.
 * It drops the marker so the UI stops claiming a session, and the caller is
 * expected to hit /api/auth/logout to actually end it.
 */
export const tokenStore = {
  get: () => readCookie(PRESENCE_COOKIE),
  set: (_token: string) => { /* the API sets the cookies; nothing to store */ },
  clear: () => {
    document.cookie = `${PRESENCE_COOKIE}=; Path=/; Max-Age=0; SameSite=Strict`;
  },
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

interface RequestOptions extends RequestInit {
  /**
   * This request IS the credential check, not a call made with a session.
   *
   * A 401 means opposite things in the two cases. On an ordinary call it means
   * the session died — clear the token and bounce to the login screen. On the
   * login request itself there is no session to lose; 401 simply means the
   * username or password was wrong, and the server's own message should be
   * shown. Conflating them is why a mistyped password reported "Your session
   * has ended. Please sign in again." to someone who had never signed in.
   */
  isCredentialCheck?: boolean;
}

async function request<T>(path: string, init: RequestOptions = {}): Promise<T> {
  const { isCredentialCheck = false, ...fetchInit } = init;
  const headers = new Headers(fetchInit.headers);
  headers.set('Accept', 'application/json');
  if (fetchInit.body) headers.set('Content-Type', 'application/json');

  // Unsafe methods must prove they came from our own page — see the CSRF note
  // at the top. Safe methods change nothing and are exempt server-side.
  const method = (fetchInit.method ?? 'GET').toUpperCase();
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    const csrf = readCookie(CSRF_COOKIE);
    if (csrf) headers.set(CSRF_HEADER, csrf);
  }

  let res: Response;
  try {
    res = await fetch(path, {
      ...fetchInit,
      headers,
      // The session cookie only travels if this is set.
      credentials: 'include',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
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

  // Session expiry — but NOT when this request is the credential check itself.
  // See isCredentialCheck.
  if (res.status === 401 && !isCredentialCheck) {
    // Either never signed in, or the session was revoked server-side (role
    // change, password reset, deactivation). Both mean: sign in again.
    tokenStore.clear();
    onUnauthorized?.();
    throw new ApiError(401, 'Your session has ended. Please sign in again.');
  }

  // The rate limiter replies with an empty body, so the generic handler below
  // would render a bare "Request failed (429)". Someone locked out needs to
  // know it is a lockout and roughly how long it lasts.
  if (res.status === 429) {
    throw new ApiError(
      429,
      isCredentialCheck
        ? 'Too many sign-in attempts. Please wait about 15 minutes and try again.'
        : 'Too many requests. Please wait a moment and try again.',
    );
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
  /** No accessToken: the API delivers it as an httpOnly cookie instead. */
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
    // isCredentialCheck: a 401 here means "wrong username or password", not a
    // dead session — so the server's own message is shown and no token is
    // cleared. X-Login-User lets the API rate-limit per username+IP rather
    // than per IP alone, since whole collection centres share one NAT address.
    request<LoginResponse>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
      headers: { 'X-Login-User': username },
      isCredentialCheck: true,
    }),
  me: () => api.get<AuthenticatedUser>('/api/auth/me'),
  // Drops server-side state the token cannot clear by itself — today the
  // Jarvis unlock grant, so signing back in re-locks it.
  logout: () => api.post<{ ok: boolean }>('/api/auth/logout'),
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

export interface BusinessUnit {
  id: number;
  code: string | null;
  name: string | null;
}

export interface AutoAuthScopeRow {
  scopeType: string;
  scopeKey: string;
  label: string | null;
  /** Context only — the department is a property of the test, not a scope. */
  departmentName: string | null;
  /** Which lab the rule governs. null is the blanket "all units" rule. */
  businessUnitId: number | null;
  businessUnitName: string | null;
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
  businessUnitId: number | null;
  businessUnitName: string | null;
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
  list: (search: string, onlyEnabled = false, businessUnitId: number | null = null, page = 1, pageSize = 200) =>
    api.get<PagedResponse<AutoAuthScopeRow> & { featureEnabled: boolean }>(
      `/api/worksheet-settings/auto-auth/?search=${encodeURIComponent(search)}`
      + `&onlyEnabled=${onlyEnabled}&page=${page}&pageSize=${pageSize}`
      // Omitted entirely when null — the API reads a missing parameter as the
      // blanket "all units" rule, which is not the same as filtering.
      + (businessUnitId == null ? '' : `&businessUnitId=${businessUnitId}`),
    ),

  businessUnits: () =>
    api.get<{ units: BusinessUnit[] }>('/api/worksheet-settings/auto-auth/business-units'),

  /** Verify the unlock password without changing anything. Gates the screen. */
  unlock: (password: string) =>
    api.post<{ unlocked: boolean }>('/api/worksheet-settings/auto-auth/unlock', { password }),

  /** Is this session already through the gate? Survives a page refresh. */
  unlockStatus: () =>
    api.get<{ unlocked: boolean; featureEnabled: boolean }>('/api/worksheet-settings/auto-auth/unlock'),

  // The password travels in the body of a POST over TLS and is never stored by
  // the browser beyond the lifetime of the page — see AutoAuthSettings.
  set: (body: {
    scopeType: string;
    scopeKey: string;
    scopeLabel?: string | null;
    businessUnitId: number | null;
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

/* ---- ordering: catalogue, cart, order entry, accessioning ---- */

export interface CatalogItem {
  /** test | profile | master */
  kind: string;
  id: number;
  code: string | null;
  name: string | null;
  departmentName: string | null;
  mrp: number | null;
  /** What THIS client pays. Null means no price on record — not free. */
  rate: number | null;
  /** special | ratelist | mrp | none — why the rate is what it is. */
  rateSource: string;
}

export interface CartItem { kind: string; id: number; code: string | null; name: string | null }
export interface Cart { mcc: number | null; items: CartItem[] }

export interface SampleGroup {
  sampleTypeId: number;
  sampleTypeName: string | null;
  codes: string | null;
  names: string | null;
  requiresSplit: boolean;
  itemCount: number;
}

/**
 * Which prices an order is raised at.
 *
 * `b2c` — a walk-in. The basket is priced at the client's own rate: special
 * rate, else rate list, else MRP.
 * `b2b` — a client's order. The bill is raised at catalogue MRP, which is what
 * the patient pays the collection centre; the centre's own cost is the
 * rate-list price and the difference is its margin.
 */
export type OrderChannel = 'b2c' | 'b2b';

export interface OrderPreview {
  channel: OrderChannel;
  lines: {
    kind: string; id: number; code: string | null; name: string | null;
    /** What this line is billed at — MRP in B2B, the client's rate in B2C. */
    mrp: number | null; rate: number | null; rateSource: string;
    /** B2B only: what the centre owes the lab. Null in B2C, where it is `rate`. */
    clientCost: number | null;
    /** B2B only: mrp − clientCost. Negative means the centre loses on this line. */
    margin: number | null;
  }[];
  groups: SampleGroup[];
  total: number;
  /**
   * Over the lines that carry an MRP; `linesWithoutMrp` is how many were left
   * out. In B2C this is what the lab gives up against list price; in B2B it is
   * what the centre keeps.
   */
  margin: {
    amount: number; mrpTotal: number; rateTotal: number;
    comparableLines: number; linesWithoutMrp: number;
  };
  unpriced: number;
  /** B2B: lines with no MRP, which would go onto the bill at zero. */
  billedAtZero: number;
  /** B2B: lines where MRP is below the client's rate — the centre loses money. */
  belowCost: number;
}

export interface PlacedOrder {
  ok: boolean;
  errorCode: string | null;
  message: string | null;
  patientId: number | null;
  billId: number | null;
  billNumber: number | null;
  total: number;
  sampleCount: number;
  samples: { sampleId: number; vailid: string | null; sampleTypeId: number; sampleTypeName: string | null }[];
}

export const catalogApi = {
  search: (mcc: number | null, search: string, kind: string, page = 1, pageSize = 100) => {
    const p = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (mcc != null) p.set('mcc', String(mcc));
    if (search.trim()) p.set('search', search.trim());
    if (kind) p.set('kind', kind);
    return api.get<PagedResponse<CatalogItem>>(`/api/orders/catalog?${p}`);
  },
};

export const cartApi = {
  get: () => api.get<Cart>('/api/orders/cart/'),
  setClient: (mcc: number) => api.post<Cart>('/api/orders/cart/client', { mcc }),
  add: (item: CartItem) => api.post<Cart>('/api/orders/cart/items', item),
  remove: (kind: string, id: number) =>
    request<Cart>(`/api/orders/cart/items/${kind}/${id}`, { method: 'DELETE' }),
  clear: () => request<Cart>('/api/orders/cart/', { method: 'DELETE' }),
  // The channel travels on both: a preview quoted in one channel and an order
  // placed in the other would agree a total the bill then contradicts.
  preview: (channel: OrderChannel = 'b2c') =>
    api.post<OrderPreview>(`/api/orders/preview?channel=${channel}`),
  place: (body: unknown) => api.post<PlacedOrder>('/api/orders/', body),
};

export interface PendingAccession {
  billId: number;
  billNumber: number | null;
  billDate: string | null;
  patientId: number;
  patientName: string | null;
  mccCode: number | null;
  clientCode: string | null;
  total: number;
  balance: number;
  /** infinity | telo — which platform booked it. */
  origin: string;
  requiredGroups: number;
  haveGroups: number;
}

export interface PendingRegistration {
  sampleId: number;
  vailid: string | null;
  patientId: number;
  patientName: string | null;
  mccCode: number | null;
  clientCode: string | null;
  sampleStatus: number;
  sampleTypeName: string | null;
  testNames: string | null;
  addedAt: string | null;
  origin: string;
}

export const accessionApi = {
  // `kind` filters the queue by channel; omit for both.
  pending: (page = 1, pageSize = 100, kind?: OrderChannel) => {
    const p = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (kind) p.set('kind', kind);
    return api.get<PagedResponse<PendingAccession>>(`/api/accessioning/pending?${p}`);
  },
  unregistered: (page = 1, pageSize = 100) =>
    api.get<PagedResponse<PendingRegistration>>(
      `/api/accessioning/unregistered?page=${page}&pageSize=${pageSize}`),
  addSids: (patientId: number, mcc: number, sids: { sampleTypeId: number; vailid: string }[]) =>
    api.post<{ ok: boolean; samples: unknown[] }>('/api/accessioning/sids', { patientId, mcc, sids }),
  register: (vailids: string[]) =>
    api.post<{ ok: boolean; registered: number; skipped: number }>(
      '/api/accessioning/register', { vailids }),
};

export interface OrderTube {
  sampleTypeId: number;
  sampleTypeName: string | null;
  testNames: string | null;
  /** Already barcoded — do not offer a second label for this tube. */
  existingVailid: string | null;
}

/** The tubes ONE existing order needs. Not the cart preview, which answers a
 *  different question about the current user's own basket. */
export const orderTubesApi = {
  forPatient: (patientId: number) =>
    api.get<{ tubes: OrderTube[] }>(`/api/accessioning/tubes/${patientId}`),
};

/* ---- client accounts, ledger, billing ---- */

export interface ClientAccount {
  mccId: number;
  clientCode: string | null;
  clientName: string | null;
  isActive: boolean;
  /** Raw account value. NEGATIVE means the client owes the lab. */
  balance: number;
  /** The same number the way a person reads it: positive when money is due. */
  owed: number;
  totalDeposited: number;
  lastUpdatedAt: string | null;
}

export interface LedgerEntry {
  id: number;
  occurredAt: string | null;
  amount: number;
  /** debit (an order consumed credit) | credit (a payment came in) */
  direction: string;
  note: string | null;
  reference: string | null;
  addedBy: string | null;
  /** infinity | telo | lis */
  origin: string;
  postedAt: string | null;
}

/** Deposit types the LIS recognises, from tbl_med_mcc_account_detail.deposittype. */
export const PAYMENT_MODES = [
  { id: 3, label: 'Cash' },
  { id: 1, label: 'Cheque' },
  { id: 2, label: 'NEFT / transfer' },
  { id: 4, label: 'UPI' },
] as const;

export const accountsApi = {
  list: (search: string, onlyOwing: boolean, page = 1, pageSize = 100) => {
    const p = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (search.trim()) p.set('search', search.trim());
    if (onlyOwing) p.set('onlyOwing', 'true');
    return api.get<PagedResponse<ClientAccount> & { pageOwed: number }>(`/api/accounts/?${p}`);
  },
  ledger: (mcc: number, page = 1, pageSize = 100) =>
    api.get<PagedResponse<LedgerEntry>>(`/api/accounts/${mcc}/ledger?page=${page}&pageSize=${pageSize}`),
  pay: (mcc: number, body: { amount: number; mode: number; chequeNo?: string | null; reason?: string | null }) =>
    api.post<{ ok: boolean; newBalance: number | null; message: string | null }>(
      `/api/accounts/${mcc}/payments`, body),
};

export const billingApi = {
  receipt: (billId: number, body: { amount: number; payMode?: string; reference?: string | null }) =>
    api.post<{ ok: boolean; alreadyRecorded: boolean; balance: number | null; txnId: string | null }>(
      `/api/orders/${billId}/receipts`, body),
  voidReceipt: (billId: number, receiptId: number, reason: string | null) =>
    api.post<{ ok: boolean; alreadyVoided: boolean; balance: number | null }>(
      `/api/orders/${billId}/receipts/${receiptId}/void`, { reason }),
  editReceipt: (billId: number, receiptId: number, newAmount: number, reason: string | null) =>
    api.put<{ ok: boolean; unchanged: boolean; oldAmount: number | null; balance: number | null }>(
      `/api/orders/${billId}/receipts/${receiptId}`, { newAmount, reason }),
  discount: (billId: number, discount: number) =>
    api.put<{ ok: boolean; balance: number | null }>(`/api/orders/${billId}/discount`, { discount }),
};

/* ---- rate lists ---- */

export interface RateList {
  id: number;
  name: string | null;
  isActive: boolean;
  /** How many centres this list prices. Editing a rate re-prices all of them. */
  clientCount: number;
  pricedTests: number;
}

export interface RateListItem {
  id: number;
  code: string | null;
  name: string | null;
  departmentName: string | null;
  mrp: number | null;
  /** Null means no price here — the client falls through to MRP. */
  rate: number | null;
}

export const rateListApi = {
  list: (search = '') =>
    api.get<{ rows: RateList[] }>(`/api/rate-lists/?search=${encodeURIComponent(search)}`),
  items: (id: number, search: string, filter: string, page = 1, pageSize = 100) => {
    const p = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (search.trim()) p.set('search', search.trim());
    if (filter) p.set('filter', filter);
    return api.get<PagedResponse<RateListItem>>(`/api/rate-lists/${id}/items?${p}`);
  },
  create: (name: string) =>
    api.post<{ ok: boolean; rateTypeId: number | null; seededCount: number; message: string | null }>(
      '/api/rate-lists/', { name }),
  setRate: (id: number, testId: number, price: number) =>
    api.put<{ ok: boolean }>(`/api/rate-lists/${id}/rates/${testId}`, { price }),
};
