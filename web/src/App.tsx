import { useEffect } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './auth/AuthContext';
import { Mark } from './components/Mark';
import { SignInDraw } from './components/SignInDraw';
import { NobleMark } from './components/NobleMark';
import { Login } from './pages/Login';
import { Dashboard } from './pages/Dashboard';
import { Orders } from './pages/Orders';
import { NewOrder } from './pages/NewOrder';
import { Accessioning } from './pages/Accessioning';
import { Catalogue } from './pages/Catalogue';
import { ClientAccounts } from './pages/ClientAccounts';
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
import { NavMenu, type NavItem } from './components/NavMenu';
import { PrintReport } from './pages/PrintReport';
import { PrintSmartReport } from './pages/PrintSmartReport';
import { EnvBanner } from './components/EnvBanner';
import { PrintInvoice } from './pages/PrintInvoice';

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
const NAV: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: 'dashboard', end: true },
  { to: '/orders', label: 'Orders', icon: 'orders', cap: 'order:view' },
  // Order entry, in the sequence the work happens: book it, barcode it, then
  // it appears on the worksheet.
  { to: '/orders/new', label: 'New order', icon: 'orders', cap: 'order:create' },
  { to: '/accessioning', label: 'Accessioning', icon: 'orders', cap: 'order:view' },
  { to: '/catalogue', label: 'Catalogue', icon: 'orders', cap: 'order:view' },
  { to: '/accounts', label: 'Accounts', icon: 'orders', cap: 'billing:view' },
  { to: '/rate-lists', label: 'Rates', icon: 'orders', cap: 'billing:view' },
  { to: '/worksheet', label: 'Worksheet', icon: 'worksheet', cap: 'result:enter' },
  { to: '/reports', label: 'Reporting', icon: 'reporting', cap: 'report:view' },
  { to: '/instruments', label: 'Instruments', icon: 'instruments', cap: 'result:enter' },
  // "Jarvis" alone: the parenthetical was the widest thing in the bar by a
  // distance, and the page's own heading already reads
  // "Jarvis · auto-authorisation".
  { to: '/settings/auto-auth', label: 'Jarvis', icon: 'jarvis', cap: 'autoauth:manage' },
  { to: '/admin/users', label: 'Users', icon: 'users', cap: 'user:manage' },
  // Same capability as Users, and next to it: this edits a document clients
  // receive, and Telo gates its own copy of this screen the same way.
  { to: '/admin/invoice', label: 'Invoice branding', icon: 'orders', cap: 'user:manage' },
];

export function App() {
  const { user, loading, signOut, can, entering, finishEntering } = useAuth();
  const isPrint = useLocation().pathname.startsWith('/print/');

  if (loading) {
    return <div className="center"><InfinityLoader /><span className="muted">Restoring session…</span></div>;
  }

  if (!user) return <><EnvBanner /><Login /></>;

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
      </Routes>
    );
  }

  const navItems = NAV.filter((i) => !i.cap || can(i.cap));

  return (
    <div className={`shell${entering ? ' shell--hello' : ''}`}>
      <EnvBanner />
      {entering && <EnterVeil done={finishEntering} />}
      <IdleWarning />
      <header className="topbar">
        <Mark />
        <NobleMark />

        <nav className="topbar__nav">
          {navItems.map((i) => (
            <NavLink key={i.to} to={i.to} end={i.end}>{i.label}</NavLink>
          ))}
        </nav>

        {/* The title carries who is signed in for the widths where the bar has
            shed the visible name — see the shed ladder in styles.css. */}
        <div className="topbar__user" title={`${user.displayName ?? user.username} · ${user.role}`}>
          <span><b>{user.displayName ?? user.username}</b> · {user.role}</span>
          <ThemeToggle />
          <button className="btn btn--ghost btn--sm" onClick={signOut}>Sign out</button>
        </div>

        {/* Replaces both of the above below 1080px — see NavMenu. */}
        <NavMenu
          items={navItems}
          name={user.displayName ?? user.username}
          role={user.role}
          onSignOut={signOut}
        />
      </header>

      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/orders" element={can('order:view') ? <Orders /> : <Navigate to="/" replace />} />
        {/* order:create, not order:view — booking is a stronger act than
            reading, and the API enforces the same distinction independently. */}
        <Route path="/orders/new" element={can('order:create') ? <NewOrder /> : <Navigate to="/" replace />} />
        <Route path="/accessioning" element={can('order:view') ? <Accessioning /> : <Navigate to="/" replace />} />
        <Route path="/catalogue" element={can('order:view') ? <Catalogue /> : <Navigate to="/" replace />} />
        <Route path="/accounts" element={can('billing:view') ? <ClientAccounts /> : <Navigate to="/" replace />} />
        {/* billing:view to look; rate:manage is checked inside for every edit,
            and independently by the API on each write. */}
        <Route path="/rate-lists" element={can('billing:view') ? <RateLists /> : <Navigate to="/" replace />} />
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
    </div>
  );
}
