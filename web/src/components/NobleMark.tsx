import nobleLogo from '../assets/noble-logo.png';

/**
 * The Noble Diagnostics logo, shown beside the Infinity mark in the top bar.
 *
 * This is not decoration. The people using this screen work for Noble, and
 * their previous tool — the LIS they have used for years — carries Noble's
 * branding on every page. Infinity replaces that tool while reading and writing
 * the same database, so showing the lab's own mark alongside Infinity's says
 * the true thing: this is Noble's system, not some third-party site that
 * happens to hold their patients.
 *
 * Rendered as a sibling of the Infinity mark rather than merged into it, with a
 * divider between: they are two identities standing together, and blending them
 * into one lockup would misrepresent both.
 */
export function NobleMark() {
  return (
    <span className="noble-mark" title="Noble Diagnostics">
      <img src={nobleLogo} alt="Noble Diagnostics" />
    </span>
  );
}
