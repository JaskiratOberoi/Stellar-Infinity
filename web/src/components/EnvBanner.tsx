/**
 * The environment strip.
 *
 * Staging and production are the same application against the same LIS
 * database, so the only thing separating "I am trying something" from "I have
 * just signed out a real patient's result" is knowing which tab you are in.
 * A URL in the address bar is not enough — people work with several tabs open
 * and the two look identical.
 *
 * Baked in at BUILD time (VITE_ENVIRONMENT, set from the staging compose file)
 * rather than sniffed from the hostname. Hostname detection would go quiet the
 * moment someone opened the staging container directly on localhost:3122,
 * which is exactly when two identical-looking tabs are most likely to be
 * confused.
 *
 * Absent from production builds entirely: the variable is unset there, so this
 * renders nothing and the layout offsets in styles.css never engage.
 *
 * Deliberately NOT shown on the print routes — those are photographed by the
 * renderer for the PDF, and a warning strip across a patient's report would be
 * a defect rather than a safeguard.
 */
export function EnvBanner() {
  const env = import.meta.env.VITE_ENVIRONMENT?.trim();
  if (!env || env === 'production') return null;

  return (
    <div className="envbar" role="status">
      <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor"
           strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 3.6 21.2 20H2.8Z" />
        <path d="M12 10v4.2M12 17.3v.01" />
      </svg>
      <span>
        <b>{env.toUpperCase()}</b>
        {/* The warning names the consequence, not the environment. "You are on
            staging" is a fact; "what you do here is real" is the thing someone
            needs to have read. */}
        <span className="envbar__long">
          <span className="envbar__sep" aria-hidden="true">·</span>
          connected to the live LIS — anything you change here is real
        </span>
      </span>
    </div>
  );
}
