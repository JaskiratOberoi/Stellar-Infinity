import { useEffect } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './auth/AuthContext';
import { Mark } from './components/Mark';
import { SignInDraw } from './components/SignInDraw';
import { NobleMark } from './components/NobleMark';
import { Login } from './pages/Login';
import { Dashboard } from './pages/Dashboard';
import { ClientHome } from './pages/ClientHome';
import { Orders } from './pages/Orders';
import { NewOrder } from './pages/NewOrder';
import { Accessioning } from './pages/Accessioning';
import { Inward } from './pages/Inward';
import { Catalogue } from './pages/Catalogue';
import { ClientAccounts } from './pages/ClientAccounts';
import { ClientSales } from './pages/ClientSales';
import { SalesHome } from './pages/SalesHome';
import { RateLists } from './pages/RateLists';
import { Reports } from './pages/Reports';
import { Worksheet } from './pages/Worksheet';
import { AutoAuthSettings } from './pages/AutoAuthSettings';
import { Instruments } from './pages/Instruments';
import { AdminUsers } from './pages/AdminUsers';
import { InvoiceConfigPage } from './pages/InvoiceConfig';
import { ThemeToggle } from './theme/ThemeToggle';
import { InfinityLoader } from './components/InfinityLoader';
import { IdleWarning } from './components/IdleWarning';
import {
  NavMenu, NavDropdown, navItemActive, isNavGroup, type NavItem, type NavEntry,
} from './components/NavMenu';
import { PrintReport } from './pages/PrintReport';
import { PublicReport } from './pages/PublicReport';
import { NewOrderFab } from './components/NewOrderFab';
import { PrintSmartReport } from './pages/PrintSmartReport';
import { EnvBanner } from './components/EnvBanner';
import { PrintInvoice } from './pages/PrintInvoice';
import { PrintPaymentReceipt } from './pages/PrintPaymentReceipt';
import { PaymentComplete } from './pages/PaymentComplete';

/**
 * Beats 2 and 3 of the sign-in entrance.
 *
 * The login screen ended with the card collapsed into a single glowing
 * particle at the centre of the viewport. This opens on that identical
 * particle, then lets it travel the lemniscate and WRITE the Infinity symbol
 * behind it. When the loop closes the mark pulses and the flare expands
 * outward to become the app.
 *
 * The handoff object is a DOT, deliberately: matching a 13px circle at screen
 * centre across an unmount is exact, where matching a whole symbol's geometry
 * was fragile.
 *
 * The shell mounts and starts fetching UNDER the veil, so the ~1.5s of drawing
 * is loading time the user never sees.
 */
function EnterVeil({ done }: { done: () => void }) {
  // Belt and braces: if the animationend event never arrives (background tab
  // throttling), the veil must still get out of the way.
  useEffect(() => {
    const t = window.setTimeout(done, 2200);
    return () => window.clearTimeout(t);
  }, [done]);

  return (
    <div
      className="enter-veil"
      aria-hidden="true"
      onAnimationEnd={(e) => { if (e.target === e.currentTarget) done(); }}
    >
      {/* The seed is the particle arriving from the login screen — same size,
          same fixed centre, so the unmount swap is invisible. It hands over to
          the head of the stroke, which then writes the symbol. */}
      <span className="sdraw__seed" />
      <SignInDraw />
    </div>
  );
}

/**
 * The navigation, as data.
 *
 * One list rendered twice — inline in the bar above 1080px, and as a full
 * screen below it. Two hand-written copies would drift the first time a route
 * is added, and the copy that drifts is always the one you are not looking at.
 *
 * `cap` hides an entry the user cannot use, but that is cosmetic: the API
 * enforces every capability independently on its own routes.
 */
/*
 * Five heads instead of thirteen pills. Twelve screens as sibling tabs was
 * the LIS sidebar flattened into a row, and the row was losing: at laptop
 * widths the shed ladder in styles.css was stripping the bar of marks and
 * names just to keep every tab on screen. So the bar borrows the LIS's own
 * answer — a handful of headings that open over their screens (NavDropdown) —
 * and the entries that stay top-level are the ones that are destinations in
 * themselves.
 *
 * A group is DISPLAY ONLY. Capabilities and roles gate item by item exactly
 * as before, and the shell below flattens a group that filters down to a
 * single survivor.
 */
