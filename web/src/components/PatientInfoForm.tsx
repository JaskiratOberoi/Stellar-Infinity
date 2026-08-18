import { useEffect, useMemo, useState } from 'react';
import { api, worksheetApi, type WorksheetSampleHeader } from '../api/client';
import { Combobox } from './Combobox';

interface Referrer { id: number; code: string; name: string }

/**
 * A referrer is either a row in the master table or a name typed by hand.
 *
 * The two are stored in different columns — ref_doctor holds an id,
 * ref_doctor_other holds free text — and the LIS has always worked this way
 * because most referrers are on file and a long tail never will be. Unlike the
 * order form, nothing here creates a master row: correcting a worksheet is not
 * the moment to add a doctor to the lab's permanent list, so a typed name is
 * kept as text and someone can promote it later if it recurs.
 */
type RefPick =
  | { kind: 'existing'; id: number; name: string }
  | { kind: 'other'; name: string }
  | null;

/** Salutations the LIS already holds; the field stays free text for the rest. */
const TITLES = ['Mr', 'Mrs', 'Ms', 'Miss', 'Dr', 'Master', 'Baby', 'B/O'];

/**
 * `datetime-local` wants a naive "YYYY-MM-DDTHH:mm" in the machine's own clock.
 *
 * The header carries a real +05:30 instant, so slicing its ISO string would
 * render UTC and show a sample drawn at 11:39 IST as 06:09 — the same
 * off-by-a-timezone that put the dashboard a day behind. Formatting from the
 * local getters avoids the round trip through UTC entirely.
 */
function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Years/Months/Days, matching age_type 1/2/3 throughout this schema. */
const AGE_TYPES = [
  { value: 1, label: 'Year(s)' },
  { value: 2, label: 'Month(s)' },
  { value: 3, label: 'Day(s)' },
];

const ageTypeFromUnit = (unit: string | null): number =>
  AGE_TYPES.find((t) => t.label === unit)?.value ?? 1;

/**
 * Correcting the patient behind a sample — Listec's "Edit Patient Info", which
 * navigates away to a full-page order editor and comes back having also been
 * able to change the collection centre and the test list.
 *
 * This stays a dialog over the worksheet, and edits only the patient and the
 * referral. Moving a sample to another centre or changing what was ordered are
 * different acts with different consequences for billing, and folding them into
 * the same button is how the legacy screen ends up being avoided by staff who
 * only wanted to fix a spelling.
 */
