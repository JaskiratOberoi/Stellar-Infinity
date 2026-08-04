import { useMemo, useRef, useState, type FormEvent } from 'react';
import { useAuth } from '../auth/AuthContext';
import { Mark } from '../components/Mark';
import { ThemeToggle } from '../theme/ThemeToggle';
import { InfinityLoader } from '../components/InfinityLoader';

/**
 * Time-of-day greeting. Computed once per mount — a login page is looked at
 * for seconds, so a ticking clock that flips "morning" to "afternoon" mid-type
 * would be motion for its own sake.
 *
 * The overnight window gets its own line on purpose: this is a lab, and the
 * people signing in at 3am are running the night bench. They should not be
 * greeted with a generic "good evening" nine hours after the evening ended.
 */
function greeting(): { title: string; sub: string } {
  const h = new Date().getHours();
  if (h >= 5 && h < 12) return { title: 'Good morning', sub: 'The day list is waiting for you.' };
  if (h >= 12 && h < 17) return { title: 'Good afternoon', sub: 'Pick up right where you left off.' };
  if (h >= 17 && h < 22) return { title: 'Good evening', sub: 'Let’s close out the day’s worklist.' };
  return { title: 'Burning the midnight oil?', sub: 'The night bench appreciates you.' };
}

/** Card-to-symbol morph duration (.08s delay + .95s animation). Commit hands
    over to the shell's veil the moment the morph settles. */
const MORPH_MS = 1030;

export function Login() {
  const { signInDeferred } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const cardRef = useRef<HTMLFormElement>(null);

  const greet = useMemo(greeting, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      // Stage 1 of the entrance: the credentials are verified NOW, but nothing
      // is committed. The card morphs into the Infinity symbol in place; only
      // then does commit() set the user — which unmounts this screen and hands
      // the dive-through-the-loop to <EnterVeil> in App.
      //
      // Reduced motion commits immediately: for someone who has asked for
      // stillness, a second of frozen card would read as a hang, not a pause.
      const commit = await signInDeferred(username.trim(), password);
      const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      // The morph's 0% frame must be the card's REAL height. Animating from a
      // hard-coded ceiling means the timeline's opening moments shrink
      // invisible slack — a visible pause, then a rush.
      if (cardRef.current) {
        cardRef.current.style.setProperty('--card-h', `${cardRef.current.offsetHeight}px`);
      }
      setLeaving(true);
      window.setTimeout(commit, still ? 30 : MORPH_MS);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed.');
      setBusy(false);
    }
    // Deliberately no finally: on success `busy` stays true so the form cannot
    // be resubmitted while the takeover plays.
  }

  return (
    <div className={`login${leaving ? ' login--leaving' : ''}`}>
      {/* The living background: three slow-drifting aurora orbs behind the
          card. Pure CSS transforms (GPU-composited, no layout work) and the
          global prefers-reduced-motion rule freezes them for anyone who has
          asked for stillness. aria-hidden — they are weather, not content. */}
      <div className="login__sky" aria-hidden="true">
        <span className="login__orb login__orb--a" />
        <span className="login__orb login__orb--b" />
        <span className="login__orb login__orb--c" />
      </div>

      {/* Available before sign-in too — someone on a night shift should not
          have to authenticate through a white flash to reach the toggle. */}
      <div className="login__corner"><ThemeToggle /></div>

      <form className="login__card" onSubmit={onSubmit} ref={cardRef}>
        {/* The symbol the card morphs INTO. In the DOM from the start
            (opacity 0), absolutely centred in the card, so its condensing-in
            during the morph is a continuation of the same object — not a new
            element popping over a dying one. <EnterVeil> in App then renders
            this same mark at the same size and centre when the screen swaps,
            making the whole card → symbol → dive read as one motion. */}
        <div className="login__morphmark" aria-hidden="true">
          <Mark withText={false} />
        </div>

        <Mark />

        <div>
          <h1 className="login__title">{greet.title}</h1>
          <p className="login__hint">{greet.sub}</p>
        </div>

        {error && <div className="alert alert--error login__error">{error}</div>}

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
            placeholder="Your LIS username"
          />
        </div>

        <div className="field">
          <label htmlFor="password">Password</label>
          <div className="field__wrap">
            <input
              id="password"
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              // Caps Lock is the most common "my password is wrong" that is not
              // a wrong password. getModifierState is exact, not a heuristic.
              onKeyUp={(e) => setCapsLock(e.getModifierState('CapsLock'))}
              onBlur={() => setCapsLock(false)}
              autoComplete="current-password"
              required
              maxLength={50}
              placeholder="••••••••"
              style={{ width: '100%', paddingRight: '2.6rem' }}
            />
            <button
              type="button"
              className="field__reveal"
              onClick={() => setShowPassword((s) => !s)}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
              tabIndex={-1}
            >
              {showPassword ? (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
                  <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
                  <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
                  <line x1="1" y1="1" x2="23" y2="23" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
              )}
            </button>
          </div>
          {capsLock && <span className="login__caps">Caps Lock is on</span>}
        </div>

        <button className="btn btn--primary login__submit" type="submit" disabled={busy || !username || !password}>
          {busy && <InfinityLoader size={30} mono label="Signing in" />}
          {busy ? 'Signing in…' : 'Sign in'}
        </button>

        <p className="login__foot">
          Your existing LIS username and password — nothing new to remember.
        </p>
      </form>
    </div>
  );
}
