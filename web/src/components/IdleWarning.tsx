import { useAuth } from '../auth/AuthContext';

/**
 * The two-minute warning before an idle sign-out.
 *
 * It exists because of what this app is used for. Auto-logout with no notice
 * is a data-loss bug on a result-entry screen: a technologist typing a panel,
 * interrupted by a phone call, would come back to a login page and a lost
 * grid. Two minutes and one button is enough to save that.
 *
 * Rendered above everything, and deliberately not dismissible by clicking away
 * — the only ways out are to stay or to go.
 */
export function IdleWarning() {
  const { idleSecondsLeft, staySignedIn, signOut } = useAuth();
  if (idleSecondsLeft == null) return null;

  const mm = Math.floor(idleSecondsLeft / 60);
  const ss = String(idleSecondsLeft % 60).padStart(2, '0');

  return (
    <div className="idle-warn" role="alertdialog" aria-live="assertive" aria-label="Session about to expire">
      <div className="idle-warn__card">
        <h2 className="idle-warn__title">Still there?</h2>
        <p className="idle-warn__body">
          You will be signed out in <b className="mono">{mm}:{ss}</b> because of inactivity.
          Anything you have typed but not saved will be lost.
        </p>
        <div className="row" style={{ justifyContent: 'flex-end', gap: '.5rem' }}>
          <button className="btn btn--ghost btn--sm" onClick={signOut}>Sign out now</button>
          <button className="btn btn--primary btn--sm" onClick={staySignedIn} autoFocus>
            Stay signed in
          </button>
        </div>
      </div>
    </div>
  );
}
