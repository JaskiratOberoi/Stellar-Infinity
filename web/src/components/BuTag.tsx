/**
 * The lab the tube is processed at — the sample's business unit — as the LIS
 * badges it beside the client code: the first three letters, bold, so a
 * bench in Delhi can tell a Haldwani tube (HAL) from a Srinagar one (SRI)
 * without reading the code. The full name is on hover.
 *
 * One component for the worklists, the entry modal and the report viewers,
 * so the rule below holds on every screen at once.
 */
export function BuTag({ unit }: { unit: string | null | undefined }) {
  const code = (unit ?? '').trim();
  // Delhi is the default, not a place worth a tag: the LIS leaves a QUGEN
  // tube — processed at Hari Nagar, including everything inwarded there —
  // bare, and marks only the tubes that run elsewhere.
  if (!code || /^qugen$/i.test(code)) return null;
  return (
    <span className="badge badge--muted bu-tag" title={`Processed at ${code}`}>
      {code.slice(0, 3).toUpperCase()}
    </span>
  );
}