const NAV: NavEntry[] = [
  { to: '/', label: 'Dashboard', icon: 'dashboard', end: true },
  // "New order" is NOT in the bar — it is the floating button, mounted in the
  // shell below. It is the most repeated action in the building. See
  // NewOrderFab.
  {
    label: 'Orders',
    items: [
      // Hidden from clients: every order a centre raises is B2B and 'Patient
      // orders' is already that list. The ROUTE stays open - this is
      // navigation, not access.
      { to: '/orders', label: 'Orders', icon: 'orders', cap: 'order:view', hideForRole: 'client' },
      // These two share a pathname, so both declare the query they own —
      // otherwise NavLink lights them together. See NavItem.search.
      // order:accession, not order:view — clients hold order:view (they place
      // orders), and this is the LAB's receiving queue. A collection centre
      // was being shown a tab that always returned nothing: correctly scoped,
      // but a lab screen wearing a client's badge.
      { to: '/accessioning', label: 'Accessioning', icon: 'orders', cap: 'order:accession', search: '' },
      // Two entries, one label, because the phrase means different things to
      // the two audiences and no capability separates them — the lab holds
      // everything a client does.
      //
      // To the LAB it is the B2B half of the receiving queue. Telo carries it
      // in the nav under this name and operators reach for it by name.
      {
        to: '/accessioning?kind=b2b', label: 'Patient orders', icon: 'orders',
        cap: 'order:accession', search: 'kind=b2b', hideForRole: 'client',
      },
      // To a CENTRE it is the booking form. Accessioning is the lab's
      // receiving desk: it answers "has the lab got the tube yet", which is
      // not a question a centre can act on. The thing a centre opens Infinity
      // to do is raise an order, so the link goes straight there.
      {
        to: '/orders/new', label: 'Patient orders', icon: 'orders',
        cap: 'order:create', onlyForRole: 'client',
      },
      // The transit scan desk. It was kept OUT of the flat bar because a
      // fourteenth pill put a horizontal scrollbar on every full-width role;
      // a line inside a menu costs no width, so the desk gets its door back.
      // The route from the Accessioning page header stays — same desk, both
      // ways in.
      { to: '/inward', label: 'Inward', icon: 'orders', cap: 'order:accession' },
    ],
  },
  {
    label: 'Billing',
    items: [
      { to: '/catalogue', label: 'Catalogue', icon: 'orders', cap: 'order:view' },
      { to: '/accounts', label: 'Accounts', icon: 'orders', cap: 'billing:view' },
      // Sales data is per client; /sales resolves WHOSE — a single-account
      // visitor lands directly on their own, anyone else picks. See SalesHome.
      { to: '/sales', label: 'Sales', icon: 'orders', cap: 'billing:view' },
      // rate:manage, not billing:view — clients hold billing:view for their
      // own ledger, and this screen lists every rate list in the lab. See the
      // remark in RateListEndpoints.
      { to: '/rate-lists', label: 'Rates', icon: 'orders', cap: 'rate:manage' },
    ],
  },
  {
    label: 'Lab',
    items: [
      { to: '/worksheet', label: 'Worksheet', icon: 'worksheet', cap: 'result:enter' },
      { to: '/reports', label: 'Reporting', icon: 'reporting', cap: 'report:view' },
      { to: '/instruments', label: 'Instruments', icon: 'instruments', cap: 'result:enter' },
      // "Jarvis" alone: the page's own heading already reads
      // "Jarvis · auto-authorisation". With the bench rather than with Admin
      // because what it governs is result sign-off.
      { to: '/settings/auto-auth', label: 'Jarvis', icon: 'jarvis', cap: 'autoauth:manage' },
    ],
  },
  {
    label: 'Admin',
    items: [
      { to: '/admin/users', label: 'Users', icon: 'users', cap: 'user:manage' },
      // Same capability as Users, and next to it: this edits a document
      // clients receive, and Telo gates its own copy of this screen the same
      // way. The page heading says "Invoice branding" in full.
      { to: '/admin/invoice', label: 'Branding', icon: 'orders', cap: 'user:manage' },
    ],
  },
];

