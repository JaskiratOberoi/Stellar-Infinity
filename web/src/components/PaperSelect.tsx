import { useEffect, useMemo, useRef, useState } from 'react';
import { letterheadApi, type PaperOptionsResponse } from '../api/client';

/**
 * Which paper the report is printed on — the one question behind every
 * report download, asked once and remembered.
 *
 * The LIS asked it as two buttons, "With Header" / "Without Header", and
 * Infinity's first cut kept that shape as a Letterhead toggle. But "without
 * header" hides a second question: WHOSE stationery? Noble's own pre-printed
 * sheets have a 23mm header band; a client's letterhead runs to 40mm. One
 * toggle could only say "no artwork, 40mm", so a report printed on Noble
 * paper started a hand's width below the printed header. Three answers:
 *
 *  letterhead  Noble's header and footer IN the PDF, for plain paper and
 *              anything sent digitally. 23/28mm margins.
 *  noble       no artwork, the same 23/28mm — pre-printed Noble stationery.
 *  plain       no artwork, 40/40mm — a client's own letterhead.
 *
 * And a fourth kind: `lh:{id}`, a client's own letterhead profile set up in
 * Admin → Letterheads — its measured margins, and its artwork in the PDF when
 * it is a digital one. Which of those a user sees comes from the API
 * (/api/letterheads/options): the lab sees every profile, a client only its
 * own, and a client with its own letterhead starts on it.
 *
 * The API and the print route both take the same key (?paper=), so what the
 * preview shows and what the PDF lays out for is one decision.
 *
 * A lab settles on one kind of paper for months at a time, so the answer is a
 * remembered preference — one localStorage key read by Worksheet, Reporting
 * and both viewers — rather than a per-download question. The PID menu is the
 * exception and offers every paper per click, because one patient's report
 * goes to a portal and the next to the printer.
 */
export type Paper = 'letterhead' | 'noble' | 'plain' | `lh:${number}`;

export interface PaperOption { value: Paper; label: string; hint: string; kind?: 'digital' | 'stationery' }

export const PAPER_OPTIONS: ReadonlyArray<PaperOption> = [
  {
    value: 'letterhead',
    label: 'With Letterhead',
    hint: "Noble's header and footer are in the PDF. For plain paper, email and WhatsApp.",
  },
  {
    value: 'noble',
    label: 'Without Letterhead',
    hint: "No artwork; the report starts just under the printed header. For Noble's pre-printed stationery.",
  },
  {
    value: 'plain',
    label: 'Client Letterhead 40mm',
    hint: "No artwork; a 40 mm band is left clear at the head and foot. For a client's own stationery.",
  },
];

const LH_RE = /^lh:[1-9]\d{0,8}$/;

export function isPaper(v: unknown): v is Paper {
  return v === 'letterhead' || v === 'noble' || v === 'plain' || (typeof v === 'string' && LH_RE.test(v));
}

/** The profile id in a `lh:{id}` paper, else null. */
export function letterheadIdOf(p: string | null | undefined): number | null {
  return p && LH_RE.test(p) ? Number(p.slice(3)) : null;
}

/* ---- the options, per set of clients, fetched once per page load ----------
   A client's letterhead is offered only on that client's reports, so the
   options depend on WHOSE reports the picker is for: MDCARE's letterhead on
   an MDCARE report, never on HR0121's. The API applies the same rule to the
   download itself (LetterheadPapers), so this is what the operator sees, not
   the only guard. */

/** The clients a picker is for, as the API and the cache key want them. */
export function clientKey(clients?: ReadonlyArray<string | null | undefined>): string {
  return [...new Set((clients ?? []).map((c) => (c ?? '').trim().toUpperCase()).filter(Boolean))].sort().join(',');
}

const optionsCache = new Map<string, Promise<PaperOptionsResponse | null>>();
function loadOptions(key: string): Promise<PaperOptionsResponse | null> {
  let p = optionsCache.get(key);
  if (!p) {
    p = letterheadApi.options(key).catch(() => { optionsCache.delete(key); return null; });
    optionsCache.set(key, p);
  }
  return p;
}

function toOptions(r: PaperOptionsResponse | null): PaperOption[] {
  if (!r) return [...PAPER_OPTIONS];
  const out: PaperOption[] = [];
  for (const o of r.options) {
    const builtIn = PAPER_OPTIONS.find((b) => b.value === o.value);
    if (builtIn) out.push(builtIn);
    else if (isPaper(o.value)) {
      const digital = /\(digital\)$/.test(o.label);
      out.push({
        value: o.value,
        label: o.label,
        kind: digital ? 'digital' : 'stationery',
        hint: digital
          ? 'This client\'s own letterhead is in the PDF, on its own margins.'
          : 'No artwork; laid out for this client\'s pre-printed stationery, on its measured margins.',
      });
    }
  }
  return out.length ? out : [...PAPER_OPTIONS];
}

