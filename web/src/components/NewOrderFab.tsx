import { Link, useLocation } from 'react-router-dom';

/**
 * Book an order from wherever you are.
 *
 * This used to be a nav tab. It is the single most repeated action in the
 * building and it was sitting third in a row of thirteen, competing for
 * attention with Rates and Branding — things an operator opens once a month.
 * Telo moved the same action to a floating button for the same reason, and a
 * receptionist reaches for it from the Orders list, from Accessioning, from
 * the Catalogue, from anywhere.
 *
 * Mounted once in the shell so it rides on every page rather than belonging to
 * one worklist.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ──────────────────────────────────────
 * It does not choose a channel. Telo's FAB reads the section you are in and
 * books B2B from the B2B worklist, because Telo has two separate registration
 * forms. Infinity has one form with the channel as its first control, and that
 * control already defaults correctly from the operator's capabilities — so
 * picking here would be a second, quieter place where the channel gets decided,
 * and the two would eventually disagree.
 *
 * It carries no cart badge either. Telo's does because its Catalogue adds to
 * the order cart, so a count is the only sign that anything happened;
 * Infinity's Catalogue does not, and a badge that is always zero is furniture.
 */
export function NewOrderFab() {
  const loc = useLocation();

  // Already there. A button that points at the page you are on is noise, and
  // on the order form specifically it would sit over the Place button.
  if (loc.pathname.startsWith('/orders/new')) return null;

  return (
    <Link to="/orders/new" className="fab" aria-label="Book a new order">
      <svg className="fab__plus" viewBox="0 0 24 24" aria-hidden="true" fill="none"
           stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
        <path d="M12 5v14M5 12h14" />
      </svg>
      <span className="fab__label">New order</span>
    </Link>
  );
}
