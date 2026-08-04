import { useEffect } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth/AuthContext';
import { Mark } from './components/Mark';
import { NobleMark } from './components/NobleMark';
import { Login } from './pages/Login';
import { Dashboard } from './pages/Dashboard';
import { Orders } from './pages/Orders';
import { Reports } from './pages/Reports';
import { Worksheet } from './pages/Worksheet';
import { AutoAuthSettings } from './pages/AutoAuthSettings';
import { Instruments } from './pages/Instruments';
import { AdminUsers } from './pages/AdminUsers';
import { ThemeToggle } from './theme/ThemeToggle';

/**
 * Stage 2 of the sign-in entrance. The login screen ended with the Infinity
 * mark centred over an opaque backdrop; this renders the identical frame the
 * instant the shell mounts, then zooms through the mark's LEFT LOOP —
 * transform-origin sits at that loop's centre — while fading, so the app is
 * revealed as if the camera flew through the logo.
 *
 * The shell mounts and starts fetching UNDER the veil, so the ~0.9s of zoom is
 * loading time the user never sees.
 */
function EnterVeil({ done }: { done: () => void }) {
  // Belt and braces: if the animationend event never arrives (background tab
  // throttling), the veil must still get out of the way.
  useEffect(() => {
    const t = window.setTimeout(done, 1600);
    return () => window.clearTimeout(t);
  }, [done]);

  return (
    <div
      className="enter-veil"
      aria-hidden="true"
      onAnimationEnd={(e) => { if (e.target === e.currentTarget) done(); }}
    >
      <div className="enter-veil__mark"><Mark withText={false} /></div>
    </div>
  );
}

export function App() {
  const { user, loading, signOut, can, entering, finishEntering } = useAuth();

  if (loading) {
    return <div className="center"><div className="spinner" /><span className="muted">Restoring session…</span></div>;
  }

  if (!user) return <Login />;

  return (
    <div className={`shell${entering ? ' shell--hello' : ''}`}>
      {entering && <EnterVeil done={finishEntering} />}
      <header className="topbar">
        <Mark />
        <NobleMark />

        <nav className="topbar__nav">
          <NavLink to="/" end>Dashboard</NavLink>
          {can('order:view') && <NavLink to="/orders">Orders</NavLink>}
          {can('result:enter') && <NavLink to="/worksheet">Worksheet</NavLink>}
          {can('report:view') && <NavLink to="/reports">Reporting</NavLink>}
          {can('result:enter') && <NavLink to="/instruments">Instruments</NavLink>}
          {/* Nav is hidden without the capability, but that is cosmetic — the
              API enforces every capability independently on its own routes. */}
          {can('autoauth:manage') && <NavLink to="/settings/auto-auth">Auto-auth</NavLink>}
          {can('user:manage') && <NavLink to="/admin/users">Users</NavLink>}
        </nav>

        <div className="topbar__user">
          <span><b>{user.displayName ?? user.username}</b> · {user.role}</span>
          <ThemeToggle />
          <button className="btn btn--ghost btn--sm" onClick={signOut}>Sign out</button>
        </div>
      </header>

      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/orders" element={can('order:view') ? <Orders /> : <Navigate to="/" replace />} />
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
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </div>
  );
}
