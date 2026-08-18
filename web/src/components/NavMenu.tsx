import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { NavLink } from 'react-router-dom';

/**
 * One navigation entry. The list itself lives in App, beside the routes it
 * mirrors; the type lives here because this is what consumes it.
 */
export interface NavItem {
  to: string;
  label: string;
  icon: IconName;
  /** Exact match, for the index route that would otherwise match everything. */
  end?: boolean;
  /**
   * Hide this entry from ONE role, even when it holds the capability.
   *
   * For entries a role can legitimately reach but should not be pointed at: a
   * client holds order:view and could open the Orders list, but every order a
   * centre raises is B2B and already has its own entry, so the generic one is
   * a second door onto the same room.
   */
  hideForRole?: string;
  /**
   * Show this entry to ONE role and no other.
   *
   * The mirror of hideForRole, and it exists for the case where two roles want
   * the same label pointed at different screens. "Patient orders" means the
   * receiving queue to the lab and the booking form to a centre; capabilities
   * cannot separate them, because the lab holds everything a client does.
   */
  onlyForRole?: string;
  /**
   * Query string this entry owns, WITHOUT the leading '?'.
   *
   * Set it on every entry sharing a pathname, including the plain one (as an
   * empty string). NavLink decides active state from the pathname alone and
   * ignores the query, so two entries on the same path would both light up —
   * which reads as the nav being broken rather than as a filter being on.
   *
   * Leave undefined on a path only one entry uses; that keeps NavLink's own
   * matching, so a screen free to put its filters in the URL does not go dark
   * in the nav the moment somebody filters it.
   */
  search?: string;
  /** Hidden without it. Cosmetic only — the API enforces every capability
   *  independently on its own routes. */
  cap?: string;
}

/**
 * Whether an entry is the one currently open, query included.
 *
 * Shared by the bar and the sheet so the two cannot disagree about which entry
 * is lit.
 */
export function navItemActive(item: NavItem, pathname: string, search: string): boolean {
  const path = item.to.split('?')[0];
  const pathOk = item.end ? pathname === path : pathname === path || pathname.startsWith(`${path}/`);
  if (!pathOk) return false;
  if (item.search === undefined) return true;
  return search.replace(/^\?/, '') === item.search;
}

/**
 * The nav's icons, authored rather than borrowed.
 *
 * One geometry for all seven: a 24 box, 1.6 stroke, round caps and joins, no
 * fills. That shared construction is what makes them read as a set instead of
 * as seven clip-art pieces — and it is why they are drawn here rather than
 * pulled from an icon font, which would arrive at whatever weight it liked.
 *
 * They are labelled as well as drawn, so none of them has to carry meaning on
 * its own; they are there to make a tile findable at a glance, not to replace
 * the word underneath it.
 */
export type IconName =
  | 'dashboard' | 'orders' | 'worksheet' | 'reporting'
  | 'instruments' | 'jarvis' | 'users';

const ICONS: Record<IconName, JSX.Element> = {
  // Four panes.
  dashboard: (
    <>
      <rect x="3.75" y="3.75" width="7" height="7" rx="2" />
      <rect x="13.25" y="3.75" width="7" height="7" rx="2" />
      <rect x="3.75" y="13.25" width="7" height="7" rx="2" />
      <rect x="13.25" y="13.25" width="7" height="7" rx="2" />
    </>
  ),
  // A bill: a sheet with its corner turned back.
  orders: (
    <>
      <path d="M6 3.75h8.5L19 8.25V19.5a1.75 1.75 0 0 1-1.75 1.75H6A1.75 1.75 0 0 1 4.25 19.5v-14A1.75 1.75 0 0 1 6 3.75Z" />
      <path d="M14.25 3.9V8.5h4.6" />
      <path d="M7.75 12.5h7.5M7.75 16h4.75" />
    </>
  ),
  // The bench clipboard.
  worksheet: (
    <>
      <rect x="4.75" y="4.75" width="14.5" height="16.5" rx="2.25" />
      <path d="M9.25 4.9V3.9a1.15 1.15 0 0 1 1.15-1.15h3.2A1.15 1.15 0 0 1 14.75 3.9v1" />
      <path d="M8.5 10.75h7M8.5 14.25h7M8.5 17.75h4" />
    </>
  ),
  // Three readings on a baseline.
  reporting: (
    <>
      <path d="M4 19.75h16" />
      <path d="M7.75 19.75v-6.5M12 19.75V8.5M16.25 19.75v-4.25" />
    </>
  ),
  // An analyser: a readout and a running lamp.
  instruments: (
    <>
      <rect x="3.5" y="5.5" width="17" height="13" rx="2.5" />
      <path d="M7.25 9.75h5.5M7.25 13.25h3.25" />
      <circle cx="16.5" cy="12" r="1.5" />
    </>
  ),
  // Signed off without being asked.
  jarvis: (
    <>
      <path d="M12 2.9 19 6v5.6c0 4.3-2.9 7.75-7 9.05-4.1-1.3-7-4.75-7-9.05V6Z" />
      <path d="m9 12.1 2.25 2.25L15.5 10.1" />
    </>
  ),
  users: (
    <>
      <circle cx="9.5" cy="8.5" r="3.25" />
      <path d="M3.75 19.75a5.75 5.75 0 0 1 11.5 0" />
      <path d="M15.75 5.9a3.25 3.25 0 0 1 0 5.2" />
      <path d="M17.25 14.4a5.75 5.75 0 0 1 3 5.35" />
    </>
  ),
};

