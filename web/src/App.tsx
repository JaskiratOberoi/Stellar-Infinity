import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth/AuthContext';
import { Mark } from './components/Mark';
import { Login } from './pages/Login';
import { Dashboard } from './pages/Dashboard';
import { Orders } from './pages/Orders';
import { Reports } from './pages/Reports';
import { Worksheet } from './pages/Worksheet';
import { AutoAuthSettings } from './pages/AutoAuthSettings';
import { Instruments } from './pages/Instruments';
import { AdminUsers } from './pages/AdminUsers';
import { ThemeToggle } from './theme/ThemeToggle';

export function App() {
  const { user, loading, signOut, can } = useAuth();

  if (loading) {
    return <div className="center"><div className="spinner" /><span className="muted">Restoring session…</span></div>;
  }

  if (!user) return <Login />;

  return (
    <div className="shell">
      <header className="topbar">
        <Mark />

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
