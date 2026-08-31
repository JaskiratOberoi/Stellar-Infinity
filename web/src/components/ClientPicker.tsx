import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { api } from '../api/client';

export interface ClientOption {
  id: number;
  code: string;
  name: string | null;
  isActive: boolean;
}

interface FiltersResponse {
  departments: unknown[];
  businessUnits: unknown[];
  rows: ClientOption[];
}

/**
 * The client list, fetched once per page load and shared by every picker on it.
 *
 * Scoped server-side to what the caller may reach, so this is not a filtered
 * copy of the full roster — a user restricted to two centres receives two.
 *
 * This lives at MODULE scope, so it survives a client-side sign-out (which does
 * not reload the page). Without invalidation, signing out of one centre and
 * into another in the same tab left this holding the FIRST centre's list — and
 * a single-centre account auto-locks the order form to `clients[0]`, so the New
 * Order form kept showing the previous centre's code until a hard refresh.
 * clearClientCache() is called on every sign-in and sign-out (see AuthContext)
 * so the next picker fetches the new session's own scope.
 */
let cached: Promise<ClientOption[]> | null = null;

/** Drop the shared client list. Called whenever the signed-in identity changes. */
export function clearClientCache(): void {
  cached = null;
}

export function loadClients(): Promise<ClientOption[]> {
  cached ??= api.get<FiltersResponse>('/api/reports/clients/search')
    .then((r) => r.rows ?? [])
    .catch(() => {
      // Do not memoise a failure; the next mount should retry.
      cached = null;
      return [];
    });
  return cached;
}

/** How many matches to render at once. See the note in the component. */
const MAX_VISIBLE = 50;

/**
 * Choose a client, by typing.
 *
 * NOT a native <select>. An admin's scope is every centre the lab has — 3,594
 * of them — and a select with 3,594 options is both unusable (scroll to find
 * "MEDICARE") and a 197 KB accessibility tree on a page that has one. Measured,
 * not assumed: that is what the first version rendered.
 *
 * So: a text input that filters, showing the first 50 matches and saying how
 * many more there are. Fifty is a rendering cap, not a search cap — the filter
 * runs over the whole list, so a code that matches is always reachable by
 * typing more of it. The count is shown because a silently truncated list is
 * indistinguishable from "that is all there is".
 *
 * `activeOnly` is for order entry. A deactivated centre still has history worth
 * filtering a worklist by, but it cannot take a new order — the create
 * procedure refuses it with "Unknown or inactive collection centre". Offering
 * one on a booking form only produces that error after the operator has typed
 * out a whole patient.
 */