export function PatientInfoForm({ sid, header, onClose, onSaved }: {
  sid: string;
  header: WorksheetSampleHeader;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState(header.title ?? '');
  const [name, setName] = useState(header.patientName ?? '');
  const [age, setAge] = useState(header.age != null ? String(header.age) : '');
  const [ageType, setAgeType] = useState(ageTypeFromUnit(header.ageUnit));
  const [gender, setGender] = useState(header.sex === 'Female' ? 2 : 1);
  const [mobile, setMobile] = useState('');
  const [email, setEmail] = useState('');
  const [drawn, setDrawn] = useState(toLocalInput(header.sampleDrawn));
  const [history, setHistory] = useState(header.sampleClinicalHistory ?? '');

  const [refs, setRefs] = useState<{ doctors: Referrer[]; customers: Referrer[] }>(
    { doctors: [], customers: [] });
  const [doctor, setDoctor] = useState<RefPick>(null);
  const [customer, setCustomer] = useState<RefPick>(null);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api.get<{ doctors: Referrer[]; customers: Referrer[] }>('/api/orders/referrers')
      .then((r) => { if (live) setRefs(r); })
      .catch(() => { /* Pickers fall back to free text; the edit still saves. */ });
    return () => { live = false; };
  }, []);

  /*
   * The header gives us the RESOLVED referrer name — whichever of the two
   * columns was populated — and not which column it came from. Matching that
   * name against the master list is how we recover the distinction: an exact
   * hit means it was the id, anything else means it was free text.
   *
   * Runs when the lists arrive, not on mount, because before then every name
   * would look like free text and the picker would show the right words while
   * silently rewriting a master reference into a typed string on save.
   */
  useEffect(() => {
    const match = (list: Referrer[], value: string | null): RefPick => {
      if (!value) return null;
      const hit = list.find((r) => r.name.trim().toLowerCase() === value.trim().toLowerCase());
      return hit ? { kind: 'existing', id: hit.id, name: hit.name } : { kind: 'other', name: value };
    };
    setDoctor(match(refs.doctors, header.referringDoctor));
    setCustomer(match(refs.customers, header.referringCustomer));
  }, [refs, header.referringDoctor, header.referringCustomer]);

  const dirty = useMemo(() => (
    title !== (header.title ?? '')
    || name !== (header.patientName ?? '')
    || age !== (header.age != null ? String(header.age) : '')
    || ageType !== ageTypeFromUnit(header.ageUnit)
    || gender !== (header.sex === 'Female' ? 2 : 1)
    || mobile !== '' || email !== ''
    || drawn !== toLocalInput(header.sampleDrawn)
    || history !== (header.sampleClinicalHistory ?? '')
    || (doctor?.name ?? '') !== (header.referringDoctor ?? '')
    || (customer?.name ?? '') !== (header.referringCustomer ?? '')
  ), [title, name, age, ageType, gender, mobile, email, drawn, history, doctor, customer, header]);

  const save = async () => {
    if (!name.trim()) { setError('A patient name is required.'); return; }
    setSaving(true);
    setError(null);
    try {
      // 0 rather than null for "no master row": null means "leave the column
      // alone", so clearing a referrer needs a value the procedure recognises
      // as an explicit clear. Same reason the text fields send '' not null.
      await worksheetApi.updatePatient(sid, {
        title,
        name: name.trim(),
        age: age.trim() === '' ? null : Number(age),
        ageType,
        gender,
        refDoctor: doctor?.kind === 'existing' ? doctor.id : 0,
        refDoctorOther: doctor?.kind === 'other' ? doctor.name : '',
        refCustomer: customer?.kind === 'existing' ? customer.id : 0,
        refCustomerOther: customer?.kind === 'other' ? customer.name : '',
        mobile,
        email,
        // A cleared date means "leave it": there is no such thing as a sample
        // that was never drawn, so an empty control is a blank field rather
        // than an instruction to erase the timestamp.
        sampleTime: drawn === '' ? null : new Date(drawn).toISOString(),
        clinicalHistory: history,
      });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The patient could not be updated.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={() => !saving && onClose()}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true"
           aria-label="Edit patient info">
        <h2 className="modal__title">Edit patient info</h2>
        <p className="muted" style={{ fontSize: '.78rem', marginTop: '.2rem' }}>
          Reg No <b className="mono">{header.pid}</b> · applies to every sample for this patient,
          not only <span className="mono">{sid}</span>.
        </p>

        {/* Said plainly rather than left to be discovered. Age selects the
            reference-range band, so this edit can move the H/L flag on results
            that were entered before it and are not otherwise touched. */}
        {header.needsReopen && (
          <div className="alert alert--info" style={{ marginTop: '.6rem' }}>
            This sample is already signed out. Patient details can still be corrected —
            results stay locked — but a change to age or sex may move the reference range
            a printed result was flagged against.
          </div>
        )}

        {error && <div className="alert alert--error" style={{ marginTop: '.6rem' }}>{error}</div>}

        <div className="pgrid">
          <div className="field field--narrow">
            <label htmlFor="pf-title">Title</label>
            <input id="pf-title" className="input" list="pf-titles" maxLength={10}
                   value={title} onChange={(e) => setTitle(e.target.value)} />
            <datalist id="pf-titles">
              {TITLES.map((t) => <option key={t} value={t} />)}
            </datalist>
          </div>

          <div className="field field--wide">
            <label htmlFor="pf-name">Patient name</label>
            <input id="pf-name" className="input" maxLength={400} value={name}
                   onChange={(e) => setName(e.target.value)} />
          </div>

          <div className="field field--narrow">
            <label htmlFor="pf-age">Age</label>
            <input id="pf-age" className="input" inputMode="numeric" value={age}
                   onChange={(e) => setAge(e.target.value.replace(/[^0-9]/g, ''))} />
          </div>

          <div className="field field--narrow">
            <label htmlFor="pf-agetype">Unit</label>
            <select id="pf-agetype" className="input" value={ageType}
                    onChange={(e) => setAgeType(Number(e.target.value))}>
              {AGE_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </div>

          <div className="field field--narrow">
            <label htmlFor="pf-sex">Sex</label>
            <select id="pf-sex" className="input" value={gender}
                    onChange={(e) => setGender(Number(e.target.value))}>
              <option value={1}>Male</option>
              <option value={2}>Female</option>
            </select>
          </div>

          <div className="field field--half">
            <label>Referring doctor</label>
            <Combobox
              value={doctor?.kind === 'existing' ? String(doctor.id) : ''}
              createdName={doctor?.kind === 'other' ? doctor.name : null}
              emptyLabel="No referring doctor"
              options={refs.doctors.map((d) => ({ value: String(d.id), label: d.name, hint: d.code || null }))}
              onChange={(v) => setDoctor(v === '' ? null : {
                kind: 'existing', id: Number(v),
                name: refs.doctors.find((d) => String(d.id) === v)?.name ?? '',
              })}
              creatable
              createLabel={(t) => `Use “${t}” as typed`}
              onCreate={(n) => setDoctor({ kind: 'other', name: n })}
            />
          </div>

          <div className="field field--half">
            <label>Referring customer</label>
            <Combobox
              value={customer?.kind === 'existing' ? String(customer.id) : ''}
              createdName={customer?.kind === 'other' ? customer.name : null}
              emptyLabel="No referring customer"
              options={refs.customers.map((c) => ({ value: String(c.id), label: c.name, hint: c.code || null }))}
              onChange={(v) => setCustomer(v === '' ? null : {
                kind: 'existing', id: Number(v),
                name: refs.customers.find((c) => String(c.id) === v)?.name ?? '',
              })}
              creatable
              createLabel={(t) => `Use “${t}” as typed`}
              onCreate={(n) => setCustomer({ kind: 'other', name: n })}
            />
          </div>

          <div className="field field--half">
            <label htmlFor="pf-mobile">Mobile</label>
            {/* Blank because the worksheet header never carried these — an empty
                box here leaves the stored value alone rather than clearing it. */}
            <input id="pf-mobile" className="input" maxLength={20} value={mobile}
                   placeholder="Unchanged" onChange={(e) => setMobile(e.target.value)} />
          </div>

          <div className="field field--half">
            <label htmlFor="pf-email">Email</label>
            <input id="pf-email" className="input" type="email" maxLength={100} value={email}
                   placeholder="Unchanged" onChange={(e) => setEmail(e.target.value)} />
          </div>

          <div className="field field--half">
            <label htmlFor="pf-drawn">Sample drawn</label>
            <input id="pf-drawn" className="input" type="datetime-local" value={drawn}
                   onChange={(e) => setDrawn(e.target.value)} />
          </div>

          <div className="field field--full">
            <label htmlFor="pf-hist">Clinical history (this sample)</label>
            <textarea id="pf-hist" className="input" rows={3} style={{ resize: 'vertical' }}
                      value={history} onChange={(e) => setHistory(e.target.value)} />
          </div>
        </div>

        <div className="modal__actions">
          <button className="btn btn--ghost" disabled={saving} onClick={onClose}>Cancel</button>
          <button className="btn" disabled={saving || !dirty} onClick={() => void save()}>
            {saving ? 'Saving…' : 'Save patient info'}
          </button>
        </div>
      </div>
    </div>
  );
}
