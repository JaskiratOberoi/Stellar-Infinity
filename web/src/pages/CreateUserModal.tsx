import { useState, type FormEvent } from 'react';
import { adminApi } from '../api/client';

interface Props {
  roles: string[];
  onClose: () => void;
  onCreated: (username: string) => void;
}

export function CreateUserModal({ roles, onClose, onCreated }: Props) {
  const [form, setForm] = useState({
    username: '',
    password: '',
    firstName: '',
    lastName: '',
    email: '',
    // The LIS user type is required because LIS screens key on it, and because
    // the account may later be granted LIS access. 33 = ENTRY, a safe default
    // for ordinary staff.
    lisUsertypeId: 33,
    infinityRole: 'viewer',
    grantLisAccess: false,
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await adminApi.createUser({
        username: form.username.trim(),
        password: form.password,
        firstName: form.firstName.trim(),
        lastName: form.lastName.trim() || undefined,
        email: form.email.trim() || undefined,
        lisUsertypeId: Number(form.lisUsertypeId),
        infinityRole: form.infinityRole,
        grantLisAccess: form.grantLisAccess,
      });
      onCreated(form.username.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the user.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2 className="modal__title">New Infinity user</h2>

        {error && <div className="alert alert--error">{error}</div>}

        <div className="grid2">
          <div className="field">
            <label htmlFor="cu-user">Username *</label>
            <input id="cu-user" value={form.username} onChange={(e) => set('username', e.target.value)} required maxLength={50} autoFocus />
          </div>
          <div className="field">
            <label htmlFor="cu-pass">Password *</label>
            <input id="cu-pass" type="text" value={form.password} onChange={(e) => set('password', e.target.value)} required maxLength={50} />
          </div>
          <div className="field">
            <label htmlFor="cu-first">First name *</label>
            <input id="cu-first" value={form.firstName} onChange={(e) => set('firstName', e.target.value)} required maxLength={100} />
          </div>
          <div className="field">
            <label htmlFor="cu-last">Last name</label>
            <input id="cu-last" value={form.lastName} onChange={(e) => set('lastName', e.target.value)} maxLength={100} />
          </div>
        </div>

        <div className="field">
          <label htmlFor="cu-email">Email</label>
          <input id="cu-email" type="email" value={form.email} onChange={(e) => set('email', e.target.value)} maxLength={100} />
        </div>

        <div className="grid2">
          <div className="field">
            <label htmlFor="cu-role">Infinity role *</label>
            <select id="cu-role" value={form.infinityRole} onChange={(e) => set('infinityRole', e.target.value)}>
              {(roles.length ? roles : ['viewer']).map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="cu-type">LIS user type id *</label>
            <input id="cu-type" type="number" value={form.lisUsertypeId} onChange={(e) => set('lisUsertypeId', Number(e.target.value))} required />
          </div>
        </div>

        <label className="row" style={{ cursor: 'pointer', gap: '.6rem' }}>
          <button
            type="button"
            className={`toggle ${form.grantLisAccess ? 'toggle--on' : ''}`}
            onClick={() => set('grantLisAccess', !form.grantLisAccess)}
            aria-pressed={form.grantLisAccess}
          />
          <span style={{ fontSize: '.82rem' }}>
            Also allow sign-in to the legacy LIS
            <span className="muted" style={{ display: 'block', fontSize: '.72rem' }}>
              Off by default. The account works in Infinity either way.
            </span>
          </span>
        </label>

        <div className="modal__actions">
          <button type="button" className="btn btn--ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="btn btn--primary" disabled={busy}>
            {busy ? 'Creating…' : 'Create user'}
          </button>
        </div>
      </form>
    </div>
  );
}