export function App() {
  const { user, loading, signOut, can, entering, finishEntering } = useAuth();
  const loc = useLocation();
  const isPrint = loc.pathname.startsWith('/print/');
  // The patient's landing page from the printed QR. Rendered before the session
  // is even resolved: it has nothing to do with one, and making a patient watch
  // "Restoring session…" for a document they scanned off paper is the
  // application talking about itself.
  const isPublicReport = loc.pathname.startsWith('/r/');
  /*
   * The payment return, and it must render before any session is considered.
   *
   * The customer arrives here on a cross-site navigation from CCAvenue, so
   * SameSite=Strict withholds the session cookie: waiting on auth would show
   * them the login screen moments after taking their money. The token in the
   * URL is what opens the receipt - see PaymentReceiptLink.
   */
  const isPaymentReturn = loc.pathname.startsWith('/payment/complete');

  if (isPublicReport || isPaymentReturn) {
    return (
      <Routes>
        <Route path="/r/:sid" element={<PublicReport />} />
        <Route path="/payment/complete" element={<PaymentComplete />} />
      </Routes>
    );
  }

  if (loading) {
    return <div className="center"><InfinityLoader /><span className="muted">Restoring session…</span></div>;
  }

  /*
   * A print route carrying a token is the PATIENT's copy, opened from the QR on
   * their report — there is no session and there is not meant to be one.
   *
   * The SPA does not check the token and must not be read as though it did:
   * the API verifies it on every request behind this page, and a wrong one
   * leaves the route rendering its own "could not load" state. What this line
   * decides is only whether to show a login form to someone who was never going
   * to log in.
   */
  const tokened = isPrint && new URLSearchParams(loc.search).has('t');

  if (!user && !tokened) return <><EnvBanner /><Login /></>;

  // The print routes are what headless Chromium photographs for the PDF, so
  // they render alone — no top bar, no shell. A PDF is the report, not a
  // screenshot of the application around it. Placed before the shell rather
  // than inside it so there is no chrome to hide afterwards.
  if (isPrint) {
    return (
      <Routes>
        <Route path="/print/report/:sid" element={<PrintReport />} />
        <Route path="/print/report/:sid/smart" element={<PrintSmartReport />} />
        {/* The invoice is printed by the operator rather than photographed by
            the render service, but it belongs here for the same reason: no
            application chrome around a document someone hands to a client. */}
        <Route path="/print/invoice/:billId" element={<PrintInvoice />} />
        {/* Both public and token-signed: the customer returning from CCAvenue
            has no session, and the renderer producing the PDF has none
            either. See PaymentReceiptLink. */}
        <Route path="/print/payment-receipt/:orderRef" element={<PrintPaymentReceipt />} />
      </Routes>
    );
  }

  // Past the print branch a session is guaranteed: the only way to reach the
  // gate above without one is a tokened print route, and that returned. Written
  // out rather than asserted with `!` so the day someone adds a third anonymous
  // route, the shell shows a login form instead of dereferencing null.
  if (!user) return <><EnvBanner /><Login /></>;

  // Gate item by item, then let the structure react: a group whose survivors
  // number one flattens to that entry, an emptied group vanishes. The phone
  // sheet takes the flat leaves — see NavMenu for why it stays a flat grid.
  const visible = (i: NavItem) =>
    (!i.cap || can(i.cap))
      && i.hideForRole !== user.role
      && (!i.onlyForRole || i.onlyForRole === user.role);
  const navEntries: NavEntry[] = NAV.flatMap((e): NavEntry[] => {
    if (!isNavGroup(e)) return visible(e) ? [e] : [];
    const items = e.items.filter(visible);
    return items.length === 0 ? [] : items.length === 1 ? [items[0]] : [{ ...e, items }];
  });
  const navItems = navEntries.flatMap((e) => (isNavGroup(e) ? e.items : [e]));

  return (
    <div className={`shell${entering ? ' shell--hello' : ''}`}>
      <EnvBanner />
      {entering && <EnterVeil done={finishEntering} />}
      <IdleWarning />
      <header className="topbar">
        <Mark />
        <NobleMark />

        <nav className="topbar__nav">
          {navEntries.map((e) => (isNavGroup(e) ? (
            <NavDropdown key={e.label} group={e} loc={loc} />
          ) : (
            <NavLink
              key={e.to} to={e.to} end={e.end}
              // Entries that own a query decide their own active state; the
              // rest keep NavLink's, which ignores the query — see NavItem.
              className={({ isActive }) =>
                (e.search === undefined ? isActive : navItemActive(e, loc.pathname, loc.search))
                  ? 'active' : undefined}
            >
              {e.label}
            </NavLink>
          )))}
        </nav>

        {/* The title carries who is signed in for the widths where the bar has
            shed the visible name — see the shed ladder in styles.css. */}
        <div className="topbar__user" title={`${user.displayName ?? user.username} · ${user.role}`}>
          <span><b>{user.displayName ?? user.username}</b> · {user.role}</span>
          <ThemeToggle />
          <button className="btn btn--ghost btn--sm" onClick={signOut}>Sign out</button>
        </div>

        {/* Replaces both of the above below 850px — see NavMenu. */}
        <NavMenu
          items={navItems}
          name={user.displayName ?? user.username}
          role={user.role}
          onSignOut={signOut}
          loc={loc}
        />
      </header>

      <Routes>
        {/* A centre gets its OWN landing page. The lab Dashboard is gated on
            analytics:view, which the client role does not hold, so a client
            landing there was shown a permission error where Telo shows them
            their balance and payments. Keyed on the capability rather than on
            the role name, so anyone without analytics gets something useful
            rather than an explanation of what they lack. */}
        <Route path="/" element={can('analytics:view') ? <Dashboard /> : <ClientHome />} />
        <Route path="/orders" element={can('order:view') ? <Orders /> : <Navigate to="/" replace />} />
        {/* order:create, not order:view — booking is a stronger act than
            reading, and the API enforces the same distinction independently. */}
        <Route path="/orders/new" element={can('order:create') ? <NewOrder /> : <Navigate to="/" replace />} />
        {/* order:accession alone. This is the LAB's receiving desk — it asks
            whether a tube has reached the bench — and a centre has nothing to
            do with the answer.

            It briefly also accepted order:b2b, so that a client's "Patient
            orders" link would not dead-end. That link now goes to the booking
            form instead, which is what a centre wanted from it, so the escape
            hatch goes with it. */}
        <Route path="/accessioning"
               element={can('order:accession') ? <Accessioning /> : <Navigate to="/" replace />} />
        {/* order:view to look at the scan log; the scan box inside additionally
            needs order:accession, which the API enforces independently. */}
        <Route path="/inward" element={can('order:view') ? <Inward /> : <Navigate to="/" replace />} />
        <Route path="/catalogue" element={can('order:view') ? <Catalogue /> : <Navigate to="/" replace />} />
        <Route path="/accounts" element={can('billing:view') ? <ClientAccounts /> : <Navigate to="/" replace />} />
        {/* Sales grew out of a tab on the account modal — nine columns of
            itemised lines want a page, and a reconciliation wants a URL it
            can come back to. Same gate as the list it grew from. */}
        <Route path="/accounts/:mcc/sales" element={can('billing:view') ? <ClientSales /> : <Navigate to="/" replace />} />
        <Route path="/sales" element={can('billing:view') ? <SalesHome /> : <Navigate to="/" replace />} />
        {/* billing:view to look; rate:manage is checked inside for every edit,
            and independently by the API on each write. */}
        <Route path="/rate-lists" element={can('rate:manage') ? <RateLists /> : <Navigate to="/" replace />} />
        <Route path="/worksheet" element={can('result:enter') ? <Worksheet /> : <Navigate to="/" replace />} />
        <Route path="/reports" element={can('report:view') ? <Reports /> : <Navigate to="/" replace />} />
        <Route path="/instruments" element={can('result:enter') ? <Instruments /> : <Navigate to="/" replace />} />
        <Route
          path="/settings/auto-auth"
          element={can('autoauth:manage') ? <AutoAuthSettings /> : <Navigate to="/" replace />}
        />
        <Route
          path="/admin/users"
          element={can('user:manage') ? <AdminUsers /> : <Navigate to="/" replace />}
        />
        <Route
          path="/admin/invoice"
          element={can('user:manage') ? <InvoiceConfigPage /> : <Navigate to="/" replace />}
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>

      {/* Outside <Routes> on purpose: it belongs to the shell, not to a page.
          Gated on the same capability as the /orders/new route above — a
          button that navigates to a redirect is worse than no button. */}
      {can('order:create') && <NewOrderFab />}
    </div>
  );
}
