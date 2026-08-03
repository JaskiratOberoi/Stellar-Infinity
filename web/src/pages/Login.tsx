import { useState, type FormEvent } from 'react';
import { useAuth } from '../auth/AuthContext';
import { Mark } from '../components/Mark';
import { ThemeToggle } from '../theme/ThemeToggle';

export function Login() {
  const { signIn } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await signIn(username.trim(), password);
      // No redirect here: <App> re-renders into the shell once `user` is set.
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      {/* Available before sign-in too — someone on a night shift should not
          have to authenticate through a white flash to reach the toggle. */}
      <div className="login__corner"><ThemeToggle /></div>

      <form className="login__card" onSubmit={onSubmit}>
        <Mark />

        <div>
          <h1 className="login__title">Sign in</h1>
          <p className="login__hint">Use your existing LIS credentials.</p>
        </div>

        {error && <div className="alert alert--error">{error}</div>}

        <div className="field">
          <label htmlFor="username">Username</label>
          <input
            id="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoFocus
            required
            maxLength={50}
          />
        </div>

        <div className="field">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
            maxLength={50}
          />
        </div>

        <button className="btn btn--primary" type="submit" disabled={busy || !username || !password}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
