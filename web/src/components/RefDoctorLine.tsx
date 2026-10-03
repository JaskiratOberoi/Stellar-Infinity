/**
 * The referring doctor, under the patient's name on the worksheet and
 * reporting lists. Nothing is drawn when the booking named nobody, so the
 * cell keeps its two-line height for the common case.
 */
export function RefDoctorLine({ name }: { name: string | null | undefined }) {
  const n = (name ?? '').trim();
  if (!n) return null;
  return (
    <div className="muted" style={{ fontSize: '.72rem', marginTop: '1px' }} title={`Referred by ${n}`}>
      <span style={{ opacity: .75 }}>Ref.</span> {/^dr\b/i.test(n) ? n : `Dr. ${n}`}
    </div>
  );
}
