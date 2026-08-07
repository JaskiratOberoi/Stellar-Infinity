import { useEffect, useRef } from 'react';
import { cartApi, type SampleGroup } from '../api/client';
import { plainText } from '../lib/format';

/**
 * One Sample ID input, for one tube.
 *
 * Used by the order form, which now offers barcodes at booking time. The field
 * checks what is typed against the LIS as you type, because a barcode already
 * on another tube is the one mistake worth catching before the operator has
 * finished entering the patient — otherwise the first they hear of it is the
 * whole order being rejected at submit.
 *
 * ── WHY A GREEN TICK IS HONEST HERE AND WOULD NOT HAVE BEEN ────────────────
 * The check behind this is global: `vailid` is unique across the whole LIS, so
 * "not taken" means not taken by anyone, not merely by this centre. That is
 * what makes a confirmation safe to show. A scoped check would have had to stay
 * silent on success, because its "free" would have been a green light in front
 * of a barcode another centre already owns.
 *
 * It is still advisory. Two forms open on the same barcode both see "free", and
 * the second one is rejected at write time — which is correct and is why the
 * submit path keeps its own error handling rather than trusting this.
 */

export type SidStatus = 'idle' | 'checking' | 'free' | 'taken' | 'error';

/** How long after the last keystroke to ask. A scan arrives as one burst. */
const DEBOUNCE_MS = 350;

export function SidField({
  group, value, status, dupInForm, onChange, onStatus, autoFocus,
}: {
  group: SampleGroup;
  value: string;
  status: SidStatus;
  /**
   * This barcode is already typed into ANOTHER tube on this form. The server
   * cannot catch it — neither one exists yet, so both come back free — and it
   * is the likelier of the two mistakes, because the tubes are being labelled
   * from one sheet of stickers.
   */
  dupInForm: boolean;
  onChange: (next: string) => void;
  onStatus: (next: SidStatus) => void;
  autoFocus?: boolean;
}) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Answers can arrive out of order. Only the newest question owns the badge.
  const seq = useRef(0);

  useEffect(() => {
    const v = value.trim();
    if (timer.current) clearTimeout(timer.current);

    if (!v) { seq.current++; onStatus('idle'); return; }

    onStatus('checking');
    const mine = ++seq.current;
    timer.current = setTimeout(() => {
      cartApi.sidTaken(v)
        .then((r) => { if (mine === seq.current) onStatus(r.taken ? 'taken' : 'free'); })
        // Never fall through to 'free'. A lookup that could not run is not a
        // barcode that is available, and showing it as one is how a real
        // duplicate reaches the submit with a tick beside it.
        .catch(() => { if (mine === seq.current) onStatus('error'); });
    }, DEBOUNCE_MS);

    return () => { if (timer.current) clearTimeout(timer.current); };
    // onStatus is re-created by the parent on every render; depending on it
    // would restart the debounce on every keystroke elsewhere in the form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const id = `sid-${group.sampleTypeId}`;
  const bad = dupInForm || status === 'taken';

  return (
    <div className="field">
      <label htmlFor={id}>
        {group.sampleTypeName || 'Unspecified'}
        <span className="muted" style={{ fontWeight: 400 }}>
          {' '}· {plainText(group.names ?? '') || 'no tests listed'}
        </span>
      </label>

      <div className="row" style={{ gap: '.45rem', alignItems: 'center' }}>
        <input
          id={id}
          className={`input mono${bad ? ' input--flag' : ''}`}
          inputMode="numeric"
          autoComplete="off"
          maxLength={50}
          autoFocus={autoFocus}
          placeholder="Scan or type the barcode"
          value={value}
          // Digits only, matching the LIS's own rule for a barcode and the
          // accessioning form beside it. A scanner that emits a trailing Enter
          // submits nothing here, because this field is not in a form.
          onChange={(e) => onChange(e.target.value.replace(/\D/g, ''))}
          aria-invalid={bad || undefined}
          aria-describedby={`${id}-note`}
        />
        <SidBadge status={status} dupInForm={dupInForm} />
      </div>

      {/* One line, and only when it says something. aria-live so a screen
          reader hears the verdict without being sent back to the label. */}
      <p id={`${id}-note`} className="sid-note" aria-live="polite">
        {dupInForm
          ? <span className="sid-note--bad">Already typed against another tube on this order.</span>
          : status === 'taken'
            ? <span className="sid-note--bad">This barcode is already on a tube in the LIS.</span>
            : status === 'error'
              ? <span className="muted">Could not check this barcode — it will be verified when the order is placed.</span>
              : null}
      </p>
    </div>
  );
}

function SidBadge({ status, dupInForm }: { status: SidStatus; dupInForm: boolean }) {
  if (dupInForm || status === 'taken') return <span className="badge badge--bad">in use</span>;
  if (status === 'checking') return <span className="badge badge--muted">checking…</span>;
  if (status === 'free') return <span className="badge badge--ok">free</span>;
  // 'error' says its piece in the note below the field; a badge for it would
  // read as a verdict on the barcode rather than on the lookup.
  return null;
}