function NavIcon({ name }: { name: IconName }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none"
         stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      {ICONS[name]}
    </svg>
  );
}

function BurgerIcon({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none"
         stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      {open ? <path d="M6 6l12 12M18 6L6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
    </svg>
  );
}

/**
 * The navigation below the bar's last shed rung.
 *
 * Above 1080px every link sits in the bar. Below it there is no honest way to
 * keep seven of them there: the previous answer gave the nav its own row and
 * let it scroll sideways, which on a phone meant Instruments, Jarvis and Users
 * were off the right edge with nothing to say they existed. A link you cannot
 * discover is a link you do not have.
 *
 * So below that width the nav collapses to one control and opens as a full
 * screen. Two columns rather than a list: seven items in one column runs past
 * the fold on a short phone, and the point of the sheet is that everything is
 * visible at once.
 *
 * The sheet also takes in the two things the bar sheds on the way down — who
 * you are signed in as, and the way out — so neither is lost, they just move
 * somewhere with room for them.
 */
/** The width at which the bar gives up its inline nav. Mirrors styles.css. */
const COMPACT = '(max-width: 1080px)';

/**
 * Whether the menu control is the navigation right now.
 *
 * Subscribed to BOTH `change` and `resize` on purpose. `change` is the correct
 * event and the one to reach for; `resize` is the one that actually arrives
 * everywhere. This is not belt-and-braces for its own sake — a sheet left open
 * above the breakpoint is a trap, because the button that closes it is
 * `display: none` by then.
 */
function useCompact() {
  const [compact, setCompact] = useState(() => window.matchMedia(COMPACT).matches);

  useEffect(() => {
    const mq = window.matchMedia(COMPACT);
    const sync = () => setCompact(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    window.addEventListener('resize', sync);
    return () => {
      mq.removeEventListener('change', sync);
      window.removeEventListener('resize', sync);
    };
  }, []);

  return compact;
}

export function NavMenu({
  items, name, role, onSignOut, loc,
}: {
  items: NavItem[];
  name: string;
  role: string;
  onSignOut: () => void;
  /** Passed in rather than read here, so the bar and the sheet judge the
   *  active entry from exactly the same location object. */
  loc: { pathname: string; search: string };
}) {
  const [open, setOpen] = useState(false);
  const compact = useCompact();
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => setOpen(false), []);

  // Growing past the breakpoint takes the sheet with it, rather than leaving it
  // on screen with its only exit hidden.
  useEffect(() => { if (!compact) setOpen(false); }, [compact]);

  useEffect(() => {
    if (!open || !compact) return;

    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);

    // The sheet covers the page; letting the worklist scroll underneath it
    // reads as broken the instant you touch it.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    panelRef.current?.focus();

    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
      // Send focus back where it came from, or a keyboard user is dropped at
      // the top of the document every time they close the menu.
      btnRef.current?.focus();
    };
  }, [open, compact, close]);

  // The sheet is modal, so Tab must not walk out of it into the page behind.
  const trapTab = (e: React.KeyboardEvent) => {
    if (e.key !== 'Tab') return;
    const f = panelRef.current?.querySelectorAll<HTMLElement>('a[href], button:not(:disabled)');
    if (!f || f.length === 0) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="nav-toggle"
        aria-label={open ? 'Close menu' : 'Open menu'}
        aria-expanded={open}
        aria-controls="nav-sheet"
        onClick={() => setOpen((v) => !v)}
      >
        <BurgerIcon open={open} />
      </button>

      {/* Portalled to the body: .topbar is sticky with a z-index, which makes it
          a stacking context, and a fixed child of it cannot paint above the
          app's modals however high its own z-index goes. */}
      {open && compact && createPortal(
        <div
          id="nav-sheet"
          className="navsheet"
          ref={panelRef}
          tabIndex={-1}
          role="dialog"
          aria-modal="true"
          aria-label="Navigation"
          onKeyDown={trapTab}
        >
          <div className="navsheet__head">
            <span className="navsheet__who">
              <b>{name}</b>
              <span>{role}</span>
            </span>
            <button type="button" className="nav-toggle navsheet__close"
                    aria-label="Close menu" onClick={close}>
              <BurgerIcon open />
            </button>
          </div>

          <nav className="navsheet__grid">
            {items.map((i) => (
              <NavLink key={i.to} to={i.to} end={i.end} onClick={close}
                       className={({ isActive }) =>
                         (i.search === undefined ? isActive : navItemActive(i, loc.pathname, loc.search))
                           ? 'active' : undefined}>
                <NavIcon name={i.icon} />
                <span>{i.label}</span>
              </NavLink>
            ))}
          </nav>

          <div className="navsheet__foot">
            <button className="btn btn--ghost" onClick={() => { close(); onSignOut(); }}>
              Sign out
            </button>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
