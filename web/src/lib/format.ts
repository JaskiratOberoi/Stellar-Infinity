/** Shared formatters. Indian locale throughout — this is an Indian lab. */

export const inr = (n: number) =>
  new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  }).format(n);

/**
 * Format an API timestamp for display.
 *
 * The API emits real +05:30 offsets (see the API's NobleTime), so these are
 * unambiguous instants and Intl can be trusted with them — no manual offset
 * arithmetic, which is where this kind of code usually goes wrong.
 */
export const fmtDate = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';

export const fmtDateTime = (iso: string | null | undefined) =>
  iso
    ? new Date(iso).toLocaleString('en-IN', {
        day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
      })
    : '—';

/** LIS age_type codes on the bill: 1 = years, 2 = months, 3 = days. */
export const fmtAge = (age: number | null, ageType: number | null) => {
  if (age == null) return '—';
  const unit = ageType === 2 ? 'mo' : ageType === 3 ? 'd' : 'y';
  return `${age}${unit}`;
};

/** LIS gender codes: 1 = male, anything else = female (the LIS is binary). */
export const fmtGender = (g: number | null) => (g == null ? '—' : g === 1 ? 'Male' : 'Female');

/* ---------- downloads ---------- */

/** What the API sends back when a bill still has money owed on it. */
export interface BalanceLocked {
  error: 'BALANCE_LOCKED';
  reason: 'patient' | 'client' | null;
  dueAmount: number;
}

export class ReportLockedError extends Error {
  constructor(public readonly lock: BalanceLocked) {
    super(
      `This report is on hold: ₹${Math.round(lock.dueAmount).toLocaleString('en-IN')} outstanding on the ` +
      `${lock.reason === 'client' ? 'client account' : "patient's bill"}. Clear the balance to release it.`,
    );
    this.name = 'ReportLockedError';
  }
}

/**
 * Pull a file from the API and hand it to the browser.
 *
 * Not a plain <a download href>: the session lives in an httpOnly cookie and
 * these routes can answer 423, so the response has to be inspected before
 * anything is saved. A navigation would show the operator a raw JSON error
 * page instead of a message they can act on.
 */
export async function downloadFile(
  url: string,
  init?: RequestInit & { fallbackName?: string },
): Promise<void> {
  const res = await fetch(url, { credentials: 'include', ...init });

  if (res.status === 423) throw new ReportLockedError(await res.json() as BalanceLocked);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(body.slice(0, 200) || `Download failed (HTTP ${res.status}).`);
  }

  // The API names the file in Content-Disposition; that name encodes the SID
  // and the batch size, so it is worth honouring rather than inventing one.
  const disposition = res.headers.get('content-disposition') ?? '';
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
  const name = match ? decodeURIComponent(match[1]) : (init?.fallbackName ?? 'download.pdf');

  const blob = await res.blob();
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoked on the next tick, not immediately: Safari has not finished reading
  // the blob when click() returns and saves a zero-byte file if it is pulled.
  setTimeout(() => URL.revokeObjectURL(href), 10_000);
}

/* ---------- LIS free text ---------- */

/**
 * The formatting tags the LIS actually emits, and nothing else.
 *
 * NOT a blanket /<[^>]*>/: reference ranges legitimately contain "<7 yrs" and
 * "<0.5", and a greedy stripper would swallow everything up to the next ">".
 */
const LIS_TAGS = /<\/?(?:b|i|u|em|strong|span|font|div|p|sub|sup)\b[^>]*>/gi;
const LIS_BREAKS = /<br\s*\/?>/gi;

const ENTITIES: Record<string, string> = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
};

/**
 * LIS free text, made printable.
 *
 * The LIS stores presentation inside its own data. A profile's test list comes
 * back looking like
 *
 *     Complete Blood Count (CBC)&nbsp;<i><b>[PROFILE 1.0]</b></i>,Blood Grouping
 *
 * — real tags and real entities, because the legacy UI dropped the column
 * straight into a table cell as HTML. React escapes instead of parsing, which
 * is the only correct default for third-party data, so those tags surface as
 * literal text. The markup is therefore REMOVED rather than honoured: nothing
 * here is ever handed to dangerouslySetInnerHTML, and the bracketed profile
 * name survives because it is information, unlike the <b> around it.
 *
 * This was invisible while the column was clipped to one line. It is not
 * invisible on a card, which prints the whole string.
 *
 * Order matters. Tags come off the RAW string first — decoding entities first
 * would turn "&lt;7 yrs" into "<7 yrs" and hand the stripper something that
 * looks like an opening tag.
 */
export function plainText(s: string | null | undefined): string {
  if (!s) return '';
  return s
    .replace(LIS_BREAKS, '\n')
    .replace(LIS_TAGS, '')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/&(\w+);/g, (m, name: string) => ENTITIES[name.toLowerCase()] ?? m)
    // Stripping a tag between a name and its comma leaves the comma stranded.
    .replace(/[^\S\n]+,/g, ',')
    // The CSV has no space after its separator, so on a card it wraps as one
    // unbroken 200-character word. Skipped before a digit: "1,25 Dihydroxy
    // Vitamin D" is a real analyte, not two of them.
    .replace(/,(?![\s\d])/g, ', ')
    // Horizontal whitespace only. Reference ranges carry real newlines between
    // their paediatric, pregnancy and newborn bands, and those are load-bearing.
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .trim();
}