/** Every paper this user may choose for these clients' reports: Noble's, then
 *  the letterhead those clients are assigned to, if they share one. */
export function usePaperOptions(clients?: ReadonlyArray<string | null | undefined>): {
  options: PaperOption[]; defaultPaper: Paper | null; loaded: boolean;
} {
  const key = clientKey(clients);
  const [state, setState] = useState<{ key: string; r: PaperOptionsResponse | null } | null>(null);
  useEffect(() => {
    let live = true;
    void loadOptions(key).then((r) => { if (live) setState({ key, r }); });
    return () => { live = false; };
  }, [key]);
  const current = state && state.key === key ? state : null;
  const options = useMemo(() => toOptions(current?.r ?? null), [current]);
  const d = current?.r?.defaultPaper;
  return { options, defaultPaper: isPaper(d) ? d : null, loaded: current !== null };
}

/* Same key the Letterhead toggle used, so nobody's remembered choice is lost:
   its '1' (artwork on) and '0' (artwork off, 40mm) map onto the two modes that
   reproduce exactly what those values printed. A choice made since client
   letterheads arrived lives under CHOSEN: until a client account picks
   something itself, it starts on its own letterhead. */
const KEY = 'inf.report-letterhead';
const CHOSEN = 'inf.report-paper.chosen';

function readStored(): { paper: Paper; chosen: boolean } {
  try {
    const chosen = localStorage.getItem(CHOSEN) === '1';
    const v = localStorage.getItem(KEY);
    if (isPaper(v)) return { paper: v, chosen };
    if (v === '0') return { paper: 'plain', chosen };
    return { paper: 'letterhead', chosen };
  } catch {
    return { paper: 'letterhead', chosen: false };
  }
}

/**
 * The paper for these clients' reports. The remembered preference is kept as
 * chosen, and what comes back is what it means HERE: a client letterhead
 * chosen on an MDCARE report reads as Noble's letterhead on HR0121's, and
 * comes back when the next MDCARE report opens.
 */
export function usePaper(clients?: ReadonlyArray<string | null | undefined>): [Paper, (v: Paper) => void] {
  const [stored] = useState(readStored);
  const [pref, setPref] = useState<Paper>(stored.paper);
  const chosen = useRef(stored.chosen);
  const { options, defaultPaper, loaded } = usePaperOptions(clients);

  // A client account that has never picked starts on its own letterhead; a
  // preference this report cannot take (another client's letterhead, a
  // retired one) falls back to that default, else Noble's letterhead.
  const paper: Paper = !loaded
    ? (letterheadIdOf(pref) == null ? pref : 'letterhead')
    : !chosen.current && defaultPaper
      ? defaultPaper
      : options.some((o) => o.value === pref)
        ? pref
        : defaultPaper ?? 'letterhead';

  const setPaper = (v: Paper) => {
    chosen.current = true;
    setPref(v);
    try {
      localStorage.setItem(KEY, v);
      localStorage.setItem(CHOSEN, '1');
    } catch { /* private mode */ }
  };
  return [paper, setPaper];
}

export function PaperSelect({ value, onChange, disabled, className, ariaLabel, clients }: {
  value: Paper;
  onChange: (v: Paper) => void;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
  /** Whose reports this is for — the same list given to usePaper. */
  clients?: ReadonlyArray<string | null | undefined>;
}) {
  const { options } = usePaperOptions(clients);
  const noble = options.filter((o) => !letterheadIdOf(o.value));
  const clientRows = options.filter((o) => letterheadIdOf(o.value));
  const current = options.find((o) => o.value === value) ?? options[0];
  const row = (o: PaperOption) => <option key={o.value} value={o.value} title={o.hint}>{o.label}</option>;
  return (
    <select
      className={className ?? 'input input--sm'}
      value={value}
      disabled={disabled}
      aria-label={ariaLabel ?? 'Paper'}
      title={current?.hint}
      onChange={(e) => { if (isPaper(e.target.value)) onChange(e.target.value); }}
    >
      {clientRows.length === 0 ? noble.map(row) : (
        <>
          <optgroup label="Client letterhead">{clientRows.map(row)}</optgroup>
          <optgroup label="Noble">{noble.map(row)}</optgroup>
        </>
      )}
    </select>
  );
}