export function ClientPicker({
  value,
  onChange,
  onClient,
  activeOnly = false,
  allowNone = true,
  noneLabel = 'All clients',
  placeholder = 'Search client code or name…',
}: {
  value: number | null;
  onChange: (mcc: number | null) => void;
  /** The resolved selection with its CODE — for callers whose policy is
   *  keyed on the client code (discount caps), not the numeric id. */
  onClient?: (client: { id: number; code: string } | null) => void;
  activeOnly?: boolean;
  allowNone?: boolean;
  noneLabel?: string;
  placeholder?: string;
}) {
  const [clients, setClients] = useState<ClientOption[]>([]);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  useEffect(() => {
    let live = true;
    void loadClients().then((c) => { if (live) setClients(c); });
    return () => { live = false; };
  }, []);

  /*
   * ONE centre in scope is not a choice - it is a fact, so it is filled in and
   * locked rather than offered.
   *
   * A collection centre signing in can only ever order for itself, and asking
   * it to pick its own name from a list of one is a step that can only be got
   * wrong: leave it blank and the form stays dead with no hint why. Lab staff,
   * who have many, are untouched.
   *
   * Guarded on `value` so this fires once, on the initial resolve, and does not
   * fight an operator who deliberately cleared the field.
   */
  const singleClient = clients.length === 1 ? clients[0] : null;
  useEffect(() => {
    if (singleClient && value == null) onChange(singleClient.id);
  }, [singleClient, value, onChange]);

  // Close when focus or a click leaves the widget, so the list is not left
  // hanging over the page after the operator moves on.
  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', away);
    document.addEventListener('focusin', away);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('focusin', away);
    };
  }, [open]);

  const pool = useMemo(
    () => (activeOnly ? clients.filter((c) => c.isActive) : clients),
    [clients, activeOnly],
  );

  // Resolved from the FULL list, not the active-filtered pool. `activeOnly`
  // governs what can be OFFERED; a value already held is a fact to read back.
  // MDCARE — the busiest B2C centre — is flagged inactive in the LIS (the flag
  // is not a liveness bit there), and resolving through the pool made
  // `selected` null for it, so onClient reported null and the discount policy
  // fell back to the 20% default instead of MDCARE's contractual 10%.
  const selected = value == null ? null : clients.find((c) => c.id === value) ?? null;

  // Reported from an effect rather than inside onChange, so the caller also
  // hears about the selection the single-client auto-pick makes, and about
  // the initial resolve once the list arrives.
  useEffect(() => {
    onClient?.(selected ? { id: selected.id, code: selected.code } : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return pool;
    return pool.filter((c) =>
      c.code.toLowerCase().includes(q) || (c.name ?? '').toLowerCase().includes(q));
  }, [pool, query]);

  const shown = matches.slice(0, MAX_VISIBLE);
  const hidden = matches.length - shown.length;

  const label = (c: ClientOption) =>
    c.code + (c.name && c.name !== c.code ? ` — ${c.name}` : '');

  function choose(c: ClientOption | null) {
    onChange(c?.id ?? null);
    setQuery('');
    setOpen(false);
  }

  /*
   * The single-centre account gets a READ-BACK, not a read-only input. The
   * readOnly picker looked exactly like a live one — same box, same caret on
   * focus — and an operator kept trying to type into it. The same pinned
   * treatment the report filters use: the code, the name, and a small lock
   * that says "fixed", not "broken". Not a disabled input, deliberately:
   * disabled controls are skipped by screen readers and their text renders
   * dimmed, and this value is a fact worth reading at full strength.
   */
  if (singleClient) {
    return (
      <div className="client-picker">
        <div className="input" aria-readonly="true" aria-label="Client"
             style={{ display: 'flex', alignItems: 'center', gap: '.45rem',
                      cursor: 'default', background: 'var(--accent-softer)' }}>
          <b className="mono">{singleClient.code}</b>
          {singleClient.name && singleClient.name !== singleClient.code && (
            <span className="muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {singleClient.name}
            </span>
          )}
          <svg viewBox="0 0 16 16" aria-hidden="true"
               style={{ width: 12, height: 12, marginLeft: 'auto', flex: 'none', opacity: .45 }}>
            <rect x="3.5" y="7" width="9" height="6" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4"/>
            <path d="M5.5 7V5.5a2.5 2.5 0 0 1 5 0V7" fill="none" stroke="currentColor" strokeWidth="1.4"/>
          </svg>
        </div>
      </div>
    );
  }

  return (
    <div className="client-picker" ref={boxRef}>
      <input
        className="input"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-label="Client"
        placeholder={selected ? label(selected) : placeholder}
        /* The QUERY while the list is open, the parent-held selection
           otherwise. */
        value={open ? query : (selected ? label(selected) : '')}
        onFocus={() => setOpen(true)}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { setOpen(false); setQuery(''); }
          // One match and Enter: the common case when someone types a full code.
          if (e.key === 'Enter' && open && shown.length === 1) { e.preventDefault(); choose(shown[0]); }
        }}
      />

      {open && (
        <ul className="client-picker__list" id={listId} role="listbox">
          {allowNone && (
            <li>
              <button type="button" className="client-picker__opt" onClick={() => choose(null)}>
                {noneLabel}
              </button>
            </li>
          )}

          {shown.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                role="option"
                aria-selected={c.id === value}
                className={`client-picker__opt${c.id === value ? ' client-picker__opt--on' : ''}`}
                onClick={() => choose(c)}
              >
                <b className="mono">{c.code}</b>
                {c.name && c.name !== c.code && <span className="muted"> — {c.name}</span>}
              </button>
            </li>
          ))}

          {/* Never silently truncated: the count is what tells the operator to
              keep typing rather than conclude their client is not there. */}
          {hidden > 0 && (
            <li className="client-picker__more muted">
              {hidden.toLocaleString()} more — keep typing to narrow
            </li>
          )}

          {matches.length === 0 && (
            <li className="client-picker__more muted">
              {pool.length === 0
                ? (activeOnly ? 'No active clients in your scope' : 'No clients in your scope')
                : 'No client matches that'}
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
