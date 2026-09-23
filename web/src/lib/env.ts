/**
 * Which deployment this bundle was built for. Baked in at BUILD time from
 * VITE_ENVIRONMENT (the staging compose file sets "staging"; the production
 * build sets nothing), the same way the environment banner reads it.
 *
 * Used for the few things that exist so a change can be tried on staging
 * before it is the only thing production does — the report format picker
 * is the case. A runtime flag would be a setting somebody could flip on
 * production by accident; a build flag cannot be.
 */
export const ENVIRONMENT = (import.meta.env.VITE_ENVIRONMENT ?? '').trim().toLowerCase();

export const IS_STAGING = ENVIRONMENT === 'staging';
